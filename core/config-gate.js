// 配置里「指向磁盘」的四项值的来源校验（v0.9 C-2b，C1 安全模型一致性的延伸）——
// 纯逻辑：不 require electron、不读盘、不写盘，可在 node:test 里直接测。
//
// 问题：渲染层没有 fs，所有文件操作都在主进程；但 config:set 能改 booksRoot / 两份词表路径，
// 等于「渲染层让主进程下一刻去读写它点名的目录 / 文件」（书架根目录会被列目录、建书、删书
// 走回收站；词表会被读）。这和其他入口的模型不一致：书路径过 assertBookPath、字体只认对话框
// 选中的路径（v0.8.6 F1/F11）、导入目录只认对话框（v0.9 C-2）。
//
// 规则（三项一样，参照 v0.8.6 的 font:pick → font:read）：
//   · 空值 / 纯空白：允许（等于「清空」，配置清洗自己会回默认值或空串）；
//   · 与原值相同：允许（设置界面每次保存都会原样回传整张表单，包括没改的路径）；
//   · 等于「这个窗口刚在系统对话框里选中的那个」：允许（主进程自己记下来、渲染层伪造不了）；
//   · 其它一律忽略该字段（保留原值），并回一份字段名清单（只带字段名，绝不带路径值）。
//
// 已知边界（写进 README 已知限制，不在本模块处理）：
//   · 判定是「字符串等价」：接在刚才选中目录里的子目录也算不同路径，需要重新选一次；
//   · 最后一项在窗口关闭时清理（main.js 的 closed 事件），不跨窗口、不写盘。
// 路径等价口径与 core/path-utils.js 完全一致（1.7.2 D4/V43）：resolve + 小写 + Windows 下正斜杠
// 归反斜杠。这里不再自留 pathLib / pathKey —— 判「是不是同一个路径」的实现在全仓只有一份。
const { pathKey } = require('./path-utils');
// 五-M28（CI-5）：bookDisplay 的条目数上限与 core/config.js 共用同一个常量（那里是唯一声明处）。
const { BOOK_DISPLAY_MAX } = require('./config');

// 需要来源校验的字段（审计结论本身：以后往 config 里加「路径」字段必须加到这里）
// C1（审计 S1）：补上自定义字体路径。原来它不在白名单里，config:set / book:set-display 原样透传，
// 渲染层被注入后可以让主进程在 font:read 里读任意「扩展名像字体」的文件（再被 base64 送回渲染层）。
const GUARDED_PATH_FIELDS = Object.freeze([
  'booksRoot', // 书架目录：主进程会 mkdir / 列目录 / 建书 / 删书走回收站
  'proofreadWordsPath', // 校对词表：主进程会读这个 txt
  'proofreadWordlists', // 校对词表（多份，1.7.0 F3a）：主进程会逐份读这些 txt
  'sensitiveWordsPath', // 敏感词表：同上
  'editorCustomFontPath' // 自定义字体：主进程会读它并整份 base64 回给渲染层
]);

// 两个路径是不是同一个（Windows 大小写不敏感；末尾分隔符、`/` 与 `\` 混用、相对写法都算同一个）
function samePath(a, b) {
  const left = pathKey(a);
  const right = pathKey(b);
  return Boolean(left) && left === right;
}

// C23（整合版审计）：书架根目录「真的变了」吗——config:set 只在变了的时候才碰书架目录。
// 旧实现每次保存设置都无条件 fs.mkdir(目标根)：改字号 / 主题 / 按书字体这些无关 patch 也会去动书架根，
// 书架在断开的网络盘 / USB 上时，连保存一个无关设置都会失败。
// 比的是装饰（--books-root 覆盖）后的生效根，口径与 samePath 共用全仓唯一的 pathKey：
// 大小写 / 末尾分隔符 / 正反斜杠混用 / `.` 都算同一个目录；两边都为空（没有根）也算没变。
function booksRootChanged(currentRoot, nextRoot) {
  return pathKey(currentRoot) !== pathKey(nextRoot);
}

// 「刚选中」的登记值可能是单个字符串（逐个选）或字符串数组（多选）：统一成数组。
function pickedPaths(value) {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
}

