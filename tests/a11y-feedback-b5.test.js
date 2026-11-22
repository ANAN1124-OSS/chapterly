// B5 无障碍反馈锚点（A1 / A2 / A6，三审 4.2）：
//   A1 保存成功不弹 toast（1.3.0 T7 收敛到状态栏），读屏必须从 live region 拿到「已保存」；
//   A2 章节栏分隔条可聚焦 + 键盘可调（←/→ 步进、Enter 复位）+ aria 值随宽度更新；
//   A6 查找命中数 / 跳章结果摘要用 role=status 播报（结果列表本身是按钮串，不整体设为 live）。
// 行为面由动态 a11y 门禁 + Electron 手测覆盖，这里钉住 HTML / 渲染层接线形状，防止静默回退。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

test('A1：保存状态文字是 polite live region，且 live region 不含「重试」按钮', () => {
  const tag = /<span id="status-text"([^>]*)>/.exec(HTML);
  assert.ok(tag, 'index.html 必须有 #status-text');
  assert.match(tag[1], /role="status"/, '#status-text 要 role="status"');
  assert.match(tag[1], /aria-live="polite"/, '#status-text 要 aria-live="polite"');
  // 只包文字：把带按钮的 #status-save 整块设成 live 会让「重试」被反复朗读 / 抢焦点
  const saveBlock = /<span id="status-save"([^>]*)>/.exec(HTML);
  assert.ok(saveBlock, 'index.html 必须有 #status-save');
  assert.equal(/role="status"|aria-live/.test(saveBlock[1]), false, 'live region 不许包住整个 #status-save');
});

test('A6：查找命中数 / 查找摘要 / 跳章摘要都是 live region；结果列表只命名不 live', () => {
  assert.match(HTML, /id="find-nav-count" role="status" aria-live="polite"/);
  const summary = /<div class="find-summary[^"]*" id="find-summary"([^>]*)>/.exec(HTML);
  assert.ok(summary, 'index.html 必须有 #find-summary');
  assert.match(summary[1], /role="status"/);
  assert.match(summary[1], /aria-live="polite"/);
  assert.match(HTML, /id="jump-summary" role="status" aria-live="polite"/);
  // 结果列表是按钮串：给名字（读屏能说「查找结果」），但不整体 live（否则每次更新整张清单被重念）
  assert.match(HTML, /id="find-results" role="group" aria-label="查找结果"/);
  assert.match(HTML, /id="jump-results" role="group" aria-label="跳章结果"/);
  assert.equal(/id="find-results"[^>]*aria-live/.test(HTML), false, '#find-results 不许整体 live');
  assert.equal(/id="jump-results"[^>]*aria-live/.test(HTML), false, '#jump-results 不许整体 live');
});

test('A2：章节栏分隔条 role=separator + tabindex=0 + aria 值；渲染层有键盘通道且同步 aria-valuenow', () => {
  const tag = /<div id="sidebar-resizer"([^>]*)>/.exec(HTML);
  assert.ok(tag, 'index.html 必须有 #sidebar-resizer');
  for (const attr of ['role="separator"', 'aria-orientation="vertical"', 'aria-valuemin="180"', 'aria-valuemax="800"', 'aria-valuenow=', 'tabindex="0"']) {
    assert.ok(tag[1].includes(attr), `分隔条缺少 ${attr}`);
  }
  // 键盘：←/→ 步进、Enter / 空格复位；与拖拽 / 双击共用 apply + persist（宽度持久化）
  const keyHandler = /resizer\.addEventListener\('keydown'[\s\S]{0,700}?ArrowLeft[\s\S]{0,300}?ArrowRight[\s\S]{0,300}?Enter: 250/;
  assert.match(RENDERER, keyHandler, 'renderer.js 缺分隔条键盘处理（←/→ 步进、Enter 复位）');
  assert.match(RENDERER, /persistSidebarWidth\(state\.sidebarWidth\)\.catch\(\(\) => \{\}\);/);
  // aria-valuenow 随实际宽度更新（拖拽 / 双击 / 键盘 / 打开书套用显示设置都走 applySidebarWidth）
  assert.match(
    RENDERER,
    /function applySidebarWidth\(width\) \{[\s\S]{0,400}?aria-valuenow/,
    'applySidebarWidth 必须同步 aria-valuenow'
  );
  // 5px 宽的分隔条放不下外扩环：必须有专门的 :focus-visible 规则（与按钮同一个焦点环令牌）
  const CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
  assert.match(CSS, /\.sidebar-resizer:focus-visible \{[\s\S]{0,140}?outline: 2px solid var\(--focus-ring\)/, '分隔条要有可见焦点环');
});
