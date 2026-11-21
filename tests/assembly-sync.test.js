'use strict';
// 装配闸门（scripts/assembly-sync.js）的静态扫描口径。
// TOOL-A07（审计）：块外扫描必须先把 HTML 注释剥掉 —— 注释里写 `<script src=…>` 示例
// 不算「块外手插模块脚本」，否则等价重构（把示例写进注释）会让发版闸门误红。
const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../scripts/assembly-sync');

const MANIFEST = {
  MODULES: [['a.js', 'CWA', 'a']]
};

function htmlWith(outside) {
  return [
    '<!doctype html>',
    '<html><head>',
    outside,
    sync.BEGIN_MARKER,
    ...sync.buildBlock(MANIFEST, '\n').split('\n'),
    sync.END_MARKER,
    '</head></html>',
    ''
  ].join('\n');
}

test('TOOL-A07：块外 HTML 注释里的 <script src> 不算模块脚本（不误红）', () => {
  const commented = htmlWith('<!-- 示例：<script src="legacy.js"></script> 不要这样写 -->');
  const result = sync.checkHtml(commented, MANIFEST);
  assert.equal(result.ok, true, `注释里的示例不算手插脚本：${result.reason || ""}`);
});

test('TOOL-A07：块外真实 <script src> 仍然拦住（闸门没有被放空）', () => {
  const stray = htmlWith('<script src="hand-made.js"></script>');
  const result = sync.checkHtml(stray, MANIFEST);
  assert.equal(result.ok, false);
  assert.match(result.reason, /装配标记块外还有 <script src>/);
});