// 多份校对词表（1.7.0 F3a）：数组逐项判来源——与当前条目相同（同下标，或本来就在当前列表里，
// 这样面板移除 / 换序不会被自己的校验挡住），或等于本窗口刚选中的某条路径。
// 伪造条目丢掉；只要丢过条目就回字段名（不放行整段死字段）；一条都不剩时整个字段不生效（保留旧值）。
function filterWordlistPatch(value, currentValue, pickedValue) {
  if (!Array.isArray(value)) return { value: null, rejected: true };
  const current = Array.isArray(currentValue) ? currentValue : [];
  const picked = pickedPaths(pickedValue);
  const out = [];
  let dropped = false;
  for (const item of value) {
    const trimmed = typeof item === 'string' ? item.trim() : '';
    if (!trimmed) {
      dropped = true;
      continue;
    }
    const known = current.some((entry) => samePath(trimmed, entry));
    const justPicked = picked.some((entry) => samePath(trimmed, entry));
    if (known || justPicked) {
      out.push(trimmed);
      continue;
    }
    dropped = true;
  }
  if (dropped && !out.length && value.length) return { value: null, rejected: true };
  return { value: out, rejected: dropped };
}

// 过滤 config:set 的 patch：
//   patch    —— 渲染层传来的一整份改动（可能带非路径字段）
//   options.current —— 当前生效配置（main.js 传 getConfig() 的结果，含 booksRoot 覆盖）
//   options.picked  —— 本窗口「刚在对话框里选中的值」{ 字段: 路径 }（没有就传 null）
// 返回 { patch: 只含放行字段的新 patch, rejected: [字段名] }。
// 非路径字段原样透传；坏类型（数字 / 数组 / 对象）一律当作「来源不明」拒绝（不做类型转换）。
function filterPathPatch(patch, options = {}) {
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const current = options.current && typeof options.current === 'object' ? options.current : {};
  const picked = options.picked && typeof options.picked === 'object' ? options.picked : {};
  const result = {};
  const rejected = [];
  for (const key of Object.keys(source)) {
    if (!GUARDED_PATH_FIELDS.includes(key)) {
      result[key] = source[key];
      continue;
    }
    const value = source[key];
    if (key === 'proofreadWordlists') {
      const verdict = filterWordlistPatch(value, current[key], picked[key]);
      if (verdict.rejected) rejected.push(key); // 来源不明 / 有条目被丢：只回字段名
      if (verdict.value) result[key] = verdict.value;
      continue;
    }
    if (typeof value !== 'string') {
      rejected.push(key);
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      result[key] = ''; // 清空：允许（配置清洗决定最终落什么）
      continue;
    }
    if (samePath(trimmed, current[key]) || samePath(trimmed, picked[key])) {
      result[key] = trimmed;
      continue;
    }
    rejected.push(key); // 来源不明：忽略该字段，保留原值
  }
  return { patch: result, rejected };
}

// 按书显示设置的补丁（book:set-display）：只有「字体路径」这一项指向磁盘，和全局同一个口径。
// 允许的来源：空（清空） / 与该书现有覆盖相同 / 与全局配置相同 / 本窗口刚在字体对话框里选中的那个；
// 其它字段（字号 / 行距 / 纸张…）原样透传，行为和以前完全一样。
// 返回 { patch: 只含放行字段的新 patch, rejected: [字段名] }。
function filterBookDisplayPatch(patch, options = {}) {
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const current = options.current && typeof options.current === 'object' ? options.current : {};
  const global = options.global && typeof options.global === 'object' ? options.global : {};
  const picked = options.picked && typeof options.picked === 'object' ? options.picked : {};
  const result = {};
  const rejected = [];
  for (const key of Object.keys(source)) {
    if (key !== 'editorCustomFontPath') {
      result[key] = source[key];
      continue;
    }
    const value = source[key];
    if (typeof value !== 'string') {
      rejected.push(key);
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      result[key] = ''; // 清空自定义字体：允许（配置清洗自己决定回落到哪个内置字体）
      continue;
    }
    if (samePath(trimmed, current[key]) || samePath(trimmed, global[key]) || samePath(trimmed, picked[key])) {
      result[key] = trimmed;
      continue;
    }
    rejected.push(key); // 来源不明：忽略该字段，保留原值
  }
  return { patch: result, rejected };
}

