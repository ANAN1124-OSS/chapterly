// 审计 P1 · C3：两处「编辑区原生插入」与两处「还原前未保存拦截」的收编闸门。
//
// 收编前：
//   · renderer.js 里 applyChapterTemplate（章节模板整段替换）与 runReplaceOne（替换这一处）
//     各写了一遍 `document.execCommand('insertText', ...)` + try/catch；
//   · renderer.js 的整本替换备份还原与 renderer/history-ui.js 的历史备份还原各写了一遍
//     「取消 / 放弃修改 / 保存后继续，保存失败就停」的三选一（标题 / 两个按钮文案 / 返回值形状全一样）。
// 收编后只剩一份实现，这两个文件里不许再长出第二份。
//
// T7（三审·低）：这份闸门原来钉的是「精确代码形状 + 精确调用点个数」（15 个调用点 / 三处兜底的正则片段 /
// 三态映射的整句 return）。新增一个合法入口就假红，等价重构（换行、改名、调整分支写法）也假红。
// 现在改成**机器清单**，只钉两件事：
//   · 每个收口原语在合并域里 `function 名字(` 只出现一次（实现只有一处）；
//   · 原生等价实现（execCommand / askUnsaved / saveCurrent 三选一）不许在消费方出现。
// 兜底与三态的行为由行为用例覆盖，每条断言旁注明是哪一个。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractFunctionSource } = require('./source-probe');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RENDERER_SRC = read('renderer/renderer.js');
// WP17 A3 第四刀：章节模板 / 分卷 / 批量动作整段搬到 chapter-ops-ui.js；
// 收口闸门按「两个文件合并计数」保持语义（实现仍只有一份，只是住址变了）。
const CHAPTER_OPS_SRC = read('renderer/chapter-ops-ui.js');
const SAVE_CHAIN_SRC = read('renderer/save-chain-ui.js');
const HISTORY_SRC = read('renderer/history-ui.js');

const countOf = (source, needle) => source.split(needle).length - 1;

// 合并域 = 编排器 + 两个已搬出去的同域模块（编辑域 / 保存链）。
const DOMAIN_SOURCES = [
  ['renderer/renderer.js', RENDERER_SRC],
  ['renderer/chapter-ops-ui.js', CHAPTER_OPS_SRC],
  ['renderer/save-chain-ui.js', SAVE_CHAIN_SRC]
];
const DOMAIN_TEXT = DOMAIN_SOURCES.map(([, source]) => source).join('\n');

// 机器清单：某个函数在合并域里的定义次数（`function x(` 与 `async function x(` 都算）。
function definitionCount(name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g');
  return DOMAIN_SOURCES.reduce((sum, [, source]) => sum + (source.match(re) || []).length, 0);
}

test('C2：章节 / 分卷写盘后统一 applyMetaAndRelocate（机器清单：实现只有一处）', () => {
  assert.equal(definitionCount('applyMetaAndRelocate'), 1, '收口函数只该定义一次（散落 9 份的旧实现不许回来）');
  // 调用点必须多于定义点（各入口确实走它）；不钉具体个数——新增一个入口不该假红。
  assert.ok(countOf(DOMAIN_TEXT, 'applyMetaAndRelocate(') > 1, '至少有一个调用点走收口函数');
  // 兜底语义（删卷找不到当前章回第 1 章 / 删非当前章回原下标 + 重载、失败保持脏）由行为用例覆盖：
  // tests/wp17-a3-chapter-ops.test.js › REDT-C-04 / 旧M2 / 删卷兜底。
});

test('C3：编辑区原生插入只留一份 replaceEditorTextNative（机器清单）', () => {
  assert.equal(countOf(RENDERER_SRC, 'document.execCommand('), 1, 'renderer.js 里只该有 replaceEditorTextNative 里那一处 execCommand');
  assert.equal(definitionCount('replaceEditorTextNative'), 1, 'replaceEditorTextNative 只该定义一次');
  assert.ok(countOf(RENDERER_SRC, 'replaceEditorTextNative(') > 1, '本域至少两个调用点（章节模板 / 替换这一处）');
  assert.ok(countOf(CHAPTER_OPS_SRC, 'replaceEditorTextNative(') >= 1, '编辑域模块也要走同一份实现');
  // 兜底行为（execCommand 不可用 / 内容没进去时手动塞回、绝不丢内容）由行为用例覆盖：
  // tests/wp17-a3-chapter-ops.test.js › A3-Cβ、tests/find-ui.test.js › replaceEditorText、
  // tests/fragments-ui.test.js › V402、tests/tidy-card-ui.test.js › R1。
});

