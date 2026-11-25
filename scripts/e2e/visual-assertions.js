'use strict';
// E2E 视觉断言的**静态清单**（2.1.0 T-26）。
//
// 背景（三次审查 T-26，高优先级）：`scripts/e2e/harness.js` 的 `checkVisual` 在 `E2E_SKIP_VISUAL=1`
// 时恒返回 true，两条 CI 工作流都带这个开关。跳过本身是合理的——hosted runner 没有交互式桌面会话，
// Chromium 对不可见窗口节流合成 / 动画 / 布局，动效 / 主题 / 几何测量类断言在那里必然偏（2026-11-23
// 实测 30 项）。但「哪些算视觉断言」此前只有一句口头约束，没有清单、没有数量、没有 CI 校验，
// 于是保存失败重试（含磁盘比对）、快照清空 toast、阅读字号档位等功能断言也被标成 checkVisual，
// 在 PR / weekly E2E 上永不验证、恒绿——CI 的 E2E 门禁被实质弱化。
//
// 这里把「文件 + 断言名」收成唯一事实源：
//   · `scripts/wiring-check.js` 的 `e2e-visual-assertions` 契约逐项核对：
//     每个 `checkVisual(...)` 调用都在清单里、清单每项在代码里存在、两边数量一致；
//   · 新增 / 删除视觉断言时必须同步改本清单，漏改静态门禁直接红（不再靠自律）；
//   · 功能断言一律用 `check(...)`：它们必须留在 CI 的 E2E 里阻塞。判断标准是
//     「关掉 COMPOSITING / 缩到不可见窗口也应当成立」——只看存储、DOM 存在性、文案语义、
//     键盘 / IPC 路由的断言不属于视觉；看计算样式像素、几何位置、过渡时长 / 属性、动画帧的才算。
//
// 断言名取 `checkVisual(...)` 的第一个参数（字符串 / 模板字符串）源码，空白归一后比对。
// 模板字符串里的 `${...}` 原样保留：它对应的是同一处调用在 `scan(label)` 里按 label 展开的多条
// 运行时断言，静态清单按调用点记一条（这正是「文件 + 断言名级」的口径）。
const GROUPS_DIR = 'scripts/e2e/groups';

