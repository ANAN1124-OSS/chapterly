/* 跨模块公共小工具（v0.9 B-3，代码精简 B3）——纯逻辑，不碰 DOM、不读盘、不联网、不 require electron。
 *
 * 为什么单独一个文件：这几个小工具原来在多个模块里各抄一份，改一处得记得改所有份：
 *   - pad2：6 个 core 模块各一份（history / logs / fragments / snapshot / stats / template），
 *     storage.js / repair.js / stats.js 里还有 3 处同样逻辑的内联 `const pad = (n) => …`；
 *   - clampInt：3 个 core 模块（proofread / sensitive / tts）+ 2 个渲染层纯逻辑模块（editor-logic / find-logic）；
 *   - sleep：原子写重试（atomic.js）与截图驱动（scripts/screenshot-driver.js）各一份。
 *   - formatCount（2026-11-04 拍板 #1）：全应用字数显示统一千分位，界面层与主进程共用这一份；
 *   - stripBom / normalizeText（B6）：atomic / txt / capture 各有一份 stripBom，
 *     glossary / proofread / sensitive / txt / tts 各有一份「去 BOM + CRLF → LF」；
 *   - toHalfWidth / HAN_RANGES（A2，v1.8.0 WP-31）：全角→半角换算原在 jump / proofread /
 *     command-registry / settings-ia 各写一份（0xfee0），汉字范围串在 format / proofread 各写一份；
 *   - formatByteSize / MAX_TEXT_BYTES（A3，v1.8.0 WP-31）：storage 的 formatByteSize 与 importer
 *     的 formatImportSize 逐字同构，128 MB 单文件整读上限也各写一份。
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

  // A2（v1.8.0 WP-31）：全角→半角换算的两个码位区间。
  //   · 全角 ASCII：U+FF01–U+FF5E 与 ASCII 的 !–~ 一一对应（码位差 0xFEE0）；U+3000 是全角空格；
  //   · 全角数字：U+FF10–U+FF19 → 0–9（跳章输入 / 校对「全角数字」建议只需要这一类）。
  const FULL_WIDTH_ASCII_RE = /[\uFF01-\uFF5E\u3000]/g;
  const FULL_WIDTH_DIGIT_RE = /[\uFF10-\uFF19]/g;

  // A2（v1.8.0 WP-31）：汉字范围串，格式整理（core/format.js）与校对（core/proofread.js）共用这一份。
  // 覆盖 CJK 扩展 B–G 与兼容补充（U+20000 起，如「𠮷」）：这些字在 JS 里是代理对，
  // 拼进正则时必须带 u 标志按码点匹配；逐字扫描的地方也要按码点取整字。
  const HAN_RANGES =
    '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff' +
    '\\u{20000}-\\u{2a6df}\\u{2a700}-\\u{2b73f}\\u{2b740}-\\u{2b81f}' +
    '\\u{2b820}-\\u{2ceaf}\\u{2ceb0}-\\u{2ebef}\\u{2f800}-\\u{2fa1f}\\u{30000}-\\u{3134f}';

  // A3（v1.8.0 WP-31）：单文本文件「整份读进内存」的上限，章节正文读取（core/storage.js 的
  // MAX_CHAPTER_READ_BYTES）与单本 txt 导入（core/importer.js 的 MAX_IMPORT_BYTES）是同一条口径。
  // 1000 万字中文小说约 30 MB，128 MB 有三倍以上余量。常量只在这里写一次。
  const MAX_TEXT_BYTES = 128 * 1024 * 1024;
  const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'];

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

  // V221-SEARCH-01（2026-11-26 复核）：查找结果的上下文按 UTF-16 下标截取，截断点还可能落在
  // 组合字符序列中间（`e` + U+0301 这类）：片段以孤立的组合符开头 / 结尾时，界面会显示成「◌́」
  // 或让前一个字变形。这里把下标吸附到字素边界：side='start' 退回所在字素的起点（含基字符），
  // side='end' 吞掉紧随的组合符。只退回 / 吞掉相邻的组合符，不整篇切字素（长章里结果很多）。
  const COMBINING_MARK_RE = /\p{M}/u;
  function snapGrapheme(text, index, side = 'start') {
    const source = String(text == null ? '' : text);
    const at = Math.max(0, Math.min(source.length, Math.floor(Number(index) || 0)));
    if (side === 'end') {
      let end = at;
      while (end < source.length && COMBINING_MARK_RE.test(source[end])) end += 1;
      return end;
    }
    let start = at;
    while (start > 0 && COMBINING_MARK_RE.test(source[start])) start -= 1;
    return start;
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

  // 体量文案（A3，v1.8.0 WP-31）：core/storage.js 的 formatByteSize 与 core/importer.js 的
  // formatImportSize 原来逐字同构，现在只剩这一份。1 位小数直到 10 以上；负数 / NaN / Infinity
  // 当 0（调用方传进来的都是文件尺寸，没有负数语义）。
  function formatByteSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '0 B';
    let value = n;
    let unit = 0;
    while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
      value /= 1024;
      unit += 1;
    }
    if (unit === 0) return `${Math.round(value)} B`;
    const shown = value < 10 ? value.toFixed(1) : String(Math.round(value));
    return `${shown} ${BYTE_UNITS[unit]}`;
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

  // 全角 → 半角（A2，v1.8.0 WP-31）：默认把全角 ASCII（！…～，U+FF01–U+FF5E）与全角空格
  // （U+3000）换算成半角；{ digitsOnly: true } 只换全角数字 ０-９（跳章输入 / 校对「全角数字」建议
  // 只需要数字）。这两类以外的字符（中文标点 、。、「」、CJK 汉字、代理对）原样保留。
  // 原来 jump / proofread / command-registry / settings-ia 四处各写一份 0xfee0 减法，口径相同。
  function toHalfWidth(value, options) {
    const source = String(value == null ? '' : value);
    const pattern = options && options.digitsOnly ? FULL_WIDTH_DIGIT_RE : FULL_WIDTH_ASCII_RE;
    return source.replace(pattern, (ch) =>
      ch === '\u3000' ? ' ' : String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    );
  }

  // X7 / V205（v1.8.0 WP-25）：全仓「大小写归一」的唯一实现（匹配 / 检索用，不用于展示）。
  // 少数语言字符小写化后会**变长**：典型是 'İ'（U+0130）→ 'i' + U+0307 两个码元。拿小写结果当
  // 扫描用的干草堆时，命中位置与片段位置会整体后移（core/find.js / core/search-index.js 的 V76 防御）。
  // 这里沿用那两处既有口径：整串小写化长度一变，就整串退回原文 —— 这一次「不区分大小写」退化为
  // 区分大小写，宁可少一次命中，也不许把命中指到别的字上（X7 的已知语义限制）。
  // 返回值带 folded 标记：false = 这一次发生了退化。需要「两边都折叠才折叠」的调用方
  // （core/find.js 的查找 / 替换）按它判断，避免出现「干草堆折叠、针不折叠」的混合匹配。
  function caseFoldForMatch(value) {
    const source = String(value == null ? '' : value);
    const lower = source.toLowerCase();
    return lower.length === source.length
      ? { text: lower, folded: true }
      : { text: source, folded: false };
  }

  // 只要归一后的字符串时用这个：core/search-index.js 的建图与查询、core/bookinfo.js 的作者 / 分组 /
  // 标签匹配、renderer/ command-registry.js 的命令面板、shelf-filter-ui.js 的书架搜索都用它。
  function normalizeForMatch(value) {
    return caseFoldForMatch(value).text;
  }

  // 行首位置表：starts[i] = 第 i 行（0 基）在文本里的起点，永远以 0 开头。
  // 只认 \n（调用方传进来的都是 normalizeText 归一过的文本）；原来 proofread / sensitive 各一份。
  // B1（v1.8.0 WP-27）：改用原生 indexOf 逐个换行符推进（不再逐 UTF-16 单元遍历）——
  // 10 万字 / 3 千行实测 0.6ms → 0.07ms；它现在在「每次按键算光标段落」的热路径上。
  function lineStartsOf(text) {
    const starts = [0];
    let at = text.indexOf('\n');
    while (at >= 0) {
      starts.push(at + 1);
      at = text.indexOf('\n', at + 1);
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
  // 审计修复 #55（M8）：某个任务失败后，其余 worker 不再领**新**任务（在飞的那几个照常结束）；
  // 以前 Promise.all 立刻 reject，但其它 worker 还会把剩下的条目全部跑完，写场景里等于失败之后
  // 继续写盘。现在只保证「不再开始新的」，已经在跑的任务没有取消语义（Promise 无法外部中断）。
  async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let cursor = 0;
    let failed = false;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        if (failed) return;
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        try {
          results[index] = await mapper(items[index], index);
        } catch (err) {
          failed = true;
          throw err;
        }
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

  // 正文搜索结果的「书 + 章」组键（RSHE-C-03 / P22-4 展开状态）：分隔符是 U+0000，
  // 保证「书路径 + 章文件名」两段拼接不会和别的组合撞车。
  // 为什么放在这里：书架正文搜索模块（写 content.expanded[key]）与书架筛选模块（读同一个 key
  // 渲染 / 写进 button.dataset.group）各抄过一份逐字相同的 7 行；两份一旦漂移（分隔符 / 字段 /
  // 归一方式），「展开本章全部」会静默失效且无测试报警。这是「两个以上模块都要用的纯计算」，
  // 符合本文件的收纳原则；行为与两份旧实现逐字一致（非法行返回 ''）。
  function contentGroupKey(row) {
    if (!row || typeof row !== 'object') return '';
    const bookPath = typeof row.bookPath === 'string' ? row.bookPath : '';
    const chapterFile = typeof row.chapterFile === 'string' ? row.chapterFile : '';
    if (!bookPath || !chapterFile) return '';
    return bookPath + '\u0000' + chapterFile;
  }

  // 新书的书 id（复验残留 2026-11-22 / CIO-A-04 同型收编）：毫秒时间戳 + 6 位随机后缀，形状仍以
  // b_ 开头。为什么放这里：storage.createBook、repair 重建、importer 导入三条路径都要造新 id，
  // 此前修复只改了导入一处，另两处仍是纯时间戳（跨窗口同毫秒撞 id，config 的 bookDisplay /
  // 查找书签键都按 id 记）；「两个以上模块都要用的纯计算」按本文件收纳原则收一份，输出与
  // importer 的既有修法逐字同形（旧 id 不受影响；回归见 tests/common.test.js 与 importer.test.js）。
  function newBookId() {
    return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // C3（一轮·低）：正整数参数的统一夹紧。``capture.js`` / ``capture-queue.js`` /
  // ``clipboard-watch.js`` 各写过一份逐字相同的实现（非有限值或 ≤0 退回 fallback，再 round 到 ≥1）；
  // 三份一旦漂移，同一个坏配置在「队列上限 / 预览长度 / 监听阈值」上会得到不同结果。收一份到这里。
  function positiveInt(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.round(n));
  }

  return {
    pad2,
    clampInt,
    positiveInt,
    truncateSafe,
    snapGrapheme,
    sleep,
    formatCount,
    formatByteSize,
    stripBom,
    normalizeText,
    toHalfWidth,
    HAN_RANGES,
    MAX_TEXT_BYTES,
    caseFoldForMatch,
    normalizeForMatch,
    lineStartsOf,
    positionOf,
    mapLimit,
    nowIso,
    parseDayKey,
    isValidDayKey,
    dayKeyOf,
    createKeyedWriteQueue,
    createWriteQueue,
    contentGroupKey,
    newBookId
  };
});
