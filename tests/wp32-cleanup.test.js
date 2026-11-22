// v1.8.0 WP-32（A4 / A6 / A7 / V115）：死代码与样板清理的回归锚点。
//
//   · A4：core/history.js 的 SOURCE_META.restorable 是死字段（全仓无读取点），真正生效的是
//         RESTORABLE_SOURCES Set —— 删字段、只留 Set，防止以后改一份漏一份。
//   · A6：renderer/renderer.js 批量删除后的 `missed = findIndex((c, i) => i === state.index && !c)`
//         是死逻辑（稠密数组恒 -1），后件 `!state.chapters[state.index]` 已完全覆盖 —— 删掉，
//         但「当前章在书目里找不到了就回第一处原下标」的兜底必须还在。
//   · A7：focusChapterById / focusChapterAfterDelete / focusChapterAfterSwitch 三份约 80% 重复的
//         「焦点放回章节列表」实现合并成 focusChapterItem(locator)，三种落点行为逐字保留。
//   · V115：core/docx.js 的 language 参数「传了但没写」——删参数，w:lang 仍由固定模板产出，
//         传 language 不再改变任何字节（不再对外宣称支持一个不存在的功能）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const docx = require('../core/docx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 去掉注释：静态闸门只看代码，注释里解释「以前怎么写」不算回潮。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

test('A4：SOURCE_META 不再有 restorable 死字段，能还原的来源只有 RESTORABLE_SOURCES 一份事实', () => {
  const source = read('core/history.js');
  const start = source.indexOf('const SOURCE_META = {');
  const end = source.indexOf('const KNOWN_DIR_SOURCES');
  assert.ok(start > 0 && end > start, 'history.js 里找不到 SOURCE_META 字面量');
  const block = source.slice(start, end);
  assert.equal(/restorable\s*:/.test(block), false, 'SOURCE_META 里不许再有 restorable 字段');
  assert.ok(
    source.includes("const RESTORABLE_SOURCES = new Set(['replace', 'format', 'restore', 'snapshot']);"),
    '可还原来源的唯一事实 = RESTORABLE_SOURCES（4 类目录备份）'
  );
  // 删字段不许改变对外行为：类型标签 / 说明 / 目录前缀仍在（面板按它们显示）
  for (const label of ['整本替换', '整本整理', '还原前备份', '每日快照', '删除章节', '书目备份', '其他备份']) {
    assert.ok(block.includes(`label: '${label}'`), 'SOURCE_META 缺了 ' + label);
  }
  assert.ok(block.includes("prefix: '快照-'"), '目录前缀仍在 SOURCE_META 里（classifyDirName 用）');
  // 行为层：restorable 字段从不被读取 —— 删掉后历史模块的导出面与判定函数不变
  const history = require('../core/history');
  assert.equal(typeof history.listHistory, 'function');
  assert.equal(typeof history.CLEANABLE_SOURCES, 'object');
});

test('A6：批量删除后的 missed 死逻辑已删，当前章缺失的兜底仍在', () => {
  // WP17 A3 第四刀：批量删除整段随编辑域搬到 chapter-ops-ui.js；死逻辑与兜底按
  // 「renderer + 编辑域模块」合并核对（兜底仍只有一份）。
  const source = stripComments(
    read('renderer/renderer.js') + '\n' + read('renderer/chapter-ops-ui.js')
  );
  assert.equal(source.includes('const missed = state.chapters.findIndex('), false, 'missed 死逻辑不许回潮');
  assert.equal(source.includes('missed >= 0'), false, 'missed 的分支不许回潮');
  // 后件保留：当前章在书目里找不到（外部改坏）时回第一处原下标，别停在空下标上
  assert.ok(source.includes('} else if (!state.chapters[state.index]) {'), '当前章缺失的兜底必须保留');
  assert.ok(
    source.includes('state.index = Math.min(firstIndex, Math.max(0, state.chapters.length - 1));'),
    '兜底落点仍是第一处原下标（夹到合法范围）'
  );
});