test('C3：「还原前」未保存拦截只留一份，历史备份还原与整本替换备份还原共用（机器清单）', () => {
  assert.equal(definitionCount('confirmRestoreWithUnsaved'), 1, '拦截只该定义一次');
  assert.ok(countOf(RENDERER_SRC, 'confirmRestoreWithUnsaved(') > 1, '整本替换备份还原要走共享拦截');
  // 历史弹层不再自己拼三选一：连 askUnsaved / saveCurrent 都不该再出现在这个模块里。
  assert.equal(/askUnsaved/.test(HISTORY_SRC), false, 'history-ui.js 不该再依赖 askUnsaved（三选一在共享拦截里）');
  assert.equal(/saveCurrent/.test(HISTORY_SRC), false, 'history-ui.js 不该再依赖 saveCurrent（保存动作在共享拦截里）');
  // 「同一本书才拦」的行为由 tests/history-ui.test.js ›「看的是别的书的备份 → 不拿当前书的脏标记去拦」覆盖。
});

test('C3：拦截的三态形状（ok / canceled / saved）由共享原语产出，适配器与调用方原样映射', () => {
  // 五-H2/H3（BP-02 / BP-03 / L-F1）：三选一的语义（保存回执后复核 dirty、丢弃时清脏）收进
  // save-chain-ui 的 saveForTransition；形状（{ok:false,canceled:true} / {ok:false,saved} / {ok:true}）
  // 由 tests/wp17-a3-save-chain.test.js › 五-H2/H3 的行为用例钉住，这里只钉「只有一份原语」。
  assert.equal(
    (SAVE_CHAIN_SRC.match(/(?:async\s+)?function\s+saveForTransition\s*\(/g) || []).length,
    1,
    '统一原语只在保存链模块里实现一次'
  );
  // 编排器里保留同名薄包装（renderer.js 的转发惯例）：只许一行转发，不许长出第二份实现。
  for (const line of RENDERER_SRC.match(/async\s+function\s+saveForTransition[^\n]*/g) || []) {
    assert.match(line, /saveChainUi\.saveForTransition\(/, '编排器的同名函数只能是一行转发');
  }
  // 适配器只做三态映射：读原语的 canceled / saved 两个判别字段（不再自己 askUnsaved / saveCurrent）。
  assert.match(RENDERER_SRC, /saveForTransition\(/, '整本替换还原要走共享拦截');
  const adapter = extractFunctionSource(RENDERER_SRC, 'confirmRestoreWithUnsaved');
  assert.match(adapter, /guard\.canceled/, '取消必须原样映射');
  assert.match(adapter, /guard\.saved/, '保存失败必须把 saveCurrent 的结果原样带回去');
  // 两处调用方都按三态还原（取消 → canceled；保存失败 → 原样上抛）：只看符号是否都读到了。
  for (const source of [RENDERER_SRC, HISTORY_SRC]) {
    assert.match(source, /guard\.canceled/, '调用方要按 canceled 还原旧返回值');
    assert.match(source, /guard\.saved/, '调用方要按 saved 还原旧返回值');
  }
});

test('C3 / 五-H3：还原型撤销闭包执行前核编辑区脏状态（不许拿备份盖掉未保存的字）', () => {
  const guardLine = /if \(state\.dirty\) throw new Error\('编辑区有未保存的修改，请先保存后再撤销'\);/;
  // M1 第 11 轮第三刀：整本整理那处随实现搬进 renderer/format-book-ui.js；两处合并计数（总数断言不变）。
  const FORMAT_BOOK_SRC = require('node:fs').readFileSync(path.join(__dirname, '..', 'renderer', 'format-book-ui.js'), 'utf8');
  assert.equal(
    ((RENDERER_SRC + FORMAT_BOOK_SRC).match(/if \(state\.dirty\) throw new Error\('编辑区有未保存的修改，请先保存后再撤销'\);/g) || []).length,
    2,
    '渲染层两处还原型撤销（整本替换还原 / 整本整理）都要先核脏'
  );
  assert.match(HISTORY_SRC, guardLine, '历史还原的撤销闭包同样要先核脏');
});
