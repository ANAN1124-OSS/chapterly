// C6（审计小额纵深 S6/S7/S8/E13/E14）：各自小改 + 静态闸门。
//
// 六处都是「纵深防御」，不改正常行为：
//   · atomic 临时文件用 'wx'（不覆盖任何已存在的文件）；
//   · importer 暂存目录不带 recursive（撞名就失败，不悄悄复用）；
//   · shell:open-book-folder 先 stat 确认目录再交给系统打开；
//   · 启动 / 建窗失败走 logError（脱敏），不再 console.error 原始堆栈；
//   · 更新检查 net.fetch 不跟随重定向；
//   · 打包版不绑 Ctrl+Shift+I（开发 / E2E 照旧）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('main.js');

function between(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `找不到：${from}`);
  const end = source.indexOf(to, start + 1);
  assert.ok(end > start, `找不到结尾：${to}`);
  return source.slice(start, end);
}

test('C6：atomic 临时文件用 wx；importer 暂存目录不 recursive', () => {
  const atomic = read('core/atomic.js');
  assert.match(atomic, /handle = await fs\.open\(tmp, 'wx'\);/, '临时文件要用 wx 创建');
  assert.equal(atomic.includes("fs.open(tmp, 'w')"), false, '不许退回覆盖写');
  const importer = read('core/importer.js');
  assert.match(importer, /await fs\.mkdir\(booksRoot, \{ recursive: true \}\);/, '书架根目录允许首次创建');
  assert.match(importer, /await fs\.mkdir\(staging\);/, '暂存目录要非 recursive 创建');
  assert.equal(importer.includes('fs.mkdir(staging, { recursive: true })'), false, '暂存目录不许带 recursive');
});

test('C6：open-book-folder 先确认目录；启动错误走 logError（脱敏，不打原始堆栈）', () => {
  const openSrc = between(MAIN, "handleBook('shell:open-book-folder'", '\n  });');
  assert.match(openSrc, /const stat = await fs\.stat\(bookPath\);/, '先 stat');
  assert.match(openSrc, /stat\.isDirectory\(\)/, '必须是目录');
  assert.match(openSrc, /NOT_A_DIRECTORY/, '非目录要明确报错');
  const statAt = openSrc.indexOf('stat.isDirectory()');
  const openPathAt = openSrc.indexOf('shell.openPath(');
  assert.ok(statAt > 0 && openPathAt > statAt, '先 stat 再 openPath');

  // 启动期三处 console.error(原始错误 / 堆栈) 已换成 logError
  assert.equal(MAIN.includes("console.error('[config] 读取失败:'"), false);
  assert.equal(MAIN.includes("console.error('[window] 创建失败:'"), false);
  assert.equal(MAIN.includes("console.error('[window] 第二次启动建窗失败:'"), false);
  for (const kind of ['startup-config', 'startup-window', 'window-create']) {
    assert.ok(MAIN.includes(`logError('${kind}', err)`), `启动失败要走 logError('${kind}')`);
  }
});

test('C6：更新请求不跟随重定向；打包版不绑 DevTools 快捷键', () => {
  const fetchSrc = between(MAIN, 'async function fetchReleaseResponse(', '\n}');
  assert.match(fetchSrc, /redirect: 'error'/, '更新请求要拒绝重定向');
  const devtoolsSrc = between(MAIN, "browserWin.webContents.on('before-input-event'", '\n  });');
  assert.match(devtoolsSrc, /if \(packagedApp\) return;/, '打包版不绑 Ctrl+Shift+I');
  assert.match(devtoolsSrc, /toggleDevTools\(\)/, '开发 / E2E 仍可用');
});
