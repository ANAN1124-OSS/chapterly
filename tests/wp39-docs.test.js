'use strict';
// WP-39（D4/D9/D12/X3/X5/X12/X13/X14）：文档与口径如实化。
//
// 这些是「文档 / 注释与行为一致」的锚点，不是行为测试：
//   D9  stats 写盘失败的注释不许再承诺「下次保存补记」，实际是失败即丢弃增量；
//   X5  blankLines:'keep' 也不保持首尾空行，注释 / 对话框说明 / README 三处口径一致；
//   X3  README 说明字数按 UTF-16 码元计（emoji / 扩展区汉字算 2 字）；
//   D12 README 只留当前文档，版本沿革 / 防丢稿逐轮记录 / 开发自检历史归档到 内部文档/（不进公开仓库）；
//   X13 公开文档不再含开发机绝对路径；
//   X12 index.html 统一 .hidden 类显隐，原生 hidden 只留语义场景（tabpanel / <option>）；
//   D4  renderer.js 模块声明区注释紧贴自己的声明，不再交错；
//   X14 README 记录静态闸门策略（不强制削减）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('D9：stats 写盘失败的注释如实写「失败即丢弃增量」，不再承诺下次补记', () => {
  const src = read('core/stats.js');
  assert.ok(src.includes('这次增量直接丢弃'), '注释要说明写盘失败即丢弃这次增量');
  assert.ok(!src.includes('下次成功保存会重新带上这次增量'), '不许再写「下次保存会重新带上」');
  assert.ok(src.includes('没有可靠的旧值可以回填'), '要说明为什么不能补记（正文已落盘、章字数基线已前移）');
  assert.ok(src.includes('由调用方记 warn 日志'), '要写明失败出口（recordSaveChars 收成 {ok:false} 并记日志）');
});

test('X5：blankLines 各模式的首尾空行行为在注释 / 对话框说明 / README 三处一致', () => {
  const format = read('core/format.js');
  assert.ok(format.includes('所有模式都会丢掉正文开头的空行'), 'format.js 注释要写明首部空行行为');
  assert.ok(format.includes('结尾连续空行只留一个'), 'format.js 注释要写明尾部空行行为');
  assert.ok(format.includes('keep 也不保持首尾'), '要明确 keep 不保持首尾');

  const html = read('renderer/index.html');
  assert.ok(html.includes('class="muted small format-blank-hint"'), '排版对话框要有首尾空行说明');
  assert.match(
    html,
    /class="muted small format-blank-hint"[^>]*>[^<]*开头的空行[^<]*结尾连续空行只保留一个[^<]*保持的是段与段之间的空行数/,
    '对话框说明要同时讲开头 / 结尾与「保持原样」的实际范围'
  );

  const readme = read('README.md');
  assert.ok(readme.includes('所有模式都会丢掉正文开头的空行、结尾连续空行只保留一个'), 'README 排版表要写明');
  assert.ok(readme.includes('首尾空行不在「保持原样」的范围内'), 'README 要有首尾空行 bullet');

  const css = read('renderer/styles.css');
  assert.ok(css.includes('.format-rules .format-blank-hint'), '说明行要有样式（与 check-row 同左缩进）');
});

test('X3：README 说明字数按 UTF-16 码元计（emoji / 扩展区汉字算 2 字）', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('UTF-16 码元'), '要写明 UTF-16 码元口径');
  assert.match(readme, /emoji 与扩展区汉字[^。]*算 2 字/, '要明确 emoji / 扩展区汉字算 2 字');
  assert.ok(readme.includes('`String.length`'), '要与 JavaScript 的口径对上');
  assert.ok(readme.includes('状态栏、章节列表、书架统计'), '要说明全应用同一口径（含统计与阈值）');
});