// 清单按「文件 → 源码顺序」排列，便于和组文件对照；改断言名时两边一起改。
const MANIFEST = [
  ['03-save-book.js', '状态栏（1.3.0 T7）：中段显示「第 N 章 · 本章 X 字」，章节位置与标题栏同一口径'],
  ['03-save-book.js', '状态栏（1.3.0 T7）：保存失败时朱红显示原因并出现「重试」'],
  ['26-display-options.js', '夜间主题：正文底色变深、字色不变'],
  ['26-display-options.js', '左右边距可调（24px）'],
  ['44-stats-goal.js', '阅读模式：切「特大 + 紧凑」只改显示（25px / 1.7 倍行距）'],
  ['44-stats-goal.js', '阅读模式：Ctrl+滚轮上滚后正文渲染为 25px（特大档）'],
  ['44-stats-goal.js', '阅读模式：Ctrl+= 放大后正文渲染为 25px（特大档）'],
  ['44-stats-goal.js', '阅读模式：最小档正文渲染为 17px'],
  ['49-tts.js', '朗读（拍板 #6）：toast 抬起量 = 朗读条实际高度 + 52px（写进 --tts-toast-lift，不再是写死的 184px）'],
  ['50-editor-widgets.js', '编辑器小件：标记层与编辑区同宽同高、字体/行高一致（标记位置对得上）'],
  ['50-editor-widgets.js', '编辑器小件：滚动时标记层跟随，超长段落黄线跟着正文走'],
  ['50-editor-widgets.js', '当前段落高亮：夜间主题有一套单独的高亮色 / 光标色，不会刺眼'],
  ['50-editor-widgets.js', '当前段落高亮：牛皮纸主题也有自己的高亮色（6 套主题分别调过色）'],
  ['50-editor-widgets.js', '查找增强：当前命中的底色比其它命中更重'],
  ['50-editor-widgets.js', '查找增强：夜间主题有单独的命中高亮色（暗底上不刺眼，只改显示）'],
  ['50-editor-widgets.js', '界面优化：窗口尺寸来回变完，顶栏回到原布局（按钮顺序 / 分组没乱）'],
  ['50-editor-widgets.js', '代码精简：书卡右键菜单在右下角也收进可视区，菜单项一个不少'],
  ['65-marks-lazy-spans.js', '标记层惰性渲染：影子层与编辑区同宽同高、同字体同行高（换行一致）'],
  ['67-contrast-a11y.js', '对比度：主按钮「保存」启用态的文字在 6 套主题下都过 4.5:1（夜间改深色字）'],
  ['69-motion.js', '${label}：全界面过渡 / 动画时长只有两档（${QUICK} / ${OVERLAY}）'],
  ['69-motion.js', '${label}：令牌就是这两档（--motion-quick / --motion-overlay）'],
  ['69-motion.js', '${label}：没有任何元素还在做位移类过渡'],
  ['69-motion.js', '动效-书架：确实有元素带动效（不是把动效全删了）'],
  ['69-motion.js', '动效-书架：书卡只过渡底色与边框色（v1.0 不上浮、不加阴影，不是把动效删了）'],
  ['69-motion.js', '动效-书架：书卡时长 = --motion-quick'],
  ['69-motion.js', '动效-书架：「⋯」按钮 = 淡入 + 悬停底色，都走 quick'],
  ['69-motion.js', '动效-书架：按钮只过渡底色 / 边线 / 文字色三个属性，统一走 quick'],
  ['69-motion.js', '动效-书架：进度条宽度动画从 .2s 收到 quick'],
  ['69-motion.js', '动效-书架：顶栏下拉菜单从 .1s 提到 quick'],
  ['69-motion.js', '动效-书架：专注模式悬浮条淡出走 overlay（面状进出那一档）'],
  ['69-motion.js', '动效-悬停：真实鼠标命中 .book-card 的 :hover'],
  ['69-motion.js', '动效-悬停：悬停不再上浮 1px（transform 保持 none）'],
  ['69-motion.js', '动效-悬停：悬停反馈还在（边框变成 --line-strong、底色变成 --folio-raised）'],
  ['69-motion.js', '动效-悬停：悬停不加阴影（v1.0 用底色 + 边线区分，不用投影）'],
  ['69-motion.js', '动效-悬停：过渡属性里没有 transform'],
  ['69-motion.js', '动效-写作页：章节条目 = 底色 + 当前章内描边，都走 quick'],
  ['69-motion.js', '动效-写作页：分隔条的悬停反馈（::after）走 quick'],
  ['69-motion.js', '动效-toast：入场动画还是 toast-in'],
  ['69-motion.js', '动效-toast：入场时长 = --motion-overlay'],
  ['69-motion.js', '动效-toast：3.6 秒后真的进入淡出（.leaving；透明度下降或 opacity 过渡已挂上或节点已移除）'],
  ['69-motion.js', '动效-toast：淡出过渡 = --motion-overlay（以前 JS 里写死 .25s）'],
  ['69-motion.js', '动效-toast：淡出只过渡 opacity'],
  ['69-motion.js', '动效-toast：淡出真有一条 opacity 过渡在跑（160ms）'],
  ['69-motion.js', '动效-toast：淡出结束后元素被移除（不留透明节点）'],
];

// JS 注释剥离（字符串 / 模板字符串感知）：清单比对只看真实代码，注释里提到 checkVisual 不算。
// 与 scripts/wiring-check.js 的同名实现同口径；这里独立一份是为了让本模块可被单测直接驱动，
// 不依赖 wiring-check 的内部函数导出。
function stripJsComments(source) {
  let out = '';
  let quote = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next || '';
        i += 1;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      if (i < source.length) out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      let sawNewline = false;
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') sawNewline = true;
        i += 1;
      }
      i += 1;
      if (sawNewline) out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

