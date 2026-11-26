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
    /公开文档[^\n]*README\.md[^\n]*LICENSE[^\n]*docs\/[^\n]*验收清单/,
    'README 的公开文档清单要列当前公开文档（README / LICENSE / docs/，验收清单在 docs/ 下；M-N3 / 2026-11-22 迁入 docs）'
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
  const checklist = read('docs/验收清单.md');
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
  const checklist = read('docs/验收清单.md');
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

test('X14：维护者文档记录静态闸门策略（不强制削减；M-N3 从 README 拆出）', () => {
  const maintain = read('docs/维护与自检.md');
  assert.ok(maintain.includes('### 测试与静态闸门策略（X14，不强制削减）'), '要有独立的策略小节');
  assert.ok(maintain.includes('静态闸门是有意的防漂移锚点，不强制削减'), '要写明不强制削减');
  assert.ok(maintain.includes('新增功能优先写行为断言'), '要写明优先写行为断言');
  assert.ok(maintain.includes('不许批量删除或用正则放宽到永远通过'), '要写明重构时的处理口径');
  assert.equal(read('README.md').includes('### 测试与静态闸门策略'), false, 'README 不再混维护者策略');
});
test('R23 appId：永久保留 local.chapter-writer 并文档化（拍板 ④）', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.build.appId, 'local.chapter-writer', 'appId 必须保持历史身份（永久保留，不做不可逆迁移）');

  const readme = read('README.md');
  assert.match(readme, /appId[^\n]*永久保留/, 'README 要写明 appId 永久保留');
  assert.ok(readme.includes('local.chapter-writer'), 'README 要点名 appId 字面量');
  assert.ok(readme.includes('历史身份'), 'README 要说明它是历史身份');
  assert.match(readme, /(不迁移|永不迁移|不再迁移)/, 'README 要写明不做迁移');
  assert.equal(
    /正式反向域名[^\n]*顺延到下一个大版本/.test(readme),
    false,
    '拍板 ④ 已改为永久保留：不许再承诺下个大版本迁移 appId'
  );
  // 与数据目录彻底解耦这条口径保留（数据目录在 main.js 显式指定）。
  assert.match(readme, /%APPDATA%\\chapter-writer/, '仍要写明应用数据目录名');
});