test('D12 / M3：README 只留当前文档，版本沿革 / 防丢稿逐轮记录 / 开发自检历史归档到内部文档', () => {
  const readme = read('README.md');
  // 审计 #28（M3）：历史分册不再进公开仓库，根目录不再有 沿革.md（归档到被 .gitignore 忽略的 内部文档/）。
  assert.equal(fs.existsSync(path.join(ROOT, '沿革.md')), false, '版本沿革分册不进公开仓库（已归档到 内部文档/）');
  assert.ok(!readme.includes('[沿革.md](沿革.md)'), 'README 不许再链 沿革.md');
  assert.match(
    readme,
    /内部文档\/归档-2026-11-15\/沿革\.md/,
    'README 要写明沿革归档路径（内部文档，不进公开仓库）'
  );
  for (const heading of ['## 版本沿革', '## 防丢稿设计逐轮记录', '## 开发自检历史说明']) {
    assert.ok(!readme.includes(heading), `README 不许再放历史分册小节 ${heading}`);
  }
  assert.ok(!readme.includes('25. **「整理」点一下就整理'), 'README 不再放防丢稿逐轮改动原文');
  assert.ok(!/node:test，\d+ 项，覆盖/.test(readme), 'README 不再放逐项测试覆盖清单');

  // 版本锚点必须仍各只有一处（scripts/version-sync.js 按精确命中数校验）。
  assert.equal((readme.match(/node:test，\d+ 项/g) || []).length, 1, 'README 单测计数 1 处');
  assert.equal((readme.match(/真实启动 Electron 走 \d+ 项主流程/g) || []).length, 1, 'README E2E 计数 1 处');
  // 版本沿革里原来还有一句「已于 YYYY-MM-DD 发布」，随段落移出后 README 的发布日期锚点恢复唯一。
  assert.equal((readme.match(/已于 \d{4}-\d{2}-\d{2} 发布/g) || []).length, 1, 'README 发布日期锚点 1 处');
  assert.ok(readme.includes('# 章回 / Chapterly v'), 'README 标题锚点仍在');
  assert.ok(readme.includes('## 许可'), 'README 许可段仍在');
  assert.match(
    readme,
    /公开文档[^\n]*README\.md[^\n]*验收清单\.md[^\n]*LICENSE/,
    'README 的公开文档清单只列当前文档（README / 验收清单 / LICENSE）'
  );
});

test('D12 / M3：README 的开发自检细节（目录树 / 截图命令）移出公开文档', () => {
  const readme = read('README.md');
  assert.ok(!readme.includes('## 目录结构'), 'README 不再放完整目录结构（已归档到内部文档）');
  assert.ok(
    readme.includes('内部文档/归档-2026-11-15/README-开发自检细节.md'),
    'README 要写明开发自检细节的归档路径'
  );
  // version-sync 的 E2E 组数门禁仍要能从 README 找到两处描述（checkE2eGroupDocs）。
  assert.match(readme, /场景与 \d+ 个组文件共用一份/, 'README 仍要有「场景与 N 个组文件共用一份」');
  assert.match(readme, /\*\*\d+ 个组文件（\d+–\d+）\*\*/, 'README 仍要有「N 个组文件（0–NN）」');
});

test('D12 / M3：验收清单只留当前手工步骤，历史增量归档到内部文档', () => {
  const checklist = read('验收清单.md');
  for (const legacy of ['## 版本沿革', '## 1.1.0 内容增量', '## 1.6.0 内容增量', '## 1.8.0 试用分支增量']) {
    assert.ok(!checklist.includes(legacy), `验收清单不许再放历史增量：${legacy}`);
  }
  assert.ok(
    checklist.includes('内部文档/归档-2026-11-15/验收清单-历史增量.md'),
    '验收清单要写明历史增量的归档路径'
  );
  assert.ok(checklist.includes('## 验收步骤'), '当前版本的手工验收步骤仍在');
  // 计数锚点仍各有 1 处（version-sync 的 CHECKLIST_COUNT_RULES 同口径）。
  assert.equal((checklist.match(/`pnpm test`（\d+ 项）/g) || []).length, 1, '验收清单单测计数 1 处');
  assert.equal((checklist.match(/`pnpm run e2e`（\d+ 项）/g) || []).length, 1, '验收清单 E2E 计数 1 处');
});

test('X13：公开文档不再含开发机绝对路径（README / 验收清单）', () => {
  const readme = read('README.md');
  for (const leaked of ['D:\\code\\chapterly', 'D:\\APP\\kdwrite']) {
    assert.ok(!readme.includes(leaked), `README 不许出现开发机路径 ${leaked}`);
  }
  assert.ok(readme.includes('cd <仓库目录>'), '开发版安装步骤改用占位目录');
  const checklist = read('验收清单.md');
  assert.ok(!checklist.includes('D:\\AI工作区'), '验收清单不许引用内部工作区路径');
});

