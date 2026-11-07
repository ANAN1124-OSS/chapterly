/* 大书章节栏渲染（v0.9 A-2，前端 / 大数据量体验 A2）的自检
 *
 * 这一轮只做两件低风险的事，都在渲染层显示逻辑里、不碰正文 / 书目 / IPC：
 *   1. `.chapter-item` 加 `content-visibility: auto` + `contain-intrinsic-size: auto 38px`：
 *      千章书整表重建时，屏幕外的条目连布局都跳过（基准 24.2ms → 12.x ms）；
 *      intrinsic 尺寸必须接近真实行高，否则滚动条 / 拖动落点会漂，所以两个属性一起钉。
 *   2. 切章只挪 active / dirty 两个 class（`syncActiveChapterItem`），不再整表重建 1000 条
 *      （基准切一章 48.3ms → 25~28ms）；列表和 state.chapters 对不上时（新建 / 删除 / 换书）
 *      靠条目上的 chapter id 认出失配、退回整表重建，行为与旧实现一致。
 *
 * 因此这里的闸门分两类：
 * - 静态闸门（行为在 E2E 第 63 组里真跑）：CSS 两个属性都在、intrinsic 值是 20–80px 的实数、
 *   列表用 DocumentFragment 一次性挂载、切章入口必须走 syncActiveChapterItem 而不是整表重建、
 *   快路径必须核对 chapter id 且带 scrollIntoView、失配时必须能退回 renderChapterList。
 * - 反回退闸门：syncActiveChapterItem 不许用 setTimeout / requestAnimationFrame 等被节流的时机
 *   （锁屏 / 窗口被遮挡时 Chromium 会节流它们，A-1 的基准已经踩过这个坑）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CSS_SOURCE = read('renderer/styles.css');
const RENDERER_SOURCE = read('renderer/renderer.js');

/** 去掉注释（保留字符串），静态闸门要看的是代码本身，不是注释里的说明 */
function stripComments(src) {
  let out = '';
  let mode = null; // null | "'" | '"' | '`' | '//' | '/*'
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === '//') {
      if (ch === '\n') {
        mode = null;
        out += ch;
      }
      continue;
    }
    if (mode === '/*') {
      if (ch === '*' && next === '/') {
        mode = null;
        i += 1;
      }
      continue;
    }
    if (mode) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] || '';
        i += 1;
        continue;
      }
      if (ch === mode) mode = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      mode = '//';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      mode = '/*';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') mode = ch;
    out += ch;
  }
  return out;
}

const RENDERER_CODE = stripComments(RENDERER_SOURCE);

/** 取一个顶层 function 的源码：从 `function 名字(` 到下一个同缩进的 function 声明为止 */
function functionSource(src, name) {
  const pattern = new RegExp(`(?:^|\\n)  (?:async )?function ${name}\\(`);
  const match = pattern.exec(src);
  assert.ok(match, `renderer.js 里找不到 function ${name}(`);
  const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
  const rest = src.slice(start + 1);
  const next = /\n  (?:async )?function [A-Za-z_$][\w$]*\(/.exec(rest);
  return next ? src.slice(start, start + 1 + next.index) : src.slice(start);
}

/** `.chapter-item { ... }` 规则体（第一个匹配，含换行） */
function cssRuleBody(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `styles.css 里找不到 ${selector} 规则`);
  const end = source.indexOf('}', start);
  assert.ok(end > start, `${selector} 规则没有收尾`);
  return source.slice(start, end + 1);
}

const chapterItemRule = cssRuleBody(CSS_SOURCE, '.chapter-item');
const renderChapterListSrc = functionSource(RENDERER_CODE, 'renderChapterList');
const syncActiveSrc = functionSource(RENDERER_CODE, 'syncActiveChapterItem');
const makeChapterItemSrc = functionSource(RENDERER_CODE, 'makeChapterItem');
const loadChapterAtSrc = functionSource(RENDERER_CODE, 'loadChapterAt');

test('CSS 闸门：章节条目跳过屏幕外渲染，intrinsic 尺寸接近真实行高（20–80px 的整数）', () => {
  assert.match(chapterItemRule, /content-visibility:\s*auto\s*;/, '.chapter-item 缺 content-visibility: auto');
  const intrinsic = /contain-intrinsic-size:\s*auto\s+(\d+)px\s*;/.exec(chapterItemRule);
  assert.ok(intrinsic, '.chapter-item 缺 contain-intrinsic-size: auto <N>px（只写 auto 会让屏幕外条目高度塌成 0）');
  const px = Number(intrinsic[1]);
  assert.ok(px >= 20 && px <= 80, `intrinsic 行高 ${px}px 不在 20–80 之间：与实际行高差太多会让滚动条 / 拖动落点漂`);
  assert.doesNotMatch(chapterItemRule, /content-visibility:\s*hidden/, '隐藏式跳过会让章节列表的键盘 / 查找都失效');
});

