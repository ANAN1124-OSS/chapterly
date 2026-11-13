/* 跨模块公共小工具（v0.9 B-3，代码精简 B3）——纯逻辑，不碰 DOM、不读盘、不联网、不 require electron。
 *
 * 为什么单独一个文件：这几个小工具原来在多个模块里各抄一份，改一处得记得改所有份：
 *   - pad2：6 个 core 模块各一份（history / logs / fragments / snapshot / stats / template），
 *     storage.js / repair.js / stats.js 里还有 3 处同样逻辑的内联 `const pad = (n) => …`；
 *   - clampInt：3 个 core 模块（proofread / sensitive / tts）+ 2 个渲染层纯逻辑模块（editor-logic / find-logic）；
 *   - sleep：原子写重试（atomic.js）与截图驱动（scripts/screenshot-driver.js）各一份。
 *   - formatCount（2026-11-04 拍板 #1）：全应用字数显示统一千分位，界面层与主进程共用这一份；
 *   - stripBom / normalizeText（B6）：atomic / txt / capture 各有一份 stripBom，
 *     glossary / proofread / sensitive / txt / tts 各有一份「去 BOM + CRLF → LF」。
 * 收编的原则是**行为零变化**：每份的字面实现本来就一模一样（见 tests/common.test.js 的回归断言），
 * 这里只是把它挪到一个地方，调用点换成 require / 全局对象。
 *
 * 边界（红线）：
 *   - 只做字符串补位、数字夹紧、等一会儿这类最基础的事，**不含任何业务规则**；
 *   - 不读盘 / 不写盘 / 不 require fs、path、electron，也不碰 process / window（除 UMD 挂载那一行）；
 *   - 主进程（core/*、main.js）、渲染层（index.html 里 <script src="../core/common.js">）与单测三处共用，
 *     所以写成 UMD：Node 里 require 得到对象，浏览器里挂到 window.CWCommon。
 *
 * 加载顺序（浏览器）：index.html 里 core/common.js 必须排在 core/template.js、editor-logic.js、
 * find-logic.js 之前；那些模块拿不到 window.CWCommon 会直接抛错，而不是悄悄退回一份旧副本。
 * 新增工具请先问自己：是不是「两个以上模块都要用的纯计算」？只有一个调用方就别放进来。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWCommon = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 日期键的正则：只认两位月 / 两位日（'2026-2-1' 这类手改的写法不算合法键）
  const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  // 两位补零：7 → '07'、12 → '12'。只做字符串补位，不取整、不取模（调用方给什么就写什么）。
  // 注意和 String.prototype.padStart 一致：超过两位的数字原样返回（100 → '100'）。
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // 整数夹紧：null / undefined 是「没传值」，直接回落 fallback（V82：旧实现 Math.floor(Number(null))
  // === 0，会被当成数字 0 夹到下限）；其余先 Math.floor(Number(value))，非有限数（含 '' / NaN /
  // Infinity）退回 fallback，最后夹到 range（含两端）。range 的语义就是调用方传的 [下限, 上限]，
  // 这里不做校验；fallback 也不保证落在 range 内——那是调用方的事。
  function clampInt(value, fallback, range) {
    if (value == null) return fallback;
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, range[0]), range[1]);
  }

  // 按 UTF-16 长度截断，但不切开代理对（emoji 等保持完整）：截断点落在高位代理上时回退一个
  // 单元，避免留下孤立代理（编辑区 / 导出会显示成乱码）。core/bookinfo.js 的字段限长与
  // core/template.js 的整段模板截断共用这一份（1.7.2 D4/V81），别再各写一份。
  function truncateSafe(text, maxLength) {
    if (text.length <= maxLength) return text;
    let end = Math.max(0, maxLength);
    if (end > 0) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    return text.slice(0, end);
  }

  // 等一会儿（毫秒）：原子写失败重试的间隔、截图驱动等界面稳定用。永远 resolve，不 reject。
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 千分位（拍板 #1：全应用字数显示统一）：1234567 → '1,234,567'。
  // 不用 toLocaleString：分隔符随 Node / Chromium / locale 变（有的是窄空格或不换行空格），
  // 界面文案与单测期望值必须稳定，所以这里逐位分组。
  // 负数 / NaN / Infinity / 空值一律当 0（调用方传进来的都是计数，没有负数语义）。
  function formatCount(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0) return '0';
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // 去掉开头那个 BOM（U+FEFF）：导入 / 读取外来 txt、解析书目时几乎每个调用方都要先洗一遍，
  // 原来 atomic / txt / capture 各抄一份（B6 收编）。只吃第 0 位那一个字符——正文中间的 U+FEFF
  // 是作者自己的字，不动；null / undefined 按 '' 兜底，其余交给 String()（数字也给字符串）。
  function stripBom(text) {
    const s = String(text == null ? '' : text);
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  }

  // 正文归一：去 BOM + 把 CRLF / CR 统一成 LF。编辑区、查找、校对、统计、朗读都只认 \n，
  // 原来 glossary / proofread / sensitive / txt / tts 五个模块各写一份（B6 收编）。
  function normalizeText(text) {
    return stripBom(text).replace(/\r\n?/g, '\n');
  }

  // 行首位置表：starts[i] = 第 i 行（0 基）在文本里的起点，永远以 0 开头。
  // 只认 \n（调用方传进来的都是 normalizeText 归一过的文本）；原来 proofread / sensitive 各一份。
  function lineStartsOf(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
  }

  // 字符位置 → 1 基的行 / 列（二分查找行首，长章节也不会慢）。index 超出末尾时落在最后一行末尾之后，
  // 与原来两处调用方的行为一致（它们都只拿命中位置来算行号列号）。
  function positionOf(starts, index) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: index - starts[lo] + 1 };
  }

  // 限并发 map：最多 limit 个任务同时在跑，结果按原顺序返回；mapper 收到 (item, index)。
  // 任一任务抛错就整体拒绝（与 Array#map 的直觉一致）；items 为空 → 空数组。
  // 原来 storage（导入时批量读章）与 search-index（建索引）各一份。
  async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  // ISO 时间戳（写盘用的 createdAt / updatedAt / builtAt）：clock 可传一个返回 Date 的函数
  // （单测要固定时钟），不传就是 new Date()；函数返回的不是合法 Date 时退回现在——与 storage 原来
  // 那份「无参」和 search-index 原来那份「带 clock 兜底」的两种行为都兼容。
  function nowIso(clock) {
    const date = typeof clock === 'function' ? clock() : new Date();
    const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
    return d.toISOString();
  }

  // 日期键的严格解析：格式必须 YYYY-MM-DD（月日都两位）、年份 1970–9999，而且必须是真实存在的
  // 本地日期（2026-02-30 / 2025-13-01 都不算）；不是字符串就返回 null。原来 logs 与 stats 各一份
  // （一份只回答真假、一份给出 { year, month, day }），实现逐字相同（B6 收编）。
  function parseDayKey(key) {
    if (typeof key !== 'string') return null;
    const match = DAY_KEY_RE.exec(key.trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1970 || year > 9999) return null;
    // 用本地中午 12 点构造：避开夏令时切换那一小时，也不受时区边界影响
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return { year, month, day };
  }

  function isValidDayKey(key) {
    return parseDayKey(key) !== null;
  }

  // 本机时区的日期键：dayKeyOf(date) → '2026-11-04'；separator 传 '' → '20261104'（快照目录名）。
  // 只做「按本地日历格式化」这一件事，**不做兜底**：三个调用方对 null / 坏值 / 已是日期键的字符串
  // 的语义本来就不同（日志退回现在、快照返回 null、统计原样透传），把这些开关塞进这里只会更难读，
  // 所以兜底留在各自模块，共用的是格式化（含 pad2）这一步。
  function dayKeyOf(date, separator = '-') {
    return `${date.getFullYear()}${separator}${pad2(date.getMonth() + 1)}${separator}${pad2(date.getDate())}`;
  }

  // 串行写队列（两个入口共用这一份实现，A4 审计 #11 统一）：
  //   · createKeyedWriteQueue()：按 key 分链——同一个 key 的 enqueue 严格串行，不同 key 互不排队。
  //     书架路径锁（core/storage.js 的 withBookLock）用它；
  //   · createWriteQueue()：全局单链，就是 key 固定为 '' 的 keyed 队列。原来 config / fragments /
  //     logs / stats 四个 store 各抄一份一模一样的 7 行（B6 收编）。
  // 语义（两个入口一致）：
  //   · enqueue 返回这个 task 自己的 Promise——成功 / 失败都如实转给调用方；
  //   · 链尾巴永远保持 resolved（失败已被吞掉），一个任务失败不会堵死后面的任务；
  //   · idle() 等「当前排队的所有任务」跑完（之后再排进来的不在这次等待里）；idle(key) 只等一条链；
  //   · 链 settle 后条目自动回收（Map 不再只增不删）；clearIdle() 早一步回收空闲条目，
  //     但正在跑 / 正在排队的条目**绝不拆**——拆了后来者会和它并发，锁就白加了。
  function createKeyedWriteQueue() {
    const tails = new Map();
    function enqueue(key, task) {
      const k = key == null ? '' : String(key);
      let entry = tails.get(k);
      if (!entry) {
        entry = { tail: Promise.resolve(), pending: 0 };
        tails.set(k, entry);
      }
      const previous = entry.tail;
      entry.pending += 1;
      const run = previous.then(task, task);
      const settled = run.then(() => undefined, () => undefined);
      entry.tail = settled;
      settled.then(() => {
        entry.pending -= 1;
        // 只有「自己仍是这条 key 的尾巴」且没人接在后面时才回收；后面已经接了任务就留给它 settle 时处理。
        if (entry.pending === 0 && tails.get(k) === entry) tails.delete(k);
      });
      return run;
    }
    function idle(key) {
      if (key === undefined) {
        return Promise.all(Array.from(tails.values(), (entry) => entry.tail)).then(() => undefined);
      }
      const entry = tails.get(key == null ? '' : String(key));
      return entry ? entry.tail : Promise.resolve();
    }
    // 主动回收空闲条目（删书 / 换书架根目录后调用）；只删 pending === 0 的，返回删掉几条。
    // 不传 key = 所有空闲条目；传 key = 那一条。
    function clearIdle(key) {
      if (key !== undefined) {
        const k = key == null ? '' : String(key);
        const entry = tails.get(k);
        if (entry && entry.pending === 0) {
          tails.delete(k);
          return true;
        }
        return false;
      }
      let removed = 0;
      tails.forEach((entry, k) => {
        if (entry.pending === 0) {
          tails.delete(k);
          removed += 1;
        }
      });
      return removed;
    }
    function pendingCount() {
      return tails.size;
    }
    return { enqueue, idle, clearIdle, pendingCount };
  }

  function createWriteQueue() {
    const queue = createKeyedWriteQueue();
    return {
      enqueue: (task) => queue.enqueue('', task),
      idle: () => queue.idle('')
    };
  }

  return {
    pad2,
    clampInt,
    truncateSafe,
    sleep,
    formatCount,
    stripBom,
    normalizeText,
    lineStartsOf,
    positionOf,
    mapLimit,
    nowIso,
    parseDayKey,
    isValidDayKey,
    dayKeyOf,
    createKeyedWriteQueue,
    createWriteQueue
  };
});
