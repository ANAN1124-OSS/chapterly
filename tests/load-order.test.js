'use strict';
// V71（1.7.2 D5）：renderer/index.html 的全量加载顺序闸门。
//
// 为什么要有：渲染层是 60 个 <script> 手工排序的加载链，模块之间靠 `window.CWxxx` 串起来。
// 加一个模块忘了插 <script>、或把依赖挪到消费者后面，Electron 里表现是「某个弹层点不开 / 一片
// 按钮没反应」，而所有单测都是直接 require 模块、根本走不到这条链，所以以前没有任何闸门。
//
// 做法（按 index.html 里 <script src> 的**文件顺序**在 node:vm 里依次执行）：
//   · 一个共享的 vm 沙箱，给最小 window / document 桩；**不启动 Electron**、不读真实书库；
//   · 任何脚本抛错 = 它的依赖没有先加载（或模块自己坏了），直接红；
//   · 每个 UMD 模块在自己的脚本跑完后必须真的挂出源码里写的 window.CWxxx；
//   · 所有脚本里出现过的 window.CWxxx 引用，加载链跑完必须都有定义（漏插 <script> 会红）。
// 例外只有 renderer/test-hooks.js：它不在 index.html 里，由 renderer.js 在 ?test=1 时动态加载。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'renderer', 'index.html');

const noop = () => {};

// 和浏览器一致的最小样式表对象：给个属性就记下来，读没有的返回空串（不返回 undefined，免得拼字符串变 'undefined'）
function styleStub() {
  const own = {};
  return new Proxy(own, {
    get(target, key) {
      if (key === 'then' || typeof key === 'symbol') return undefined;
      if (!(key in target)) target[key] = '';
      return target[key];
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    }
  });
}

// 元素桩：只提供「加载期」会被碰到的属性 / 方法。故意做成薄对象而不是全动态代理——
// 属性拼错时能早红（例如 `el.adEventListener` 会 TypeError），比静默通过有用。
function elementStub(tagName = 'div') {
  return {
    tagName: String(tagName).toUpperCase(),
    nodeName: String(tagName).toUpperCase(),
    nodeType: 1,
    id: '',
    className: '',
    title: '',
    textContent: '',
    innerText: '',
    innerHTML: '',
    value: '',
    placeholder: '',
    checked: false,
    hidden: false,
    disabled: false,
    readOnly: false,
    selectionStart: 0,
    selectionEnd: 0,
    style: styleStub(),
    dataset: {},
    classList: {
      add: noop,
      remove: noop,
      toggle: noop,
      replace: noop,
      contains: () => false,
      item: () => null,
      length: 0
    },
    children: [],
    childNodes: [],
    parentNode: null,
    parentElement: null,
    firstChild: null,
    lastChild: null,
    nextSibling: null,
    previousSibling: null,
    firstElementChild: null,
    lastElementChild: null,
    nextElementSibling: null,
    previousElementSibling: null,
    offsetWidth: 0,
    offsetHeight: 0,
    clientWidth: 0,
    clientHeight: 0,
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    appendChild: (node) => node,
    insertBefore: (node) => node,
    removeChild: (node) => node,
    replaceChild: (node) => node,
    remove: noop,
    cloneNode: () => elementStub(tagName),
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    setAttribute: noop,
    getAttribute: () => null,
    hasAttribute: () => false,
    removeAttribute: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    closest: () => null,
    matches: () => false,
    contains: () => false,
    focus: noop,
    blur: noop,
    click: noop,
    select: noop,
    setSelectionRange: noop,
    scrollIntoView: noop,
    scrollTo: noop,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 })
  };
}

// 主进程白名单 IPC 的桩：任何方法都返回一个立刻 resolve 的 Promise（加载期只会取引用，不会真调用）
function apiStub() {
  const target = {};
  return new Proxy(target, {
    get(own, key) {
      if (key === 'then' || key === 'catch' || key === 'finally' || typeof key === 'symbol') return undefined;
      if (!(key in own)) own[key] = () => Promise.resolve(undefined);
      return own[key];
    }
  });
}

function documentStub() {
  return {
    readyState: 'loading',
    hidden: false,
    visibilityState: 'visible',
    title: '',
    cookie: '',
    documentElement: elementStub('html'),
    head: elementStub('head'),
    body: elementStub('body'),
    activeElement: elementStub(),
    getElementById: () => elementStub(),
    querySelector: () => elementStub(),
    querySelectorAll: () => [],
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    createElement: (tagName) => elementStub(tagName),
    createElementNS: (namespace, tagName) => elementStub(tagName),
    createTextNode: () => elementStub('#text'),
    createDocumentFragment: () => elementStub('#fragment'),
    createRange: () => ({
      setStart: noop,
      setEnd: noop,
      collapse: noop,
      selectNodeContents: noop,
      detach: noop,
      toString: () => '',
      getClientRects: () => [],
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
    }),
    addEventListener: noop,
    removeEventListener: noop,
    execCommand: () => false,
    getSelection: () => ({
      rangeCount: 0,
      removeAllRanges: noop,
      addRange: noop,
      empty: noop,
      toString: () => '',
      getRangeAt: () => ({ setStart: noop, setEnd: noop, collapse: noop, getBoundingClientRect: () => ({ top: 0, left: 0 }) })
    }),
    fonts: { ready: Promise.resolve(), addEventListener: noop, check: () => true },
    styleSheets: []
  };
}

