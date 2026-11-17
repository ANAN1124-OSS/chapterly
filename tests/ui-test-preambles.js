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
// 3) 共享最小假 DOM 基线 makeEl / makeIdEl（WP16 / 审计 A5）：只实现各 UI 用例真正用到的
//    DOM 行为（classList / 事件分发 / 子节点 / 属性 / innerHTML 清空 / 焦点与选区），
//    本体等价的用例直接复用，不再各自抄一份；真正的边界变体（options appendChild、
//    textContent/innerHTML getter、createElement(tag) 的 tagName 语义、Map _attrs 等）留在各文件里，
//    并在 FAKE_DOM_MIGRATED 登记「已迁移」的名单（tests/wp16-regression.test.js 会核对）。
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

// 共享最小假 DOM 基线：一个元素 + 它真正会被用到的行为。
// 只给「所有 UI 模块共同需要」的部分；领域里额外的怪癖（options 追加、getBoundingClientRect 固定值、
// createElement(tag) 的 tagName 语义、Map 版 _attrs）留在各用例文件里，别在基线里猜。
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const attrs = {};
  const el = {
    tagName: tag,
    id,
    textContent: '',
    title: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    type: '',
    tabIndex: -1,
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
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
      // DocumentFragment：把碎片里的节点搬进来（真实 DOM 的可视结果），碎片本身留在调用方。
      if (child && (child._isFragment || child.isFragment)) {
        child.children.slice().forEach((node) => el.appendChild(node));
        return child;
      }
      child.parentNode = el;
      el.children.push(child);
      return child;
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
    addEventListener(type, fn) {
      listeners.push({ type, fn });
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
      attrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
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
  // 代码里靠 `list.innerHTML = ''` 清列表；假 DOM 要真的清，否则第二次渲染会数错行。
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return '';
    },
    set() {
      el.children.length = 0;
    }
  });
  Object.defineProperty(el, 'childElementCount', {
    get() {
      return el.children.length;
    }
  });
  return el;
}

// id-only 的历史用例（makeEl(id)）直接换到这里：tagName 固定 div，不再各自维护。
function makeIdEl(id) {
  return makeEl('div', id);
}

// 已经迁到共享基线的用例（WP16 迁移名单）。边界变体不进这里。
const FAKE_DOM_MIGRATED = [
  'statusbar-ui.test.js',
  'save-status-ui.test.js',
  'write-timer-ui.test.js',
  'undo-action.test.js',
  'stats-ui.test.js',
  'shelf-ui.test.js',
  'import-ui.test.js'
];

module.exports = {
  makeEl,
  makeIdEl,
  FAKE_DOM_MIGRATED,
  loadSourceGate,
  restoreGlobalsAfter,
  withoutGlobals
};
