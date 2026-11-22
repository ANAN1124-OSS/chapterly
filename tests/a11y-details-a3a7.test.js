// B6 无障碍细节锚点（三审 4.2 的 A3 / A4 / A5 / A7）：
//   A3 五处只靠 placeholder 的输入框补 aria-label（书架搜索 / 查找 / 替换 / 跳章 / 通用询问框），
//      外加报告没点名但同族的正文编辑区；
//   A4 书卡「⋯」按钮的可访问名 + title 要覆盖菜单真实的 7 项（以前 title 只写 2 项、名字是「⋯」）；
//   A5 三个视图各一条视觉隐藏 h1（视图容器切 .hidden 时整棵子树退出无障碍树，所以任意时刻只有一条）；
//   A7 保守方案：不给三个右键菜单挂 role="menu"，只把纯图标「×」按钮补可访问名 + 已知限制写明取舍。
// 这些都是「机器清单 / 结构形状」类断言（T7 方向）：钉住 HTML / 渲染层里的声明与真实菜单条数，
// 不钉整段代码形状；行为面由动态 a11y 门禁（目标尺寸 / 焦点遮挡）+ 真实读屏手测覆盖。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
const BOOKINFO = fs.readFileSync(path.join(ROOT, 'renderer', 'bookinfo-ui.js'), 'utf8');
const LIMITS = fs.readFileSync(path.join(ROOT, 'docs', '已知限制.md'), 'utf8');

// 取一个元素标签的完整开标签（id 是唯一锚点，比按行号找稳）。
function openTagOf(id) {
  const hit = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(HTML);
  assert.ok(hit, `index.html 必须有 #${id}`);
  return hit[0];
}

test('A3：五处只靠 placeholder 的输入框都有可访问名（外加正文编辑区）', () => {
  // 报告点名的 5 处：书架搜索 / 查找 / 替换 / 跳章 / 通用询问框。
  const IDS = ['shelf-search', 'find-query', 'find-replace', 'jump-input', 'modal-input', 'editor'];
  for (const id of IDS) {
    const tag = openTagOf(id);
    const named = /aria-label="[^"]+"/.test(tag) || /aria-labelledby="[^"]+"/.test(tag);
    assert.ok(named, `#${id} 不能只靠 placeholder：要给 aria-label 或 aria-labelledby`);
    // placeholder 仍留着（鼠标用户的提示不该被删掉）；#modal-input 的占位文案是运行时按这框的
    // opts.input.placeholder 写的，静态 HTML 里本来就没有。
    if (id !== 'modal-input') assert.match(tag, /placeholder="/, `#${id} 的 placeholder 提示要保留`);
  }
  // 通用询问框没有固定占位文案：名字跟着当前这框的标题走（同一条 modal-title）
  assert.match(openTagOf('modal-input'), /aria-labelledby="modal-title"/);
  // 对照已有的正确做法：章节筛选 / 设置搜索都是 aria-label（这几条是「别改坏」的对照组）
  assert.match(openTagOf('chapter-filter'), /aria-label="[^"]+"/);
  assert.match(openTagOf('settings-search'), /aria-label="[^"]+"/);
});

test('A4：书卡「⋯」有可访问名，title 覆盖菜单真实条数（不再只写 2 项）', () => {
  // 可访问名：不能再是「⋯」本身，要能读成「更多操作《书名》」
  assert.match(
    BOOKINFO,
    /more\.setAttribute\('aria-label',\s*`更多操作：《\$\{book\.title\}》`\)/,
    '「⋯」按钮必须给 aria-label（含书名，书架里才分得清是哪本书）'
  );
  // title：把文案里括号中的项目逐项数出来，与 #book-menu 里真实的 data-action 按钮数对拍。
  const titleHit = /more\.title\s*=\s*'更多操作（([^']+)）'/.exec(BOOKINFO);
  assert.ok(titleHit, '「⋯」的 title 必须写成「更多操作（…）」的形状，便于与真实菜单对拍');
  const described = titleHit[1]
    .split(' / ')
    .map((item) => item.trim())
    .filter(Boolean);
  const menu = /<div id="book-menu"[\s\S]*?\n  <\/div>/.exec(HTML);
  assert.ok(menu, 'index.html 必须有 #book-menu');
  const actions = [...menu[0].matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(actions.length, 7, `#book-menu 实际有 7 项（实测 ${actions.join('/')}）——菜单增减要同步 title`);
  assert.equal(
    described.length,
    actions.length,
    `「⋯」title 列了 ${described.length} 项，菜单实际 ${actions.length} 项：{${described.join(' / ')}} vs {${actions.join(' / ')}}`
  );
  // 旧文案（只写「打开文件夹 / 删除」）不许回潮
  assert.equal(BOOKINFO.includes("更多操作（打开文件夹 / 删除）"), false, 'title 还原成旧的 2 项文案了');
});