test('A7：三种焦点归位合并成唯一实现 focusChapterItem，三个落点分支都在', () => {
  // M1 第 10 轮第二刀：命令面板的条目表搬进 renderer/command-items-ui.js，switch ×2 的调用点
  // 按「renderer + 该模块」合并核对（实现本体仍在 renderer.js，只许一份）。
  // M1 第 13 轮第七刀：Ctrl+PageUp/PageDown 的 switch 调用点随全局 keydown 分流链进
  // renderer/global-keys-ui.js，读取范围再加该模块（断言一条没改，计数口径仍是「实现只有一份」）。
  const source = stripComments(
    read('renderer/renderer.js') + '\n' +
      read('renderer/command-items-ui.js') + '\n' +
      read('renderer/global-keys-ui.js')
  );
  assert.equal((source.match(/function focusChapterItem\(/g) || []).length, 1, '只许一份焦点归位实现');
  for (const old of ['function focusChapterById(', 'function focusChapterAfterDelete(', 'function focusChapterAfterSwitch(']) {
    assert.equal(source.includes(old), false, old + ' 旧实现不许留第二份');
  }
  const start = source.indexOf('function focusChapterItem(');
  const body = source.slice(start, source.indexOf('\n  }', start));
  assert.ok(body.includes("mode === 'switch'"), '\'switch\' 落点（Ctrl+PageUp/Dn 切章）要保留');
  assert.ok(body.includes("mode === 'id'"), '\'id\' 落点（拖拽 / Alt+↑↓ 移动）要保留');
  assert.ok(body.includes('position'), '\'position\' 落点（Delete 删除）要保留');
  // switch 那一路「只在焦点原本就在章节列表里才动」的判据在合并后的实现里
  assert.ok(body.includes("closest('#chapter-list')"), '不许从编辑区抢焦点');
  // 调用点：id ×3（Alt+↑↓ 移动 / 跨卷撤销前后）、switch ×2（Ctrl+Page / 命令面板）、position ×2（单删 / 批删）
  // 命令面板的 switch 落点在 五-M5 后按 chapter.id 现场解析出 at（不再用构建时下标）。
  assert.equal((source.match(/focusChapterItem\(\{ mode: 'id', id: chapter\.id \}\)/g) || []).length, 3);
  assert.equal((source.match(/focusChapterItem\(\{ mode: 'switch', index(: (?:target|at))? \}\)/g) || []).length, 2);
  assert.equal((source.match(/focusChapterItem\(\{ mode: 'position', position \}\)/g) || []).length, 2);
});

test('V115：docx 的 language 参数已删，w:lang 仍是固定模板（传 language 不改变任何字节）', () => {
  const meta = { title: '测试书', chapters: [{ id: 'c1', name: '第一章' }, { id: 'c2', name: '第二章' }] };
  const texts = ['第一段正文。', '第二段正文。'];
  const base = docx.docxFiles({ meta, texts });
  const withLanguage = docx.docxFiles({ meta, texts, language: 'en-US' });
  assert.deepEqual(withLanguage, base, 'language 参数不再影响产出（接口空洞已删）');
  const styles = base.find((file) => file.name === 'word/styles.xml');
  assert.ok(styles, '必须有 word/styles.xml');
  assert.ok(
    styles.data.includes('<w:lang w:val="en-US" w:eastAsia="zh-CN"/>'),
    'w:lang 仍由 WORD_LANGUAGE 固定模板产出（zh-CN）'
  );
  const source = stripComments(read('core/docx.js'));
  assert.equal(source.includes('input.language'), false, 'normalizeInput 不许再读 input.language');
  assert.equal(source.includes('lang,'), false, 'buildBundle 返回值里不许再有 lang 字段');
  assert.ok(source.includes("const WORD_LANGUAGE = 'zh-CN';"), '固定语言常量保留（w:lang 模板用）');
});