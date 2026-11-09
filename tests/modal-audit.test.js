/* 1.4.0 P0-2（撤销优先于确认）的静态闸门：模态只留两处。
 *
 * 拍板口径（1.4.0 作业卡 §2 P0-2）：**只有两类动作还允许弹通用询问框**——
 *   ① 未保存拦截（切书 / 关窗 / 还原前先处理没保存的字；含「保存失败仍要退出」的二次询问）；
 *   ② 删除整本书（整本进 Windows 回收站，应用内没有还原通道）。
 * 其余「确认型」动作一律改成「直接执行 + 10 秒撤销」；「选择型」弹层（导入模式 / 修复方式 /
 * 外部修改）不是确认，保留。
 *
 * 这条闸门钉三件事，防止以后又悄悄加回确认框：
 *   1. openModal 的调用点数量与用途固定（每条都要在 ALLOWED 里说得清）；
 *   2. 被撤掉的确认标题（删除章节 / 删除卷 / 跨卷移动 / 移到卷 / 一键整理本书 / 整本替换确认 /
 *      还原到替换前 / 还原整组备份 / 还原这一章 / 清空这天的快照 / 把删除的章节放回书文件夹）
 *      不许再出现在渲染层；
 *   3. 已经改成「直接执行」的动作必须真的登记了 10 秒撤销（undoUi.activate / registerUndo），
 *      否则等于把确认框删了却没给退路。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const read = (name) => fs.readFileSync(path.join(RENDERER_DIR, name), 'utf8');

// openModal 的调用点：必须在这里逐条说清「为什么还弹」。
// key = 文件:用途，value = 该调用点里必须出现的一段标识（title 或调用它的函数名）。
const ALLOWED = [
  ['renderer.js', 'title,', 'promptText：重命名 / 备注这类「填一个值」的输入框（不是确认）'],
  ['renderer.js', "title: title || '有未保存的修改'", 'askUnsaved：未保存拦截（保留 ①）'],
  ['renderer.js', 'title: `修复「${book.title || \'这本书\'}」`,', '修复方式：从目录重建 / 从备份恢复（选择型）'],
  ['renderer.js', "title: '保存失败'", '保存失败仍要退出：未保存拦截的延伸（保留 ①）'],
  ['import-ui.js', "title: '导入小说'", '导入模式：按原文章节 / 整本一章（选择型）'],
  ['import-ui.js', "title: '删除这本书'", '删除整本书（保留 ②）'],
  ['statusbar-ui.js', "title: '检测到外部修改'", '外部修改：重新加载 / 保留当前（选择型）']
];

// 被撤掉的确认标题：一个都不许回来（回来等于又插了一个模态）。
const REMOVED_TITLES = [
  '删除章节',
  '删除卷',
  '跨卷移动',
  "title: '移到卷'",
  '一键整理本书',
  '整本替换确认',
  '还原到替换前',
  '还原整组备份',
  '还原这一章',
  '清空这天的快照',
  '把删除的章节放回书文件夹'
];

// 「直接执行」的九个动作：渲染层必须登记撤销（否则没有退路）。
const UNDO_REGISTRATIONS = [
  ['renderer.js', 'undoUi.activate(', '删除章节 / 跨卷移动 / 移到卷 / 删除卷 / 一键整理 / 还原到替换前'],
  ['find-ui.js', 'registerUndo(', '整本替换'],
  ['history-ui.js', 'registerUndo(', '历史还原（覆盖型）']
];

function openModalSites(source) {
  // 只数「调用」：`openModal({` 且不是函数定义那一行
  const lines = source.split('\n');
  const sites = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes('openModal({')) continue;
    if (/function openModal\(/.test(line)) continue;
    sites.push({ line: i + 1, text: lines.slice(i, i + 12).join('\n') });
  }
  return sites;
}

test('模态审计：openModal 的调用点数量与用途固定（多了少了都要在评审里说清）', () => {
  const files = ['renderer.js', 'import-ui.js', 'statusbar-ui.js', 'find-ui.js', 'history-ui.js'];
  const found = [];
  for (const file of files) {
    for (const site of openModalSites(read(file))) found.push({ file, ...site });
  }
  assert.equal(
    found.length,
    ALLOWED.length,
    `openModal 调用点应为 ${ALLOWED.length} 处，实际 ${found.length} 处：` +
      found.map((site) => `${site.file}:${site.line}`).join(' / ')
  );
  for (const [file, marker, why] of ALLOWED) {
    const hit = found.find((site) => site.file === file && site.text.includes(marker));
    assert.ok(hit, `少了登记过的调用点（${file} · ${why}）；新增弹窗请先在 ALLOWED 里说清为什么必须弹`);
  }
});

test('模态审计：撤掉的确认标题不许回来（确认型动作只留两处）', () => {
  const sources = ['renderer.js', 'import-ui.js', 'statusbar-ui.js', 'find-ui.js', 'history-ui.js']
    .map((file) => [file, read(file)]);
  for (const title of REMOVED_TITLES) {
    for (const [file, source] of sources) {
      assert.equal(
        source.includes(`title: '${title}'`) || source.includes(`title: "${title}"`) || source.includes(`title: \`${title}`),
        false,
        `${file} 里又出现了被撤掉的确认标题「${title}」—— 1.4.0 起这类动作用「直接执行 + 撤销」`
      );
    }
  }
});

test('模态审计：改成直接执行的动作都登记了 10 秒撤销（删了确认就得给退路）', () => {
  for (const [file, marker, why] of UNDO_REGISTRATIONS) {
    const source = read(file);
    assert.ok(source.includes(marker), `${file} 里找不到撤销登记（${why}）`);
  }
  // 撤销条本身只在 undo-ui.js 里出现一次；别处不许自己再造一条
  const uiSource = read('undo-ui.js');
  assert.equal(uiSource.split('function createUndoUi(').length - 1, 1, '撤销条只许有一个实现');
  // 键位判定与 TTL 在纯逻辑模块里，10 秒是写死的口径
  const actionSource = read('undo-action.js');
  assert.match(actionSource, /const TTL_MS = 10000;/, '撤销窗口固定 10 秒（验收清单与 README 都这么写）');
  assert.ok(actionSource.includes('function isTypingTarget('), '焦点保护必须在纯逻辑里可单测');
  assert.ok(actionSource.includes('function isUndoKey('), 'Ctrl+Z 判定必须在纯逻辑里可单测');
});

test('模态审计：撤销失败不许静默（三种撤销路径都要能把错误抛给人看）', () => {
  const uiSource = read('undo-ui.js');
  assert.match(uiSource, /撤销失败：/, '撤销条失败要 toast 说原因');
  assert.match(uiSource, /scheduleExpire\(\);/, '失败后条子不收起（同一个动作可以再点一次）');
  // 渲染层与两个模块的撤销闭包：先核「还是同一本书」，失败抛出
  for (const file of ['renderer.js', 'find-ui.js', 'history-ui.js']) {
    assert.ok(read(file).includes("已经换了书，不能撤销"), `${file} 的撤销闭包要先核对还是同一本书`);
  }
});