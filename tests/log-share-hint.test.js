// 审计修复 #37（▲V310）：诊断日志的分享提示。
//
// 问题：日志正文遮罩只盖「连续 ≥24 个汉字」，书名 / 章名（通常 <24 字）与「章节文件「XXX.txt」」
// 这类 message 原样保留。审计明确说**不改阈值**（会伤可诊断性），改为在「设置 → 诊断日志 →
// 打开日志文件夹」旁给一句提示：日志可能含书名 / 章名，分享前自己先看一遍。
//
// 这里锁三件事：① 设置里真的有这句提示且默认可见（跟随日志分组显隐）；② 样式接上；
// ③ 24 字遮罩阈值没被顺手改掉，README 的口径也如实。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HTML = read('renderer/index.html');
const CSS = read('renderer/styles.css');
const README = read('README.md');

test('▲V310：设置「诊断日志」里有分享提示（书名 / 章名 / 文件名 + 分享前自查），默认可见', () => {
  const start = HTML.indexOf('id="settings-logs-field"');
  assert.ok(start > 0, 'index.html 找不到诊断日志分组');
  const next = HTML.indexOf('id="settings-update-group"', start);
  assert.ok(next > start, '诊断日志分组后面应是检查更新分组');
  const block = HTML.slice(start, next);

  assert.ok(block.includes('class="muted small logs-share-hint"'), '提示走小字样式（与设置里其它说明同一口径）');
  assert.ok(block.includes('书名'), '提示要写明日志里可能有书名');
  assert.ok(block.includes('章名'), '提示要写明日志里可能有章名');
  assert.ok(block.includes('文件名'), '提示要写明日志里可能有文件名');
  assert.ok(block.includes('不是正文'), '要说明「不是正文但仍是作品信息」的边界（不推翻原有隐私承诺）');
  assert.ok(block.includes('发给别人'), '要正面写分享场景（反馈问题时）');
  assert.ok(block.includes('先自己看一遍'), '要给出可执行动作：分享前自查');
  // 默认可见：提示元素本身不许带 hidden 类（整个日志分组是按书 / 全局作用域统一显隐的）
  const hintAt = block.indexOf('class="muted small logs-share-hint"');
  const hintTag = block.slice(hintAt, block.indexOf('>', hintAt) + 1);
  assert.equal(/hidden/.test(hintTag), false, '提示默认要可见（按书作用域由整组显隐控制）');
  // 不单独给 settings-* id：这个提示不是可配置项，不给设置项的信息架构 / 搜索引入新条目
  assert.equal(block.includes('settings-logs-share-hint'), false, '提示不是设置项，不新增 settings-* id');
});

test('▲V310：提示有样式（跟随设置单列左边缘、不挤按钮行）', () => {
  assert.match(CSS, /\.logs-share-hint \{ margin: 8px 0 0; line-height: 1\.6; \}/, '样式要接上（8px 上边距 + 1.6 行高）');
});

test('▲V310：24 个连续汉字的正文遮罩阈值没有被放宽（审计明确不改）', () => {
  const logs = read('core/logs.js');
  assert.match(logs, /const CJK_RUN = 24;/, '正文遮罩阈值仍是 24 个连续汉字');
  assert.ok(logs.includes('CJK_RE'), '遮罩仍在 sanitizeMessage / sanitizePath 链路里');
});

test('▲V310：README 如实写「可能有书名 / 章名」且不推翻「不含正文」承诺', () => {
  const start = README.indexOf('诊断日志单独存放在');
  assert.ok(start > 0, 'README 找不到诊断日志段');
  const block = README.slice(start, start + 900);
  assert.ok(block.includes('书名 / 章名'), 'README 要写明日志里可能有书名 / 章名');
  assert.ok(block.includes('把日志发给别人') && block.includes('先自己看一遍'), 'README 要给分享前自查的提示');
  assert.ok(block.includes('绝不写任何正文'), '「日志不含正文」的原承诺保留（书名 / 章名不是正文）');
});