// 读屏播报（2026-11-04 长跑 · Phase D / D7）——静态钉子。
//
// 为什么单独钉一份：toast 是应用里唯一的「短暂提示」出口（保存成功 / 读取失败 / 章节太长 / 章节
// 文件被挪走……），它往 #toast-area 里追加一条 <div class="toast">，3600ms 后淡出移除。这些提示
// 以前对看不见屏幕的人完全不存在：14 个弹层都有 role=dialog + aria-labelledby，书架书卡有
// role=button + 无障碍名称，唯独 toast 一个字都没有。
//
// 这里只钉三件事（改法、措辞、行号都不钉）：
//   ① 容器带 role=status / aria-live=polite / aria-atomic=false —— 读屏空闲时播报新增的这一条，
//      且不把区域里还在淡出的旧 toast 重念一遍；
//   ② 容器一直留在渲染树里 —— display:none / visibility:hidden 的 live region 不会播报；
//   ③ toast() 用 textContent 写文案、只往区域里**追加**一条 —— 换成 innerHTML 或清空重建会把
//      播报区自己一起冲掉，读屏就再也收不到了。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HTML = read('renderer/index.html');
const CSS = read('renderer/styles.css');
const RENDERER = read('renderer/renderer.js');

// 取一个选择器规则块（非贪婪到第一个 `}`；#toast-area 的两条规则都不嵌套花括号）
function ruleOf(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)[ \\t]*${escaped}[ \\t]*\\{([\\s\\S]*?)\\}`).exec(source);
  return match ? match[2] : '';
}

test('#toast-area 是读屏播报区：role=status + aria-live=polite + aria-atomic=false', () => {
  const tags = HTML.match(/<div\b[^>]*\bid="toast-area"[^>]*>/g) || [];
  assert.equal(tags.length, 1, 'index.html 里应当恰好有一个 #toast-area');
  const tag = tags[0];
  for (const [attr, value] of [
    ['role', 'status'],
    ['aria-live', 'polite'],
    ['aria-atomic', 'false']
  ]) {
    assert.match(
      tag,
      new RegExp(`\\b${attr}="${value}"`),
      `#toast-area 必须带 ${attr}="${value}"（否则读屏收不到「已保存 / 读取失败」这类短暂提示）`
    );
  }
  // 反向：不许再把播报区自己藏起来（aria-hidden 的 live region 一样不播报）
  assert.equal(/\baria-hidden=/.test(tag), false, '#toast-area 不能挂 aria-hidden（那样一条都不播报）');
});

test('#toast-area 一直留在渲染树里：CSS 不藏它，朗读条抬起只改 bottom', () => {
  const area = ruleOf(CSS, '#toast-area');
  assert.ok(area, 'styles.css 必须有 #toast-area 规则');
  assert.match(area, /display:\s*flex;/, '播报区照旧是 flex 容器（toast 堆叠方向不变）');
  for (const pattern of [/display:\s*none/, /visibility:\s*hidden/, /content-visibility:\s*hidden/]) {
    assert.equal(pattern.test(area), false, `播报区不能被 ${pattern.source} 藏掉（藏掉的 live region 不播报）`);
  }
  // 朗读条开着时的抬起规则只动 bottom，不许顺手把区域藏起来
  const lifted = ruleOf(CSS, 'body:has(#tts-bar:not(.hidden)) #toast-area');
  assert.ok(lifted, '朗读条抬起规则必须还在（拍板 #6）');
  assert.match(lifted, /bottom:\s*var\(--tts-toast-lift,\s*184px\);/);
  assert.equal(/display:|visibility:/.test(lifted), false, '抬起规则只管位置，不许改可见性');
});

test('toast() 用 textContent 写文案、只往区域里追加一条（不重建播报区）', () => {
  const at = RENDERER.indexOf('function toast(message, kind = \'info\') {');
  assert.ok(at > 0, 'renderer.js 里必须有 toast()');
  const body = RENDERER.slice(at, RENDERER.indexOf('\n  }', at));
  assert.match(body, /const area = \$\('toast-area'\);/, 'toast 必须往 #toast-area 里放');
  assert.match(body, /el\.textContent = message;/, '文案用 textContent 写（插进 DOM 的文本才会被播报）');
  assert.match(body, /area\.appendChild\(el\);/, '只追加一条（清空重建会把播报区一起冲掉）');
  assert.equal(/\.innerHTML\s*=/.test(body), false, 'toast 不许改写区域 innerHTML');
  assert.equal(/aria-hidden/.test(body), false, 'toast 条目不许挂 aria-hidden');
});