test('列表批量挂载：renderChapterList 先拼 DocumentFragment，再一次性 replaceChildren', () => {
  assert.match(renderChapterListSrc, /document\.createDocumentFragment\(\)/, 'renderChapterList 应该先离线拼装');
  assert.match(renderChapterListSrc, /list\.replaceChildren\(frag\)/, 'renderChapterList 应该一次性挂载');
});

test('列表批量挂载：renderChapterList 不再逐条 appendChild 到 live 列表上', () => {
  assert.doesNotMatch(renderChapterListSrc, /list\.appendChild\(/, '逐条 appendChild 到 live 容器会让千章书反复失效');
  const appends = renderChapterListSrc.match(/frag\.appendChild\(/g) || [];
  assert.ok(appends.length >= 4, `拼接应当都落在 frag 上（找到 ${appends.length} 处）`);
  // 当前章高亮仍然按 index 计算（整表重建时的行为不能变）——这一句在 makeChapterItem 里
  assert.match(makeChapterItemSrc, /index === state\.index/, '整表重建仍要按 index 标出当前章');
});

test('切章快路径：loadChapterAt 走 syncActiveChapterItem，不再整表重建', () => {
  assert.match(loadChapterAtSrc, /syncActiveChapterItem\(\)/, 'loadChapterAt 应该只同步当前章高亮');
  assert.doesNotMatch(loadChapterAtSrc, /renderChapterList\(\)/, 'loadChapterAt 里不许再整表重建名单');
});

test('切章快路径：核对 chapter id，失配 / 折叠卷里没有这一条时退回整表重建', () => {
  assert.match(syncActiveSrc, /dataset\.chapterId/, '快路径必须核对条目上的章节 id');
  assert.match(syncActiveSrc, /renderChapterList\(\)/, '失配时必须能退回整表重建');
  assert.match(syncActiveSrc, /scrollIntoView\(/, '当前章要滚进可视区（旧行为）');
  assert.match(syncActiveSrc, /classList\.remove\('active', 'dirty'\)/, '旧条目要同时摘掉 active / dirty');
  assert.match(syncActiveSrc, /classList\.toggle\('dirty'/, '新条目要按当前 dirty 状态标记');
});

test('切章快路径：条目上有 data-chapter-id（快路径核对用）', () => {
  assert.match(makeChapterItemSrc, /dataset\.chapterId\s*=\s*String\(chapter\.id/, 'makeChapterItem 要写 data-chapter-id');
});

test('反回退：切章时不许靠 setTimeout / requestAnimationFrame 这类会被节流的时机', () => {
  assert.doesNotMatch(syncActiveSrc, /setTimeout|setInterval|requestAnimationFrame/, '快路径必须同步完成');
});

// B5（审计 P5）：保存后只更新当前章这一条的字数，不再整表重建（千章书每次 Ctrl+S 都重建 1000 条）。
const saveCurrentSrc = functionSource(RENDERER_CODE, 'saveCurrent');
const syncCharsSrc = functionSource(RENDERER_CODE, 'syncChapterItemChars');
const syncCharsAfterSaveSrc = functionSource(RENDERER_CODE, 'syncChapterCharsAfterSave');

test('保存快路径：保存成功后走 syncChapterCharsAfterSave，失配才退回整表重建', () => {
  assert.match(
    saveCurrentSrc,
    /if \(!syncChapterCharsAfterSave\(state\.index\)\) renderChapterList\(\);/,
    '保存后要先走单条快路径（失配才 rebuild）'
  );
  // 成功路径里不许再有裸的 renderChapterList()（A7 的部分成功分支也走同一套快路径）
  const rebuilds = saveCurrentSrc.match(/renderChapterList\(\)/g) || [];
  assert.equal(rebuilds.length, 2, `saveCurrent 里 renderChapterList 只应作为两条快路径的兜底（找到 ${rebuilds.length} 处）`);
});

test('保存快路径：单条更新核对 data-index + chapter id，改字数节点与 tooltip，并顺带更新下一章的对比提示', () => {
  assert.match(syncCharsSrc, /\.chapter-item\[data-index="\$\{index\}"\]/, '要按 data-index 找当前条目');
  assert.match(syncCharsSrc, /dataset\.chapterId !== String\(chapter\.id/, '要核对章节 id（列表和章节数组失配就不能改）');
  assert.match(syncCharsSrc, /querySelector\('\.chapter-chars'\)/, '要复用已有字数节点');
  assert.match(syncCharsSrc, /editorLogic\.formatCharsShort\(chars\)/, '字数文本口径要和整表重建一致');
  assert.match(syncCharsSrc, /item\.title = chapterItemTitleText\(chapter, index\)/, 'tooltip 要跟着字数更新');
  assert.match(syncCharsAfterSaveSrc, /index \+ 1 < state\.chapters\.length/, '下一章的「比上章短」提示要跟着更新');
  // 复用同一套 tooltip 生成，别在快路径里抄一份（抄了就会两边漂）
  const titleSrc = functionSource(RENDERER_CODE, 'chapterItemTitleText');
  assert.match(titleSrc, /chapterItemTip\(chapter, index\)/);
  assert.match(functionSource(RENDERER_CODE, 'makeChapterItem'), /chapterItemTitleText\(chapter, index\)/);
});

