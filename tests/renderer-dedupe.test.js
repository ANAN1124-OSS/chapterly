// 审计 P1 · C3：两处「编辑区原生插入」与两处「还原前未保存拦截」的收编闸门。
//
// 收编前：
//   · renderer.js 里 applyChapterTemplate（章节模板整段替换）与 runReplaceOne（替换这一处）
//     各写了一遍 `document.execCommand('insertText', ...)` + try/catch；
//   · renderer.js 的整本替换备份还原与 renderer/history-ui.js 的历史备份还原各写了一遍
//     「取消 / 放弃修改 / 保存后继续，保存失败就停」的三选一（标题 / 两个按钮文案 / 返回值形状全一样）。
// 收编后只剩一份实现，这两个文件里不许再长出第二份；兜底行为（execCommand 不可用时丢撤销链但不丢内容）
// 必须原样保留 —— 这是收编最容易顺手改坏的地方，所以连兜底表达式一起钉住。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RENDERER_SRC = read('renderer/renderer.js');
// WP17 A3 第四刀：章节模板 / 分卷 / 批量动作整段搬到 chapter-ops-ui.js；
// 收口闸门按「两个文件合并计数」保持语义（实现仍只有一份，只是住址变了）。
const CHAPTER_OPS_SRC = read('renderer/chapter-ops-ui.js');
const EDITOR_DOMAIN_SRC = RENDERER_SRC + '\n/* ---- chapter-ops-ui.js ---- */\n' + CHAPTER_OPS_SRC;
const HISTORY_SRC = read('renderer/history-ui.js');

const countOf = (source, needle) => source.split(needle).length - 1;