test('X12：index.html 统一用 .hidden 类显隐；原生 hidden 只留语义场景且有边界说明', () => {
  const html = read('renderer/index.html');
  assert.ok(
    !/<(span|textarea|div|p|section|button|label|input|ul|li)[^>]*\shidden(?:\s|>)/.test(html),
    '普通元素不许再用 hidden 属性（统一 .hidden 类）'
  );
  assert.ok(html.includes('<span id="shelf-stats-streak" class="shelf-stats-streak hidden">'), 'streak 初始隐藏走类');
  assert.ok(
    html.includes('<textarea id="stats-csv-text" class="text-input stats-csv-text hidden"'),
    '统计 CSV 区初始隐藏走类'
  );

  const ui = read('renderer/stats-ui.js');
  assert.ok(!/\.hidden\s*=/.test(ui), 'stats-ui 不许再用 .hidden 属性赋值');
  assert.ok(ui.includes("area.classList.add('hidden')"), 'CSV 区隐藏走类');
  assert.ok(
    ui.includes("streakEl.classList.toggle('hidden', currentStreak <= 0)"),
    '连续天数隐藏走类'
  );

  const css = read('renderer/styles.css');
  assert.ok(css.includes('原生 hidden 属性只留给语义场景'), 'CSS 要写明两套机制的边界');

  // 语义场景保留原生 hidden：设置分区 role=tabpanel 与历史值 <option hidden>。
  const settings = read('renderer/settings-ui.js');
  assert.ok(settings.includes('section.hidden = '), '设置分区（role=tabpanel）仍走原生 hidden 属性');
  assert.ok(settings.includes('option.hidden = true'), '历史值 option 仍走原生 hidden');
});

test('D4：renderer.js 模块声明区注释紧贴自己的声明，不再交错', () => {
  const src = read('renderer/renderer.js');
  const pairs = [
    ['// 阅读模式（第 4 步九刀·第二刀）', 'const readingUiModule = window.CWReadingUi;'],
    ['// 编辑器小件（第 4 步九刀·第三刀）', 'const editorMarksUiModule = window.CWEditorMarksUi;'],
    ['// 日历 / 统计文案用的格式化口径', 'const statsFormat = { formatChars, formatDuration };'],
    ['// 书架正文搜索的调度 / 分页口径', 'const CONTENT_SEARCH_DEBOUNCE = 320;']
  ];
  for (const [comment, code] of pairs) {
    const lines = src.split('\n');
    const at = lines.findIndex((line) => line.includes(comment));
    assert.ok(at >= 0, `缺注释 ${comment}`);
    let nextCode = null;
    for (let i = at + 1; i < lines.length; i += 1) {
      const text = lines[i].trim();
      if (!text || text.startsWith('//')) continue;
      nextCode = text;
      break;
    }
    assert.equal(nextCode, code, `${comment} 的下一条代码必须是 ${code}`);
  }
  assert.equal(
    (src.match(/const CONTENT_RESULT_LIMIT = 40;/g) || []).length,
    1,
    'CONTENT_RESULT_LIMIT 只声明一次（已并入 CONTENT_SEARCH_* 常量组）'
  );
  assert.ok(
    !/readingUiModule = window\.CWReadingUi;[\s\S]{0,40}?\/\/ 放在调用之前没问题/.test(src),
    '被声明劈成两半的注释不许回来（阅读模式声明后面紧跟日历 / 统计注释的后半句）'
  );
});

test('X14：README 记录静态闸门策略（不强制削减）', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('### 测试与静态闸门策略（X14，不强制削减）'), '要有独立的策略小节');
  assert.ok(readme.includes('静态闸门是有意的防漂移锚点，不强制削减'), '要写明不强制削减');
  assert.ok(readme.includes('新增功能优先写行为断言'), '要写明优先写行为断言');
  assert.ok(readme.includes('不许批量删除或用正则放宽到永远通过'), '要写明重构时的处理口径');
});