// E1（审计 E1）：config:set 里的 patch.bookDisplay 是一整张按书显示设置 map，filterPathPatch 会把
// 不认识的顶层键原样透传——其中每本书的 editorCustomFontPath 也会被 font:read 整份 base64 读回渲染层，
// 等于绕过了 font:pick 的来源闸门（book:set-display 那条路已经逐书过滤，只有 config:set 漏了）。
// 这里对 map 逐书套用同一个 filterBookDisplayPatch：放行的字段并回该书原条目（被拒的字体路径保留
// 原值，绝不整条替换掉这本书的其它显示项），返回「只含放行条目」的 map 交给调用方合并。
// 形状不对（不是对象 / 条目不是对象 / 书 id 不合法）整项不生效：patch 回 null，调用方丢弃这个键、
// 保留原配置，不能因为一次坏 patch 把整份 bookDisplay 抹掉。
function filterBookDisplayMapPatch(raw, options = {}) {
  const current = options.current && typeof options.current === 'object' ? options.current : {};
  const currentMap =
    current.bookDisplay && typeof current.bookDisplay === 'object' && !Array.isArray(current.bookDisplay)
      ? current.bookDisplay
      : {};
  const picked = options.picked && typeof options.picked === 'object' ? options.picked : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { patch: null, rejected: ['bookDisplay'] };
  // 五-M28（CI-5）：整份 map 也要有条目数闸 —— 正常 UI 一次只带一本书，一张数十万条的 patch
  // 既不可能是正常设置，也不该让逐条过滤 + 调用方合并 + 配置深拷贝全部白做。
  // 超限整段拒绝（保留原配置），与「形状不对整项不生效」同一口径；上限与 core/config.js 同一份常量。
  if (Object.keys(raw).length > BOOK_DISPLAY_MAX) return { patch: null, rejected: ['bookDisplay'] };
  const entries = [];
  let rejected = false;
  for (const [bookId, entry] of Object.entries(raw)) {
    const key = typeof bookId === 'string' ? bookId.trim() : '';
    if (!key || key.length > 200 || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
      rejected = true;
      continue;
    }
    const existing =
      Object.prototype.hasOwnProperty.call(currentMap, key) &&
      currentMap[key] &&
      typeof currentMap[key] === 'object' &&
      !Array.isArray(currentMap[key])
        ? currentMap[key]
        : {};
    const gated = filterBookDisplayPatch(entry, { current: existing, global: current, picked });
    if (gated.rejected.length) rejected = true;
    entries.push([key, { ...existing, ...gated.patch }]);
  }
  // Object.fromEntries 用的是 CreateDataProperty：书 id 写成 __proto__ 也不会改原型链。
  return { patch: Object.fromEntries(entries), rejected: rejected ? ['bookDisplay'] : [] };
}

// 按窗口记「刚在系统对话框里选中的路径」：windowId -> { 字段: 路径 }。
// 每个窗口每个字段只留最后一次（作者重选就覆盖），窗口关了要 forget（main.js 的 closed 事件）。
function createPickedPathStore() {
  const byWindow = new Map();

  function idOf(windowId) {
    const raw = windowId == null ? '' : String(windowId).trim();
    return raw;
  }

  // 记住一次选择；value 为空等于「清掉这个字段的登记」
  function remember(windowId, field, value) {
    const id = idOf(windowId);
    if (!id || !GUARDED_PATH_FIELDS.includes(field)) return false;
    const entry = byWindow.get(id) || {};
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) {
      delete entry[field];
      if (Object.keys(entry).length) byWindow.set(id, entry);
      else byWindow.delete(id);
      return true;
    }
    entry[field] = trimmed;
    byWindow.set(id, entry);
    return true;
  }

  // 取某个窗口当前登记的一份快照（filterPathPatch 的 picked 参数用）
  function snapshot(windowId) {
    const id = idOf(windowId);
    if (!id) return {};
    const entry = byWindow.get(id);
    return entry ? { ...entry } : {};
  }

  function recall(windowId, field) {
    return snapshot(windowId)[field] || '';
  }

  // 窗口关掉时清理（不清理也不会出错，只是内存里多几条；清理更干净）
  function forget(windowId) {
    const id = idOf(windowId);
    if (!id) return false;
    return byWindow.delete(id);
  }

  function size() {
    return byWindow.size;
  }

  return { remember, snapshot, recall, forget, size };
}

module.exports = {
  GUARDED_PATH_FIELDS,
  samePath,
  booksRootChanged,
  filterPathPatch,
  filterBookDisplayPatch,
  filterBookDisplayMapPatch,
  createPickedPathStore
};