// 一个最小浏览器环境：window === 沙箱全局（和浏览器一致），document / api 只够加载期用。
function createSandbox() {
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Promise,
    Date,
    Math,
    JSON,
    Intl,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    structuredClone,
    performance,
    crypto: require('node:crypto').webcrypto,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    matchMedia: () => ({ matches: false, media: '', addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    getComputedStyle: () => ({ getPropertyValue: () => '', fontSize: '16px', lineHeight: '24px' }),
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    postMessage: noop,
    document: documentStub(),
    navigator: { userAgent: 'chapterly-load-order', platform: 'Win32' },
    location: { href: 'file:///renderer/index.html', search: '', hash: '', pathname: '/renderer/index.html' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    api: apiStub()
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  const context = vm.createContext(sandbox);
  return { sandbox, context };
}

// index.html 里 <script src> 的文件顺序（静态读 HTML，不启动 Electron）
function indexScripts() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
}

// 一个脚本导出的 window.CWxxx 名（UMD 的浏览器分支：root.CWxxx = factory()）
function exportedNamesOf(code) {
  return [...code.matchAll(/(?:root|window|globalThis)\.(CW[A-Za-z0-9_$]+)\s*=/g)].map((match) => match[1]);
}

// 依次执行；返回抛错的脚本、每个脚本的导出名、以及所有被引用过的 window.CWxxx
function runScripts(entries) {
  const { sandbox, context } = createSandbox();
  const failures = [];
  const exportedAt = new Map();
  const referenced = new Set();
  for (const entry of entries) {
    for (const match of entry.code.matchAll(/\bwindow\.(CW[A-Za-z0-9_$]+)/g)) referenced.add(match[1]);
    try {
      new vm.Script(entry.code, { filename: entry.file }).runInContext(context, { timeout: 20000 });
    } catch (err) {
      failures.push({
        file: entry.file,
        message: err && err.message ? err.message : String(err),
        hint: (err && err.stack ? String(err.stack) : '').split('\n').slice(1, 3).join(' | ')
      });
      continue;
    }
    exportedAt.set(entry.file, exportedNamesOf(entry.code));
  }
  return { sandbox, failures, exportedAt, referenced };
}

let cache = null;
function loadIndexChain() {
  if (cache) return cache;
  const entries = indexScripts().map((src) => {
    const file = path.posix.normalize(path.posix.join('renderer', src));
    return { src, file, code: fs.readFileSync(path.join(ROOT, file), 'utf8') };
  });
  cache = { entries, ...runScripts(entries) };
  return cache;
}

// 动态加载、不在 index.html 里的模块：只有 ?test=1 时由 renderer.js 注入 test-hooks.js。
const DYNAMIC_GLOBALS = new Set(['CWTestHooks']);

test('index.html 的 <script src> 都存在，且 renderer.js 排在最后（V71）', () => {
  const chain = loadIndexChain();
  assert.ok(chain.entries.length >= 50, `加载链看起来被截断了（只有 ${chain.entries.length} 个 <script src>）`);
  for (const entry of chain.entries) {
    assert.ok(fs.existsSync(path.join(ROOT, entry.file)), `index.html 引用了不存在的脚本：${entry.file}`);
  }
  // renderer.js 在加载期就把各模块的 window.CWxxx 取成局部常量，必须最后加载
  assert.equal(chain.entries[chain.entries.length - 1].file, 'renderer/renderer.js', 'renderer.js 必须是最后一个 <script>');
});

test('按 index.html 顺序在 node:vm 里全量加载：零抛错（V71）', () => {
  const chain = loadIndexChain();
  assert.deepEqual(
    chain.failures.map((item) => `${item.file} :: ${item.message}`),
    [],
    '有脚本在加载期抛错 = 它依赖的模块没有先加载（或模块自己坏了）'
  );
  assert.ok(chain.exportedAt.size >= 50, `能跑完的 UMD 模块太少（只有 ${chain.exportedAt.size} 个），闸门等于没开`);
});

test('每个 UMD 模块都挂出了自己的 window.CWxxx（V71）', () => {
  const chain = loadIndexChain();
  const missing = [];
  for (const [file, names] of chain.exportedAt) {
    for (const name of names) {
      if (!(name in chain.sandbox)) missing.push(`${file} 没有挂出 window.${name}`);
    }
  }
  assert.ok(chain.exportedAt.size > 0, '一个 UMD 模块都没认出来，闸门等于没开');
  assert.deepEqual(missing, [], '模块跑了却没挂全局 = 依赖它的模块会拿到 undefined');
});

test('脚本里引用的 window.CWxxx 都在 index.html 的加载链里（V71）', () => {
  const chain = loadIndexChain();
  const missing = [...chain.referenced].filter((name) => !(name in chain.sandbox) && !DYNAMIC_GLOBALS.has(name));
  assert.deepEqual(missing.sort(), [], '这些全局被引用却没有定义 = index.html 漏了对应的 <script>');
});

test('闸门能抓到「没有先加载」：后加载的模块读未定义全局会红（V71）', () => {
  const result = runScripts([
    { file: 'renderer/00-consumer.js', code: 'window.CWNotLoadedYet.boot();' },
    { file: 'renderer/01-provider.js', code: 'window.CWNotLoadedYet = { boot() {} };' }
  ]);
  assert.equal(result.failures.length, 1, '读未定义的 window.CWxxx 必须被记为加载失败，闸门不许静默通过');
  assert.match(result.failures[0].message, /CWNotLoadedYet|Cannot read propert|is not a function/);
  // 反证：同一对脚本按正确顺序跑就绿——闸门红的是顺序，不是脚本内容
  const ordered = runScripts([
    { file: 'renderer/00-provider.js', code: 'window.CWNotLoadedYet = { boot() {} };' },
    { file: 'renderer/01-consumer.js', code: 'window.CWNotLoadedYet.boot();' }
  ]);
  assert.deepEqual(ordered.failures, []);
});