test('C2：章节 / 分卷写盘后统一 applyMetaAndRelocate，不再散落 9 份「换书目 + 重定位」', () => {
  assert.equal(countOf(EDITOR_DOMAIN_SRC, 'function applyMetaAndRelocate('), 1, '收口函数只该定义一次');
  // 1 处定义 + 14 个调用点（新建章 / 新建卷 / 重命名卷 / 移动卷 / 删除卷 / 移到卷 / 重命名章 / 删章 / 改章节信息
  // + 1.4.0 P0-2 的「撤销删除」+ 1.5.0 功能-1 的批量删除（逐章删 + 一次撤销恢复）/ 批量移到卷 / 批量改状态）
  assert.equal(countOf(EDITOR_DOMAIN_SRC, 'applyMetaAndRelocate('), 15, '调用点应为 14 个');
  // 只该剩换书（openBookByPath 要连 bookPath / bookId / 折叠状态一起换，不适用）与 helper 本体两处
  assert.equal(countOf(EDITOR_DOMAIN_SRC, 'state.meta = data.meta;'), 2, '散落的换书目应已收进 helper');
  assert.equal(countOf(EDITOR_DOMAIN_SRC, 'state.chapters = data.meta.chapters;'), 2, '散落的换章节数组应已收进 helper');
  // 兜底语义留在调用点：删卷找不到当前章回第 1 章；删章（非当前章）找不到回「原下标与末章取小」
  assert.ok(/const at = applyMetaAndRelocate\(data, currentId\);\s*\n\s*if \(at < 0\) state\.index = 0;/.test(EDITOR_DOMAIN_SRC), '删卷的兜底不见了');
  // 删非当前章的异常兜底（REDT-C-04）：回原下标 + 重载编辑区，不再只改下标。
  // 旧M2（一轮·中）：清脏改由 loadChapterAt 的**成功分支**做（载章失败必须保持脏 + 提示），
  // 所以这里只钉「回下标 + 重载」，清脏语义由 wp17-a3-chapter-ops.test.js 的 REDT-C-04 / 旧M2
  // 行为用例覆盖（T7：代码形状类锚点逐步让位给行为断言）。
  assert.ok(
    /\} else if \(at < 0\) \{[\s\S]{0,360}state\.index = Math\.min\(index, state\.chapters\.length - 1\);[\s\S]{0,200}await loadChapterAt\(state\.index\);/.test(
      EDITOR_DOMAIN_SRC
    ),
    '删非当前章的异常兜底必须回下标 + 重载编辑区'
  );
  // helper 本身：不传 id 只换书目，传了才重定位（新建 / 重命名 / 改信息这些顺序不变的场景不重定位）
  assert.ok(/function applyMetaAndRelocate\(data, currentId\) \{[\s\S]{0,400}if \(!currentId\) return -1;/.test(EDITOR_DOMAIN_SRC));
});

test('C3：编辑区原生插入只留一份 replaceEditorTextNative，三个调用点跨 renderer / 编辑域模块', () => {
  assert.equal(countOf(RENDERER_SRC, 'document.execCommand('), 1, 'renderer.js 里只该有 replaceEditorTextNative 里那一处 execCommand');
  assert.equal(countOf(EDITOR_DOMAIN_SRC, 'function replaceEditorTextNative('), 1, 'replaceEditorTextNative 只该定义一次');
  // 2026-11-07 剪贴板单列表面板：「正文」按钮插入当前章（契约 §5 host.insertIntoBody）复用这一份实现，
  // 不另写 execCommand；调用点因此从两个变三个（章节模板 / 替换这一处 / 剪贴板正文插入）。
  assert.equal(countOf(RENDERER_SRC, 'replaceEditorTextNative('), 3, 'renderer.js 里仍是定义 + 两个本域调用点');
  assert.equal(countOf(EDITOR_DOMAIN_SRC, 'replaceEditorTextNative('), 4, '定义 + 三个调用点（章节模板 / 替换这一处 / 剪贴板正文插入）');
  // 两个调用点的兜底必须还在：execCommand 不可用 / 内容没进去时手动塞回，绝不丢内容
  assert.ok(
    /if \(!inserted \|\| editorEl\.value !== text\) \{[\s\S]{0,120}editorEl\.value = text;/.test(EDITOR_DOMAIN_SRC),
    '章节模板的整段替换兜底不见了'
  );
  assert.ok(
    /if \(!inserted\) \{[\s\S]{0,200}current\.slice\(0, match\.index\) \+ replacement \+ current\.slice\(match\.index \+ match\.length\)/.test(
      RENDERER_SRC
    ),
    '替换这一处的拼接兜底不见了'
  );
});

test('C3：「还原前」未保存拦截只留一份，历史备份还原与整本替换备份还原共用', () => {
  assert.equal(countOf(RENDERER_SRC, 'async function confirmRestoreWithUnsaved('), 1, '拦截只该定义一次');
  assert.equal(countOf(RENDERER_SRC, 'confirmRestoreWithUnsaved('), 2, '定义 + 整本替换备份还原的调用，共两处');
  assert.ok(
    /const guard = await confirmRestoreWithUnsaved\(\s*'还原会用备份覆盖磁盘上的章节/.test(RENDERER_SRC),
    '整本替换备份还原要走共享拦截，文案保持原样'
  );
  // 历史弹层不再自己拼三选一：连 askUnsaved / saveCurrent 都不该再出现在这个模块里
  assert.equal(/askUnsaved/.test(HISTORY_SRC), false, 'history-ui.js 不该再依赖 askUnsaved（三选一在共享拦截里）');
  assert.equal(/saveCurrent/.test(HISTORY_SRC), false, 'history-ui.js 不该再依赖 saveCurrent（保存动作在共享拦截里）');
  assert.ok(
    /const guard = await confirmRestoreWithUnsaved\(\s*'还原会从磁盘重新载入这本书的正文/.test(HISTORY_SRC),
    '历史备份还原要走共享拦截，文案保持原样'
  );
  // 历史弹层看别的书时不能拿当前书的脏标记去拦：sameBookPath 这道前提必须留在调用点
  assert.ok(
    /if \(state\.dirty && sameBookPath\(state\.bookPath, current\.path\)\) \{\s*\n\s*\/\/[\s\S]{0,160}const guard = await confirmRestoreWithUnsaved\(/.test(
      HISTORY_SRC
    ),
    '历史还原的「同一本书才拦」前提不见了'
  );
});

test('C3：拦截的三态形状（ok / canceled / saved）由共享原语产出，适配器与调用方原样映射', () => {
  // 五-H2/H3（BP-02 / BP-03 / L-F1）：三选一的语义（保存回执后复核 dirty、丢弃时清脏）收进
  // save-chain-ui 的 saveForTransition；编排器 confirmRestoreWithUnsaved 只做三态映射。
  // 形状是调用方 return guard.canceled ? … : guard.saved 的依据，钉在原语实现处，
  // 防止以后又有人把「只看 saved.ok / discard 不清脏」的旧分支抄回来。
  const SAVE_CHAIN_SRC = read('renderer/save-chain-ui.js');
  assert.ok(/async function saveForTransition\(/.test(SAVE_CHAIN_SRC), '统一原语必须在保存链模块里');
  assert.match(SAVE_CHAIN_SRC, /if \(action === 'cancel'\) return \{ ok: false, canceled: true \};/, '取消必须返回 { ok:false, canceled:true }');
  assert.match(SAVE_CHAIN_SRC, /return \{ ok: false, saved \};/, '保存失败必须把 saveCurrent 的结果原样带回去');
  assert.match(SAVE_CHAIN_SRC, /return \{ ok: true[^}]*\};/, '可以继续时返回 ok:true');
  assert.match(SAVE_CHAIN_SRC, /state\.dirty = false;/, '丢弃分支必须显式清脏（下游 reload 的脏闸靠它放行）');
  assert.match(SAVE_CHAIN_SRC, /state\.baseText = editorEl\.value;/, '丢弃分支要同步基线');
  // 适配器：只按原语的三态映射，不再自己 askUnsaved / saveCurrent
  assert.match(RENDERER_SRC, /const guard = await saveForTransition\(\{/, '整本替换还原要走共享拦截');
  assert.ok(/if \(guard\.ok\) return \{ ok: true \};/.test(RENDERER_SRC), '可以继续时放行');
  assert.ok(/if \(guard\.canceled\) return \{ ok: false, canceled: true \};/.test(RENDERER_SRC), '取消原样映射');
  assert.ok(/return \{ ok: false, saved: guard\.saved \};/.test(RENDERER_SRC), '保存失败原样上抛');
  // 两处调用方都按三态还原（取消 → canceled；保存失败 → 原样上抛）
  for (const source of [RENDERER_SRC, HISTORY_SRC]) {
    assert.ok(
      /if \(!guard\.ok\) return guard\.canceled \? \{ ok: false, canceled: true \} : guard\.saved;/.test(source),
      '调用方必须按三态还原旧返回值'
    );
  }
});

test('C3 / 五-H3：还原型撤销闭包执行前核编辑区脏状态（不许拿备份盖掉未保存的字）', () => {
  const guardLine = /if \(state\.dirty\) throw new Error\('编辑区有未保存的修改，请先保存后再撤销'\);/;
  assert.equal(
    (RENDERER_SRC.match(/if \(state\.dirty\) throw new Error\('编辑区有未保存的修改，请先保存后再撤销'\);/g) || []).length,
    2,
    '渲染层两处还原型撤销（整本替换还原 / 整本整理）都要先核脏'
  );
  assert.match(HISTORY_SRC, guardLine, '历史还原的撤销闭包同样要先核脏');
});
