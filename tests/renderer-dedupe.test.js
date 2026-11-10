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
const HISTORY_SRC = read('renderer/history-ui.js');

const countOf = (source, needle) => source.split(needle).length - 1;

test('C2：章节 / 分卷写盘后统一 applyMetaAndRelocate，不再散落 9 份「换书目 + 重定位」', () => {
  assert.equal(countOf(RENDERER_SRC, 'function applyMetaAndRelocate('), 1, '收口函数只该定义一次');
  // 1 处定义 + 14 个调用点（新建章 / 新建卷 / 重命名卷 / 移动卷 / 删除卷 / 移到卷 / 重命名章 / 删章 / 改章节信息
  // + 1.4.0 P0-2 的「撤销删除」+ 1.5.0 功能-1 的批量删除（逐章删 + 一次撤销恢复）/ 批量移到卷 / 批量改状态）
  assert.equal(countOf(RENDERER_SRC, 'applyMetaAndRelocate('), 15, '调用点应为 14 个');
  // 只该剩换书（openBookByPath 要连 bookPath / bookId / 折叠状态一起换，不适用）与 helper 本体两处
  assert.equal(countOf(RENDERER_SRC, 'state.meta = data.meta;'), 2, '散落的换书目应已收进 helper');
  assert.equal(countOf(RENDERER_SRC, 'state.chapters = data.meta.chapters;'), 2, '散落的换章节数组应已收进 helper');
  // 兜底语义留在调用点：删卷找不到当前章回第 1 章；删章（非当前章）找不到回「原下标与末章取小」
  assert.ok(/const at = applyMetaAndRelocate\(data, currentId\);\s*\n\s*if \(at < 0\) state\.index = 0;/.test(RENDERER_SRC), '删卷的兜底不见了');
  assert.ok(
    /if \(at < 0\) state\.index = Math\.min\(index, state\.chapters\.length - 1\);/.test(RENDERER_SRC),
    '删非当前章的下标兜底不见了'
  );
  // helper 本身：不传 id 只换书目，传了才重定位（新建 / 重命名 / 改信息这些顺序不变的场景不重定位）
  assert.ok(/function applyMetaAndRelocate\(data, currentId\) \{[\s\S]{0,400}if \(!currentId\) return -1;/.test(RENDERER_SRC));
});

test('C3：编辑区原生插入只留一份 replaceEditorTextNative，三个调用点都在 renderer.js', () => {
  assert.equal(countOf(RENDERER_SRC, 'document.execCommand('), 1, 'renderer.js 里只该有 replaceEditorTextNative 里那一处 execCommand');
  assert.equal(countOf(RENDERER_SRC, 'function replaceEditorTextNative('), 1, 'replaceEditorTextNative 只该定义一次');
  // 2026-11-07 剪贴板单列表面板：「正文」按钮插入当前章（契约 §5 host.insertIntoBody）复用这一份实现，
  // 不另写 execCommand；调用点因此从两个变三个（章节模板 / 替换这一处 / 剪贴板正文插入）。
  assert.equal(countOf(RENDERER_SRC, 'replaceEditorTextNative('), 4, '定义 + 三个调用点（章节模板 / 替换这一处 / 剪贴板正文插入）');
  // 两个调用点的兜底必须还在：execCommand 不可用 / 内容没进去时手动塞回，绝不丢内容
  assert.ok(
    /if \(!inserted \|\| editorEl\.value !== text\) \{[\s\S]{0,120}editorEl\.value = text;/.test(RENDERER_SRC),
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

test('C3：拦截的返回值形状与旧行为一致（ok / canceled / saved 三态）', () => {
  // 形状是调用方 return guard.canceled ? {...canceled} : guard.saved 的依据，逐条钉住
  assert.ok(
    /if \(action === 'cancel'\) return \{ ok: false, canceled: true \};/.test(RENDERER_SRC),
    '取消必须返回 { ok:false, canceled:true }'
  );
  assert.ok(
    /if \(!saved\.ok\) return \{ ok: false, saved \};/.test(RENDERER_SRC),
    '保存失败必须把 saveCurrent 的结果原样带回去'
  );
  assert.ok(/return \{ ok: true \};/.test(RENDERER_SRC), '可以继续时返回 { ok:true }');
  // 两处调用方都按三态还原（取消 → canceled；保存失败 → 原样上抛）
  for (const source of [RENDERER_SRC, HISTORY_SRC]) {
    assert.ok(
      /if \(!guard\.ok\) return guard\.canceled \? \{ ok: false, canceled: true \} : guard\.saved;/.test(source),
      '调用方必须按三态还原旧返回值'
    );
  }
});