test('R24 M-N3：维护者内容迁出 README（打包 / 供应链 / 静态闸门策略 / 完整已知限制）', () => {
  const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
  assert.ok(exists('docs/维护与自检.md'), '维护者文档 docs/维护与自检.md 必须存在（M-N3 拆分落点）');
  assert.ok(exists('docs/已知限制.md'), '完整已知限制 docs/已知限制.md 必须存在（M-N3 拆分落点）');

  const readme = read('README.md');
  const maintain = read('docs/维护与自检.md');
  const limits = read('docs/已知限制.md');
  const checklist = read('docs/验收清单.md');

  // 1) 打包 / 构建供应链 / 静态闸门策略整体迁到维护者文档（内容不丢，只是换文件）。
  assert.match(maintain, /## 打包（开发者\/维护用）/, '维护者文档要收打包手册');
  assert.match(maintain, /### 构建供应链（Electron 二进制）/, '维护者文档要收构建供应链');
  assert.match(maintain, /node scripts\/supply-chain-check\.js/, '发版门禁命令要跟着迁走');
  assert.match(maintain, /### 测试与静态闸门策略（X14，不强制削减）/, '维护者文档要收静态闸门策略');
  assert.match(maintain, /## 验收自检纪律（2026-11-11 起）/, '验收自检纪律迁到维护者文档');
  assert.equal(readme.includes('## 打包（开发者/维护用）'), false, 'README 不再承载详细打包手册');
  assert.equal(readme.includes('### 构建供应链（Electron 二进制）'), false, 'README 不再承载供应链细节');
  assert.equal(readme.includes('### 测试与静态闸门策略'), false, 'README 不再承载静态闸门策略');
  assert.equal(checklist.includes('## 自检纪律（2026-11-11 起 · 硬要求）'), false, '验收清单不再混维护者纪律');
  assert.match(readme, /docs\/维护与自检\.md/, 'README 要有维护者文档指针');
  assert.match(checklist, /\[维护与自检\]\(维护与自检\.md\)/, '验收清单（docs/ 内）要相对链接到维护者文档');

  // 2) 完整已知限制迁出：README 只留要点 + fuse 声明（version-sync 的 checkFuseDocs 仍从 README 读）。
  assert.match(readme, /## 已知限制（要点/, 'README 保留「已知限制（要点）」摘要');
  assert.match(readme, /docs\/已知限制\.md/, 'README 要链到完整已知限制');
  assert.match(limits, /## 已知限制（仍有意不做）/, '完整已知限制文档保留原标题');
  assert.match(limits, /Electron 安全开关之外的残余风险/, '完整已知限制内容不丢');
  assert.match(
    readme,
    /已开[^\n]*enableEmbeddedAsarIntegrityValidation[^\n]*onlyLoadAppFromAsar/,
    'README 摘要仍要如实写明两个 fuse 已开（version-sync M1 门禁）'
  );

  // 3) 拆分要有可验收的「变短」：README 回落到使用者文档体量，且公开文档清单包含 docs/。
  assert.ok(readme.length < 90000, `README 要明显变短（现在 ${readme.length} 字符，拆分前 106496）`);
  assert.ok(readme.split('\n').length < 620, `README 行数要降到 620 以内（现在 ${readme.split('\n').length}）`);
  assert.match(readme, /公开文档[^\n]*README\.md[^\n]*LICENSE[^\n]*docs\/[^\n]*验收清单/, '公开文档清单要包含 docs/ 与 docs/ 下的验收清单');
});

// IO-04（低）：文档口径跟实际行为对齐 —— ① T-10 之后「按原文章节导入」写盘也是 CRLF
// （core/importer.js 两处都过 chapters.toDiskNewlines）；② WP7 之后无 BOM UTF-16 只在
// 16 位启发式命中（≥98% 码元落在正文码位）时接受，不再一律当「不是纯文本」拒绝。
test('IO-04：导入写盘换行与无 BOM UTF-16 口径跟实际行为一致', () => {
  const safety = read('docs/数据安全.md');
  assert.equal(
    safety.includes('拆出来的章文件从导入那一刻起是 LF 的 UTF-8'),
    false,
    'T-10 后「按原文章节导入」写盘统一 CRLF，不许再写「导入那一刻是 LF、第一次保存后才是 CRLF」'
  );
  assert.match(
    safety,
    /按原文章节导入[^\r\n]*写盘[^\r\n]*CRLF/,
    '要如实写「按原文章节导入」写盘为 CRLF（与正常保存 / 自动分章导入同一口径）'
  );

  const limits = read('docs/已知限制.md');
  assert.equal(
    limits.includes('没有 BOM 的 UTF-16 会被当成「不是纯文本」拒绝'),
    false,
    'WP7 起无 BOM UTF-16 命中启发式即可导入，不许再写「一律拒绝」'
  );
  assert.match(
    limits,
    /没有 BOM 的 UTF-16[^\r\n]{0,80}启发式[^\r\n]{0,80}接受/,
    '要如实写「无 BOM UTF-16 只在启发式命中时接受」'
  );
});

// DOC-02（低）：无障碍 / 对比度门禁的采样数必须写当前实测值。2026-11-26 实测（HEAD 364a 之前
// 的 25 日 19:37 产物 + 本轮重跑一致）：a11y 目标 639 条 / 焦点 190 条；contrast 6 主题 85 条
// 规格 = 510 条通过 + 12 条禁用态豁免（shelf.newGroup 等新增采样）。旧的 635 / 504 必须改掉。
test('DOC-02：无障碍 / 对比度文档写当前门禁实测值，不再留 635 / 504', () => {
  const a11y = read('docs/无障碍.md');
  assert.equal(a11y.includes('635 条'), false, 'a11y 目标尺寸实测已是 639 条，旧值必须改掉');
  assert.match(a11y, /当前实测 \*\*639 条全部达标\*\*/, '要写当前实测 639 条');
  assert.equal(a11y.includes('504 条规格'), false, '对比度实测已是 510 条规格');
  assert.match(a11y, /510 条规格全过 WCAG 2\.1 AA/, '要写当前实测 510 条规格');
  assert.match(a11y, /6 主题 × 87 条采样（85 条规格 \+ 2 条禁用态豁免 = 510 通过 \+ 12 豁免）/, '采样范围与通过数要对得上');
  const checklist = read('docs/验收清单.md');
  assert.equal(checklist.includes('504 条扩展态'), false, '验收清单也同步 510');
  assert.match(checklist, /510 条扩展态 \+ 12 条禁用态豁免/);
  const manual = read('docs/使用手册.md');
  assert.match(manual, /6 主题 510 条规格全过 \+ 12 条禁用态豁免/, '使用手册的同一口径也要同步');
});

// A2-DOC-01..05（第二轮审计 5 条 docs 类）：文档口径与实现对齐 ——
// ① README 的 .bak 承诺（结构性每次 / 普通保存 5 分钟窗口）；② 弹层数量（17 个静态 .backdrop）；
// ③ 无障碍允许清单（目标尺寸只剩章节栏分隔条一条、焦点清单为空）；④ 备份清理入口写进公开文档；
// ⑤ 字数口径（UTF-16 码元且去空白，不是 String.length）。
test('A2-DOC-01..05：文档口径与实现一致（.bak 时间窗 / 弹层 17 / 允许清单 / 清理入口 / 字数口径）', () => {
  const readme = read('README.md');
  assert.equal(
    readme.includes('每次写入前保留上一版 `.bak`'),
    false,
    'README 不许再承诺「每次写入前都有上一版」（普通保存是 5 分钟时间窗）'
  );
  assert.match(readme, /结构性变更[^\n]{0,60}每次[^\n]{0,120}普通保存[^\n]{0,60}5 分钟/, '.bak 口径要写清两种轮换节奏');
  assert.equal(readme.includes('与 `String.length` 一致'), false, '字数不是 String.length（会去掉空白字符）');
  assert.match(readme, /UTF-16 码元[^\n]{0,80}去掉空白/, '字数口径要写明按码元计且去空白');

  const limits = read('docs/已知限制.md');
  assert.equal(limits.includes('让 13 个 `.backdrop` 弹层里的 11 个'), false, '弹层接管范围不许再低报成 13/11');
  assert.match(limits, /全部 17 个静态 `\.backdrop` 弹层/, '要写「页面里全部 17 个静态 .backdrop」（dialog-focus 全量接管）');

  const a11y = read('docs/无障碍.md');
  assert.equal(a11y.includes('门禁在 16 个弹层 / 面板状态里逐个聚焦'), false, '弹层数量写死 16 会随新增弹层失真');
  assert.match(a11y, /门禁在逐个界面状态里逐个聚焦|门禁在[^\n]{0,20}全部[^\n]{0,20}弹层/, '焦点遮挡门禁要写「全部弹层 / 面板」而不写死数量');
  assert.equal(a11y.includes('目标尺寸已全部达标，允许清单为空'), false, '目标尺寸允许清单里还有章节栏分隔条一条');
  assert.match(a11y, /目标尺寸允许清单只剩章节栏分隔条一条[^\n]{0,30}焦点允许清单为空/, '允许清单口径要分目标尺寸 / 焦点两份写');

  const manual = read('docs/使用手册.md');
  assert.match(manual, /清理本书全部备份/, '本书历史的清理入口要进使用手册');
  assert.match(manual, /删除这组备份/, '分组的清理入口也要写');
  assert.match(manual, /移入[^\n]{0,10}回收站/, '清理只进回收站、可恢复，要如实写');
  assert.equal(limits.includes('按文件夹名手动删'), false, '已知限制不许再把「手删 _trash」当唯一腾空间办法');
  const faq = read('docs/常见问题.md');
  assert.equal(faq.includes('嫌多可以自己按文件夹名删'), false, '常见问题同样要指向面板里的清理入口');
  assert.match(faq, /清理本书全部备份|删除这组备份/, '常见问题要写现成的清理入口');
});