test('A5：三个视图各一条视觉隐藏 h1，且 .visually-hidden 真的「隐藏但仍进无障碍树」', () => {
  const h1s = [...HTML.matchAll(/<h1 class="visually-hidden">([^<]+)<\/h1>/g)].map((match) => match[1]);
  assert.deepEqual(h1s, ['章回 · 书架', '章回 · 写作页', '章回 · 阅读模式'], '三个视图各一条 h1，文案是「章回 · 视图名」');
  // 每条 h1 必须在对应视图容器里（容器切 .hidden 时它跟着退出无障碍树 → 任意时刻只有一条可见标题）
  const views = [
    ['shelf-view', '章回 · 书架'],
    ['editor-view', '章回 · 写作页'],
    ['reading-view', '章回 · 阅读模式']
  ];
  for (const [view, title] of views) {
    const start = HTML.indexOf(`id="${view}"`);
    assert.ok(start > 0, `index.html 必须有 #${view}`);
    const nextView = HTML.indexOf('<section id="', start + 10);
    const segment = HTML.slice(start, nextView > 0 ? nextView : HTML.length);
    assert.ok(segment.includes(`<h1 class="visually-hidden">${title}</h1>`), `#${view} 里缺 h1「${title}」`);
  }
  // 模态里的二级标题不许被顺手升级成 h1（层级要一以贯之：页面 1 条 h1，弹层用 h2）
  assert.equal((HTML.match(/<h1\b/g) || []).length, 3, '全文件只许这 3 条 h1');
  // 类本身：不能是 display:none / visibility:hidden（那会把节点摘出无障碍树，等于没加）
  const rule = /\.visually-hidden \{([\s\S]*?)\}/.exec(CSS);
  assert.ok(rule, 'styles.css 必须有 .visually-hidden');
  assert.match(rule[1], /position:\s*absolute/);
  assert.match(rule[1], /clip-path:\s*inset\(50%\)/);
  assert.equal(/display:\s*none|visibility:\s*hidden/.test(rule[1]), false, '.visually-hidden 不许用把节点摘出无障碍树的写法');
});

test('A7：纯图标「×」按钮都有可访问名；菜单不挂 role=menu 是有意取舍并写进已知限制', () => {
  // 全文件里内容只有「×」的按钮：每个都要 aria-label（对照 #btn-clear-filter 的正确做法）
  const times = [...HTML.matchAll(/<button\b[^>]*>×<\/button>/g)].map((match) => match[0]);
  assert.ok(times.length >= 4, `「×」按钮至少 4 个（实测 ${times.length}）`);
  for (const tag of times) {
    assert.match(tag, /aria-label="[^"]+"/, `只显示「×」的按钮必须有 aria-label：${tag.slice(0, 90)}`);
  }
  // 保守方案：三个右键菜单容器仍不挂 role=menu（挂上要整套 menuitem / 方向键语义，见已知限制）
  for (const id of ['context-menu', 'volume-menu', 'book-menu']) {
    assert.equal(new RegExp(`id="${id}"[^>]*role="menu"`).test(HTML), false, `#${id} 不该顺手挂 role="menu"（要挂就整套做）`);
  }
  // 已知限制里那句「有意只补键盘通道」要留着，并提到这一轮复核（别哪天被当成漏项又去补半套语义）
  assert.match(LIMITS, /菜单\*\*没有挂 `role="menu"`/, '已知限制要保留「菜单没挂 role=menu」的现状声明');
  assert.match(LIMITS, /三审 A7 复核后维持这一取舍/, '已知限制要写明这一取舍在 A7 复核后维持');
});
