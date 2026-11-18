'use strict';
// v1.8.0 WP-04（审计 C3、C8、V112）：输入法组字守卫统一。
//
// 背景：全仓的「Enter = 提交」链路原先只判 event.isComposing，find-ui 的两条链路（查找框 /
// 替换框）连这个都没有——中文输入法组字时按 Enter 是「上屏候选词」，会被当成「整本替换 /
// 切换章节 / 执行命令 / 保存书籍信息」。旧版 / 第三方输入法在组字时 isComposing 可能为 false、
// 只报 keyCode 229（V112 的防御性加固，不是 V73 当初的判据要求），统一判据一起认。
//
// 本测试钉住三件事：
//   ① isImeComposing 的纯逻辑（isComposing / keyCode 229 / 坏入参）；
//   ② 五个消费者（renderer.js / chapter-directory-ui.js / find-ui / command-palette-ui / bookinfo-ui）
//      都只走共享函数，不再各写一份 `event.isComposing`；
//   ③ index.html 的加载顺序：ime-guard.js 排在所有消费者之前，且只加载一次。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'ime-guard.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const read = (file) => fs.readFileSync(path.join(ROOT, 'renderer', file), 'utf8');
// 只保留代码，去掉块注释与整行注释：注释里会出现 `event.isComposing` 的说明文字。
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const imeGuard = require('../renderer/ime-guard');

test('isImeComposing：isComposing 是标准判据，keyCode 229 是旧版输入法的防御性加固', () => {
  assert.equal(imeGuard.isImeComposing({ isComposing: true }), true);
  assert.equal(imeGuard.isImeComposing({ isComposing: false, keyCode: 229 }), true);
  assert.equal(imeGuard.isImeComposing({ keyCode: 229 }), true, '没有 isComposing 字段也认 229');
  assert.equal(imeGuard.isImeComposing({ keyCode: 13 }), false);
  assert.equal(imeGuard.isImeComposing({ keyCode: '229' }), false, 'keyCode 是数字；字符串不冒充');
  assert.equal(imeGuard.isImeComposing({ isComposing: false }), false);
  assert.equal(imeGuard.isImeComposing({}), false);
  assert.equal(imeGuard.isImeComposing(null), false, '没有 event 时守卫不能自己炸');
  assert.equal(imeGuard.isImeComposing(undefined), false);
  assert.equal(imeGuard.isImeComposing('Enter'), false);
});

test('静态闸门：五个消费者都走共享函数，没有第二份 event.isComposing', () => {
  // WP17 A3 第一刀：章节目录筛选框的 Enter 判断随 setupChapterDirectory 迁到 chapter-directory-ui.js。
  const consumers = {
    'renderer.js': read('renderer.js'),
    'chapter-directory-ui.js': read('chapter-directory-ui.js'),
    'find-ui.js': read('find-ui.js'),
    'command-palette-ui.js': read('command-palette-ui.js'),
    'bookinfo-ui.js': read('bookinfo-ui.js'),
    // WP17 A3 第三刀：书架搜索框的 Enter 判断随 bindShelfEvents 迁到 shelf-view-ui.js。
    'shelf-view-ui.js': read('shelf-view-ui.js')
  };
  for (const [file, src] of Object.entries(consumers)) {
    const code = codeOf(src);
    assert.equal(code.includes('event.isComposing'), false, `${file} 里还有手写的 event.isComposing`);
    assert.match(code, /imeGuard\.isImeComposing\(event\)/, `${file} 没接共享守卫`);
  }
  // renderer.js 的 4 处提交键（目录筛选框已随模块迁走、书架搜索随 A3-B 迁到 shelf-view-ui.js）：
  // 全局 Enter 兜底 / 跳章 / 书目筛选 / Ctrl+K（其中 Ctrl+K 是取反）；两个模块各 1 处。
  const rendererCode = codeOf(consumers['renderer.js']);
  assert.equal(rendererCode.split('imeGuard.isImeComposing(event)').length - 1, 4, 'renderer.js 的 4 处提交键');
  assert.equal(
    codeOf(consumers['shelf-view-ui.js']).split('imeGuard.isImeComposing(event)').length - 1,
    1,
    '书架搜索框的 Enter 仍走共享守卫（A3-B 后）'
  );
  assert.equal(rendererCode.split('!imeGuard.isImeComposing(event)').length - 1, 1, 'Ctrl+K 的取反判据');
  assert.equal(
    codeOf(consumers['chapter-directory-ui.js']).split('imeGuard.isImeComposing(event)').length - 1,
    1,
    '目录筛选框的 Enter 仍走共享守卫'
  );
  // 装配：四个模块的 create 都拿到 imeGuard（缺了会在启动时抛 TypeError）。
  // A3-B 后书架视图是第 5 处；它是同行装配（不是独占一行），所以按两种形态分别钉死，
  // 不用裸 'imeGuard,' 计数（那会把注释 / 别的实参也一起数进去，等于放宽）。
  assert.equal(rendererCode.split('\n    imeGuard,').length - 1, 4, '四处 create 的独占行装配 imeGuard');
  assert.equal(
    rendererCode.split('renderShelfContent, imeGuard,').length - 1,
    1,
    '书架视图 create 装配 imeGuard（A3-B 后第 5 处，同行形态）'
  );
});

test('静态闸门：index.html 在消费者之前加载 ime-guard.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="ime-guard.js"></script>');
  assert.notEqual(at, -1, 'index.html 没加载 ime-guard.js');
  assert.equal(indexSrc.split('ime-guard.js').length - 1, 1, 'ime-guard.js 只许加载一次');
  for (const consumer of ['renderer.js', 'find-ui.js', 'command-palette-ui.js', 'bookinfo-ui.js']) {
    assert.ok(at < indexSrc.indexOf(`<script src="${consumer}"></script>`), `ime-guard.js 必须排在 ${consumer} 之前`);
  }
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWImeGuard，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/ime-guard.js' });
  assert.equal(typeof win.CWImeGuard, 'object');
  assert.deepEqual(Object.keys(win.CWImeGuard).sort(), ['isImeComposing']);
  assert.equal(typeof win.CWImeGuard.isImeComposing({ keyCode: 229 }), 'boolean');
  assert.equal(win.CWCommandPaletteUi, undefined);
});