// GATE-09：引用扫描要在「代码」上做 —— 字符串 / 模板字面量里出现的 checkVisual（断言名、
// 说明文字）不是引用。这里把字符串内容替换成空格（长度与换行不变，引号本身保留），让引用
// 扫描拿到的下标仍与原源码一一对应；两种「字符串键」引用（t['checkVisual']、{ 'checkVisual': vc }）
// 会被掩码盖住，由 extractVisualAssertions 单独在原文里点名。
function maskStringLiterals(code) {
  let out = '';
  let quote = '';
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (quote) {
      if (ch === '\\') {
        out += '  ';
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = '';
        out += ch;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

// 断言名比对口径：换行 / 连续空白归一成一个空格，去首尾空白。
function normalizeName(raw) {
  return String(raw).replace(/\s+/g, ' ').trim();
}

// 从 `checkVisual(` 的 `(` 之后读第一个字符串字面量：'…' / "…" / `…`（模板保留 ${…} 原文）。
// 读不出（第一个参数不是字面量）返回 null —— 这类调用无法进静态清单，由调用方判违规。
function readFirstStringLiteral(code, openIndex) {
  let i = openIndex + 1;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  const quote = code[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let value = '';
  i += 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      const next = code[i + 1];
      if (next === '\n') {
        i += 2;
        continue;
      }
      // 只还原常见的转义；断言名里极少有控制字符，其余按原字符保留（报价 / 反斜杠原样）。
      if (next === quote || next === '\\') {
        value += next;
        i += 2;
        continue;
      }
      if (next === 'n') {
        value += '\n';
        i += 2;
        continue;
      }
      if (next === 't') {
        value += '\t';
        i += 2;
        continue;
      }
      value += next || '';
      i += 2;
      continue;
    }
    if (ch === quote) return value;
    value += ch;
    i += 1;
  }
  return null;
}

// 一份源码里所有 checkVisual 调用点的断言名（按出现顺序；重复名保留，交给比对环节报重）。
// 口径：调用必须**单独起一行**（行内除缩进外只有 checkVisual），第一个参数是字符串 / 模板字面量。
// 行内混写（`if (x) checkVisual(...)`）或解析不出的写法返回 null —— 比对环节会按「无法进静态清单」
// 报红，而不是静默漏掉（宁可要求写法固定，也不让门禁出现「覆盖不到但照样绿」的缝）。
function extractVisualAssertions(source) {
  const code = stripJsComments(source);
  const found = [];
  const re = /\bcheckVisual\s*\(/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    const lineStart = code.lastIndexOf('\n', match.index) + 1;
    if (code.slice(lineStart, match.index).trim() !== '') {
      found.push(null);
      continue;
    }
    const openIndex = match.index + match[0].length - 1;
    const literal = readFirstStringLiteral(code, openIndex);
    found.push(literal === null ? null : normalizeName(literal));
  }
  // GATE-02 / GATE-09：checkVisual 一旦被取出引用（赋值别名 `const v = checkVisual`、属性取值
  // `t.checkVisual`、计算属性 `t['checkVisual']`、带引号解构键 `{ 'checkVisual': v }`、`.bind`…），
  // 上面的调用点扫描就再也追不到它 —— 静态清单会静默少掉这些断言（改了断言名 / 删了调用，
  // 门禁照样绿）。除「直接调用」与「不改名的解构简写」（`const { …, checkVisual, … } = t`，
  // 真实树里 11 处）外，其余每一处引用都按「无法静态识别」报 null，由比对环节点名。
  // 注释已在上面剥掉；字符串值里的同名文字不算引用（掩码后再扫），字符串键引用单独点名。
  const codeOnly = maskStringLiterals(code);
  const refRe = /\bcheckVisual\b/g;
  while ((match = refRe.exec(codeOnly)) !== null) {
    const after = codeOnly.slice(match.index + 'checkVisual'.length);
    if (/^\s*\(/.test(after)) continue; // 直接调用：上面已按调用口径处理（含 t.checkVisual( → 已判 null）
    const before = codeOnly.slice(0, match.index);
    if (/[{,]\s*$/.test(before) && /^\s*[,}]/.test(after)) continue; // { checkVisual } / { a, checkVisual }
    found.push(null);
  }
  // 字符串键的两种引用形态（掩码会把键名盖住，单独在原文里找）：`t['checkVisual']` /
  // `{ 'checkVisual': vc }`。字符串值（断言名 / 说明）不含「键 + 冒号/右括号」这个形状，不误报。
  if (/\[\s*(['\"])checkVisual\1\s*\]/.test(code) || /(['\"])checkVisual\1\s*:/.test(code)) found.push(null);
  return found;
}

function keyOf(file, name) {
  return `${file}\u0000${name}`;
}

// sources: [{ file, text }]（file 是 `scripts/e2e/groups/` 下的文件名）。返回 problems（字符串数组）：
//   · 代码里有、清单里没有（未登记）；
//   · 清单里有、代码里没有（清单过期）；
//   · 数量不一致 / 同一文件同一断言名出现两次 / 第一个参数不是字符串字面量。
// 顺序固定（按文件、断言名），便于 CI 输出逐条修。
function compareVisualAssertions(sources, manifest) {
  const list = manifest || MANIFEST;
  const problems = [];
  const manifestMap = new Map();
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
      problems.push(`清单条目格式不正确（应是 [文件, 断言名]）：${JSON.stringify(entry)}`);
      continue;
    }
    const key = keyOf(entry[0], normalizeName(entry[1]));
    if (manifestMap.has(key)) problems.push(`清单里有重复条目：${entry[0]} :: ${entry[1]}`);
    manifestMap.set(key, entry);
  }

  const codeMap = new Map();
  const duplicates = [];
  let callCount = 0;
  for (const source of sources || []) {
    if (!source || typeof source.file !== 'string' || typeof source.text !== 'string') {
      problems.push('sources 每项必须是 { file, text }');
      continue;
    }
    for (const name of extractVisualAssertions(source.text)) {
      callCount += 1;
      if (name === null) {
        problems.push(
          `${source.file}：有 checkVisual 调用无法静态识别（必须单独起一行、第一个参数是字符串 / 模板字面量）`
        );
        continue;
      }
      const key = keyOf(source.file, name);
      if (codeMap.has(key)) duplicates.push(`${source.file} :: ${name}`);
      codeMap.set(key, { file: source.file, name });
    }
  }
  for (const item of duplicates) problems.push(`同一断言名在组内重复（清单只能记一次）：${item}`);

  const missing = [...codeMap.values()]
    .filter((item) => !manifestMap.has(keyOf(item.file, item.name)))
    .sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));
  for (const item of missing) {
    problems.push(`${item.file}：${item.name}（代码里有、清单没登记，请补 scripts/e2e/visual-assertions.js）`);
  }
  const stale = [...manifestMap.values()]
    .filter((item) => !codeMap.has(keyOf(item[0], normalizeName(item[1]))))
    .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  for (const item of stale) {
    problems.push(`${item[0]}：${item[1]}（清单里有、代码里没有，删断言时请同步删清单）`);
  }
  if (callCount !== list.length && (!missing.length && !stale.length)) {
    // 正常情况数量不等一定伴随 missing / stale；这里兜底同一个断言名被清单重复记的异常。
    problems.push(`数量不一致：代码 ${callCount} 处 / 清单 ${list.length} 条`);
  }
  return problems;
}

module.exports = {
  GROUPS_DIR,
  MANIFEST,
  normalizeName,
  stripJsComments,
  readFirstStringLiteral,
  extractVisualAssertions,
  compareVisualAssertions
};
