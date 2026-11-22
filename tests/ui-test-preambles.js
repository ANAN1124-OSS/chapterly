'use strict';

// 9 个渲染层模块单测（*-ui.test.js）共用的测试前导。抽四样：
//
// 1) 全局替身的保存与恢复：模块在 Node 里跑，有的要临时放一个假 document，
//    有的要打「没有 document / window」的边界（create() 只建表不碰 DOM）。
//    真身一律在模块加载时存下，test.after / finally 再放回去；
//    「原本是 undefined 就 delete」的语义保持不变。
// 2) readFileSync 静态闸门前导：renderer.js / index.html / 本域模块三份源码，
//    外加给正则闸门用的归一化代码视图——仓库工作区行尾是 CRLF，先归一成 LF；
//    注释里提 document / window 是在解释契约、不算越界，所以剥掉注释再看。
// 3) 共享最小假 DOM 基线 makeEl / makeIdEl（WP16 / 审计 A5；TEST-D-02 补注入点）：只实现各 UI 用例
//    真正用到的 DOM 行为（classList / 事件（含 options）/ 子节点 / 属性 / textContent / innerHTML 清空 /
//    焦点与选区）；本体等价的用例直接复用，带变体的用例传 spec（见 makeEl 注释）只写差异段，
//    不再各自抄一份；哪些文件已迁移登记在 FAKE_DOM_MIGRATED（tests/wp16-regression.test.js 会核对）。
//    textContent 统一成真 DOM 口径：有子节点读整棵子树，写入时清空子节点；只有确需旧变体的文件
//    显式传 text:'own'（当前无文件使用），不允许再各写一套。
// 4) FAKE_DOM_MIGRATED：已经改用共享基线的用例文件（相对 tests/ 的文件名）。
//
// makeHost 仍由各用例文件自己维护：host 是各模块自己的契约（api / state / $ / option 钩子），
// 不同域之间不是重复，而是有意变体。
// 本文件不叫 *.test.js：`node --test "tests/**/*.test.js"` 不会把它当用例跑。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 模块加载期替身：test.after 时按「原本没有就 delete，否则写回真身」恢复。
// 用法：restoreGlobalsAfter(test, ['document', 'window']);
function restoreGlobalsAfter(test, names) {
  const saved = new Map();
  for (const name of names) saved.set(name, globalThis[name]);
  test.after(() => {
    for (const name of names) {
      const value = saved.get(name);
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
}

// 用例体内临时藏起全局：同步执行 fn，无论抛不抛都在 finally 里放回真身。
// 用法：withoutGlobals(['document', 'window'], () => { ... });
function withoutGlobals(names, fn) {
  const saved = new Map();
  for (const name of names) {
    saved.set(name, globalThis[name]);
    delete globalThis[name];
  }
  try {
    return fn();
  } finally {
    for (const name of names) {
      const value = saved.get(name);
      if (value !== undefined) globalThis[name] = value;
    }
  }
}

// 剥掉块注释与整行 // 注释，供「模块里不许出现某实现」这类纯度闸门用。
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// 静态闸门前导：一次读齐三份源；rendererCode 行尾归一化，moduleCode 再剥注释。
function loadSourceGate(moduleFile) {
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', moduleFile), 'utf8');
  return {
    rendererSrc,
    rendererCode: rendererSrc.replace(/\r\n/g, '\n'),
    indexSrc,
    moduleSrc,
    moduleCode: stripComments(moduleSrc)
  };
}

// T8（三审·低）：UMD 的 Node 分支那几行只在这里写一次。
// 以前 22+ 个 UI 测试文件各抄一份「module.exports = factory(require('../core/assert-host').assertHost);」
// 再各自断言一次 —— 口径调整要同步改二十几处、漏改即假红。集中闸门（require / 浏览器全局名 /
// 工厂签名三件事）只在 tests/assert-host.test.js 里做；各模块自己的用途只有一个：
// 把 Node 分支那几行剥掉，剩下的算「运行时代码」，再去扫「运行时代码不许 require 任何东西」。
const ASSERT_HOST_NODE_BRANCH = "module.exports = factory(require('../core/assert-host').assertHost);";
// shelf-search-ui 的 Node 分支多取一个 core/common.js（组键算法唯一一份，RSHE-C-03）。
const ASSERT_HOST_COMMON_NODE_BRANCH =
  "module.exports = factory(require('../core/common'), require('../core/assert-host').assertHost);";

function stripAssertHostBranch(source) {
  return String(source)
    .split(ASSERT_HOST_NODE_BRANCH)
    .join('')
    .split(ASSERT_HOST_COMMON_NODE_BRANCH)
    .join('');
}

// 共享最小假 DOM 基线：一个元素 + 它真正会被用到的行为。
// 只给「所有 UI 模块共同需要」的部分；领域里额外的怪癖（options 追加、getBoundingClientRect 固定值、
// createElement(tag) 的 tagName 语义、Map 版 _attrs）留在各用例文件里，别在基线里猜。
//
// 审计 TEST-D-02：基线本体固定，差异靠 spec 注入，带变体的大文件不再整段抄一份核心。
// spec（第三个参数，可省略）：
//   text     'tree'（默认，真 DOM 口径：有子节点读整棵子树）| 'own'（只读自身字符串，有子节点返回 ''）
//   attrs    'object'（默认，el._attrs = {}）| 'map'（el._attrs = new Map()）
//   style    元素 style 桩：传 { setProperty, removeProperty } 形状的对象或「每元素造一个」的工厂函数
//   query    (selector, el) => 命中数组：领域选择器（类选择器 / [data-*] / 直接子块）由各文件自己实现
//   extra    (el) => 追加属性（getBoundingClientRect、scrollHeight 等域内自有行为）
//   fragment 'move'（默认，真 DOM：碎片子节点搬进父节点、碎片清空）| 'copy'（旧基线口径，保留碎片）
function makeEl(tag = 'div', id = '', spec = {}) {
  const textMode = spec.text === 'own' ? 'own' : 'tree';
  const fragmentMode = spec.fragment === 'copy' ? 'copy' : 'move';
  const attrs = spec.attrs === 'map' ? new Map() : {};
  const hasAttr = (name) => (spec.attrs === 'map' ? attrs.has(name) : Object.prototype.hasOwnProperty.call(attrs, name));
  const readAttr = (name) => (spec.attrs === 'map' ? attrs.get(name) : attrs[name]);
  const classes = new Set();
  const listeners = [];
  let ownText = '';
  const el = {
    tagName: tag,
    id,
    title: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    type: '',
    tabIndex: -1,
    dataset: {},
    style: typeof spec.style === 'function' ? spec.style() : spec.style || {},
    children: [],
    parentNode: null,
    scrollTop: 0,
    scrollLeft: 0,
    selectionStart: 0,
    selectionEnd: 0,
    _classes: classes,
    _listeners: listeners,
    _attrs: attrs,
    _focus: 0,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, on) {
        const next = on === undefined ? !classes.has(name) : Boolean(on);
        if (next) classes.add(name);
        else classes.delete(name);
      }
    },
    append(...nodes) {
      nodes.forEach((node) => el.appendChild(node));
    },
    appendChild(child) {
      // DocumentFragment：真 DOM 把碎片里的节点搬进父节点、碎片本身清空。
      if (child && (child._isFragment || child.isFragment)) {
        child.children.slice().forEach((node) => el.appendChild(node));
        if (fragmentMode === 'move') child.children.length = 0;
        return child;
      }
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    insertBefore(node, before) {
      const at = before ? el.children.indexOf(before) : -1;
      node.parentNode = el;
      if (at < 0) el.children.push(node);
      else el.children.splice(at, 0, node);
      return node;
    },
    removeChild(child) {
      const at = el.children.indexOf(child);
      if (at >= 0) el.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    contains(node) {
      return el.children.includes(node);
    },
    addEventListener(type, fn, options) {
      // options 原样存下：passive 这类真 DOM 约束（滚动监听不许阻断）要靠它断言。
      listeners.push({ type, fn, options });
    },
    fire(type, event) {
      return el._fire(type, event || {});
    },
    _fire(type, event) {
      let result;
      for (const listener of listeners) if (listener.type === type) result = listener.fn(event);
      return result;
    },
    setAttribute(name, value) {
      const text = String(value);
      if (spec.attrs === 'map') attrs.set(name, text);
      else attrs[name] = text;
    },
    getAttribute(name) {
      return hasAttr(name) ? readAttr(name) : null;
    },
    focus() {
      el._focus += 1;
    },
    select() {
      el._selected = true;
    },
    setSelectionRange(start, end) {
      el.selectionStart = start;
      el.selectionEnd = end;
    }
  };
  if (typeof spec.extra === 'function') Object.assign(el, spec.extra(el));
  else if (spec.extra) Object.assign(el, spec.extra);
  if (typeof spec.query === 'function') {
    el.querySelectorAll = (selector) => spec.query(selector, el);
    el.querySelector = (selector) => el.querySelectorAll(selector)[0] || null;
  }
  Object.defineProperty(el, 'className', {
    get() {
      return [...classes].join(' ');
    },
    set(value) {
      classes.clear();
      String(value || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((name) => classes.add(name));
    }
  });
  Object.defineProperty(el, 'textContent', {
    get() {
      if (textMode === 'own') return el.children.length ? '' : ownText;
      // 真 DOM 口径：有子节点读整棵子树的文本，没有子节点读自己写入的字符串。
      if (el.children.length) {
        return el.children.map((child) => (child && child.textContent != null ? child.textContent : '')).join('');
      }
      return ownText;
    },
    set(value) {
      // 与浏览器一致：写 textContent 会把子节点清掉，只留这段文本。
      ownText = String(value == null ? '' : value);
      el.children.length = 0;
    }
  });
  // 代码里靠 `list.innerHTML = ''` 清列表；假 DOM 要真的清（含文本），否则第二次渲染会数错行。
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return '';
    },
    set() {
      el.children.length = 0;
      ownText = '';
    }
  });
  Object.defineProperty(el, 'childElementCount', {
    get() {
      return el.children.length;
    }
  });
  Object.defineProperty(el, 'firstChild', {
    get() {
      return el.children[0] || null;
    }
  });
  return el;
}

// id-only 的历史用例（makeEl(id)）直接换到这里：tagName 固定 div，不再各自维护。
function makeIdEl(id, spec = {}) {
  return makeEl('div', id, spec);
}

// 已经迁到共享基线的用例（WP16 迁移名单）。边界变体不进这里。
const FAKE_DOM_MIGRATED = [
  'statusbar-ui.test.js',
  'save-status-ui.test.js',
  'write-timer-ui.test.js',
  'undo-action.test.js',
  'stats-ui.test.js',
  'shelf-ui.test.js',
  'import-ui.test.js',
  // TEST-D-02：五个带变体的大文件改为「基线本体 + 本域 spec」，不再整段抄核心。
  'settings-ui.test.js',
  'bookinfo-ui.test.js',
  'find-ui.test.js',
  'reading-ui.test.js',
  'history-ui.test.js'
];

module.exports = {
  makeEl,
  makeIdEl,
  FAKE_DOM_MIGRATED,
  loadSourceGate,
  ASSERT_HOST_NODE_BRANCH,
  ASSERT_HOST_COMMON_NODE_BRANCH,
  stripAssertHostBranch,
  restoreGlobalsAfter,
  withoutGlobals
};
