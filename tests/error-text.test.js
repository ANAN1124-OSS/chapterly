// 错误文案脱敏（v0.9 C-4，安全审计 C5）：
// 主进程回给界面 / 写进本机日志的错误文案不许带本机绝对路径（用户名、书架上级目录、
// 章节文件所在书的完整位置），常见文件系统错误码要换成中文，控制字符与超长文本要收掉。
// 这里把 core/error-text.js 的规则逐条钉住，并用静态闸门防止以后又写出 `${err.message}` 直通界面。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const errorText = require('../core/error-text');

const { redactPaths, maskPath, cleanText, cleanCode, fsErrorDetail, describeForUi, FS_CODE_TEXT, sanitizeFailureReport } = errorText;
const ROOT = path.join(__dirname, '..');

// 一份真实形状的 Node 文件系统错误（message 里带完整路径，和实测一致）
function fsError(code, text, filePath) {
  return Object.assign(new Error(`${code}: ${text}, open '${filePath}'`), { code });
}

test('错误脱敏：Windows 盘符路径只留最后一节（反斜杠 / 正斜杠都认）', () => {
  assert.equal(
    redactPaths("ENOENT: no such file or directory, open 'D:\\我的小说\\斗罗\\0001-第1章.txt'"),
    "ENOENT: no such file or directory, open '…\\0001-第1章.txt'"
  );
  assert.equal(
    redactPaths("EPERM: operation not permitted, open 'C:/Users/uid72/AppData/Roaming/x.txt'"),
    "EPERM: operation not permitted, open '…/x.txt'"
  );
  // 只剩盘符根：仍然收成一个省略号，不把盘符放出去
  assert.equal(redactPaths('C:\\'), '…');
  assert.equal(redactPaths("'c:\\Users'"), "'…\\Users'");
});

test('错误脱敏：UNC / 设备前缀 / file:// / POSIX 绝对路径都收掉，相对路径与 URL 不动', () => {
  assert.equal(redactPaths("scandir '\\\\?\\C:\\Users\\uid72\\Desktop\\书'"), "scandir '…\\书'");
  assert.equal(redactPaths('UNC \\\\server\\share\\folder\\a.txt 后面还有字'), 'UNC …\\a.txt 后面还有字');
  assert.equal(
    redactPaths('file:///C:/Users/uid72/AppData/Roaming/logs/chapter-writer-2026-11-01.log'),
    '…/chapter-writer-2026-11-01.log'
  );
  assert.equal(redactPaths('POSIX /home/user/novel/ch1.txt 结尾'), 'POSIX …/ch1.txt 结尾');
  // 相对路径、单个斜杠、网址、中文分隔都不动
  assert.equal(redactPaths('相对路径 0001-第1章.txt 与 sub\\x.txt 不动'), '相对路径 0001-第1章.txt 与 sub\\x.txt 不动');
  assert.equal(redactPaths('a/b 不动；UTF-8 / UTF-16 / GBK 不动'), 'a/b 不动；UTF-8 / UTF-16 / GBK 不动');
  const url = 'https://github.com/ANAN1124-OSS/chapterly/releases';
  assert.equal(redactPaths(`打不开下载页 ${url}`), `打不开下载页 ${url}`);
});

test('错误脱敏：一句话里有多条路径时每一条都收；行号后缀保留', () => {
  const text = "D:\\书\\a.txt 与 C:\\Temp\\b.txt 都失败了";
  assert.equal(redactPaths(text), '…\\a.txt 与 …\\b.txt 都失败了');
  assert.equal(
    redactPaths('章节文件不可写：D:\\书\\001-第1章.txt（只读）'),
    '章节文件不可写：…\\001-第1章.txt（只读）'
  );
  // 栈行：保留最后一节，行号列号原样跟在后面（日志里仍看得出是哪一行出的错）
  assert.equal(redactPaths('at foo (D:\\code\\chapter-writer\\core\\storage.js:395:11)'), 'at foo (…\\storage.js:395:11)');
  assert.equal(
    redactPaths('at foo (D:\\code\\chapter-writer\\core\\storage.js:395:11)', { keep: 2 }),
    'at foo (…\\core\\storage.js:395:11)'
  );
});

test('错误脱敏：keep 参数（保留最后几节）与坏输入兜底', () => {
  const text = 'D:\\我的小说\\斗罗\\0001-第1章.txt';
  assert.equal(redactPaths(text), '…\\0001-第1章.txt');
  assert.equal(redactPaths(text, { keep: 2 }), '…\\斗罗\\0001-第1章.txt');
  assert.equal(redactPaths(text, { keep: 0 }), '…\\0001-第1章.txt');
  assert.equal(redactPaths(text, { keep: -3 }), '…\\0001-第1章.txt');
  // keep 最多认 3 节（再大也不会有意义），盘符根不算一节
  assert.equal(redactPaths(text, { keep: 999 }), '…\\我的小说\\斗罗\\0001-第1章.txt');
  // 坏参数不抛错，按默认（最后一节）处理
  for (const bad of [null, undefined, {}, [], { keep: 'x' }, { keep: NaN }, { keep: -3 }]) {
    assert.equal(redactPaths(text, bad), '…\\0001-第1章.txt');
  }
  assert.equal(redactPaths(null), '');
  assert.equal(redactPaths(undefined), '');
  assert.equal(redactPaths(42), '42');
  assert.equal(redactPaths({ toString() { return 'D:\\x\\y.txt'; } }), '…\\y.txt');
  assert.equal(maskPath('D:\\a\\b\\c.txt'), '…\\c.txt');
  assert.equal(maskPath('/home/u/c.txt'), '…/c.txt');
  assert.equal(maskPath(''), '…');
});

test('错误脱敏：控制字符 / 换行 / 超长文本收成一屏能看的单行', () => {
  assert.equal(cleanText('a\u0000b\u0007c'), 'abc');
  assert.equal(cleanText('第一行\r\n第二行\t带制表符'), '第一行 第二行 带制表符');
  assert.equal(cleanText('   '), '');
  assert.equal(cleanText(null), '');
  const long = '错'.repeat(400);
  const clipped = cleanText(long);
  assert.ok(clipped.length > errorText.MAX_MESSAGE_CHARS);
  assert.ok(clipped.startsWith('错'.repeat(errorText.MAX_MESSAGE_CHARS)));
  assert.match(clipped, /…\[已截断 100 字\]$/);
  // 自定义上限也认（≤ 0 / 非数字回落默认）
  assert.equal(cleanText('abcdef', 3), 'abc…[已截断 3 字]');
  assert.equal(cleanText('abcdef', 0).length, 6);
});

test('错误脱敏：常见文件系统错误码换成中文，路径只留最后一节', () => {
  const enoent = describeForUi(fsError('ENOENT', 'no such file or directory', 'D:\\我的小说\\斗罗\\0001-第1章.txt'));
  assert.equal(enoent.code, 'ENOENT');
  assert.equal(enoent.message, '找不到文件或目录：…\\0001-第1章.txt');
  assert.equal(enoent.message.includes('D:\\'), false);
  assert.equal(enoent.message.includes('我的小说'), false);

  const eperm = describeForUi(fsError('EPERM', 'operation not permitted', 'C:\\Users\\uid72\\AppData\\书\\001.txt'));
  assert.equal(eperm.code, 'EPERM');
  assert.match(eperm.message, /^操作被系统拒绝/);
  assert.match(eperm.message, /…\\001\.txt$/);
  assert.equal(eperm.message.includes('uid72'), false);

  // 没有 code 只有 `ENOENT: …` 形状的 message 也能认出错误码
  const inferred = describeForUi(new Error("ENOENT: no such file or directory, scandir 'D:\\我的小说'"));
  assert.equal(inferred.code, 'ENOENT');
  assert.equal(inferred.message, '找不到文件或目录：…\\我的小说');
  // 表里的每个码都能给出一句中文（不留英文原文）
  for (const [code, text] of Object.entries(FS_CODE_TEXT)) {
    const described = describeForUi(Object.assign(new Error(`${code}: boom, write`), { code }));
    assert.equal(described.code, code);
    assert.equal(described.message, text);
  }
});

test('错误脱敏：自定义错误码与中文原文照旧（自研 StorageError 的提示不能被改写）', () => {
  const cases = [
    ['CHAPTER_MISSING', '章节文件不存在：0001-第1章.txt'],
    ['ROOT_UNREADABLE', '书架目录无法读取：找不到文件或目录：…\\我的小说'],
    ['FILE_TOO_LARGE', '《超大书.txt》有 128.0 MB，超过单本导入上限 128 MB，已跳过'],
    ['NOT_TEXT', '《二进制书.txt》不像是纯文本（检测到二进制内容），已跳过']
  ];
  for (const [code, message] of cases) {
    const described = describeForUi(Object.assign(new Error(message), { code }));
    assert.equal(described.code, code);
    assert.equal(described.message, message);
  }
  // 自定义错误码里万一藏了路径，照样收掉（防手滑把路径拼进提示）
  const described = describeForUi(
    Object.assign(new Error('打开失败：D:\\我的小说\\斗罗'), { code: 'OPEN_FAILED' })
  );
  assert.equal(described.message, '打开失败：…\\斗罗');
});

test('错误脱敏：坏错误对象 / 非错误值都给出可显示的结果，不抛错', () => {
  assert.deepEqual(describeForUi(null), { code: 'ERROR', message: '未知错误' });
  assert.deepEqual(describeForUi(undefined), { code: 'ERROR', message: '未知错误' });
  assert.deepEqual(describeForUi(''), { code: 'ERROR', message: '未知错误' });
  assert.deepEqual(describeForUi('纯字符串原因'), { code: 'ERROR', message: '纯字符串原因' });
  assert.deepEqual(describeForUi({ code: 5, message: '数字码' }), { code: '5', message: '数字码' });
  // code 不合白名单 → ERROR（不把奇怪字符带进界面 / 日志）
  assert.equal(describeForUi({ code: 'CODE WITH SPACE', message: 'x' }).code, 'ERROR');
  assert.equal(describeForUi({ code: '<script>', message: 'x' }).code, 'ERROR');
  assert.equal(cleanCode('A'.repeat(80)).length, 40);
  assert.equal(cleanCode('  '), '');
  // 读 message 抛错的奇怪对象：不崩
  const evil = { code: 'X', get message() { throw new Error('nope'); } };
  assert.deepEqual(describeForUi(evil), { code: 'X', message: '[无法读取的错误信息]' });
});

test('错误脱敏：fsErrorDetail 只认带分隔符的路径（普通引号内容不误判）', () => {
  assert.equal(fsErrorDetail("ENOENT: no such file or directory, open 'D:\\书\\a.txt'"), '…\\a.txt');
  assert.equal(fsErrorDetail("ENOENT: no such file or directory, open 'a.txt'"), '');
  assert.equal(fsErrorDetail("ENOENT: boom, open '章节文件'"), '');
  assert.equal(fsErrorDetail('，第 3 章'), '');
  assert.equal(fsErrorDetail(''), '');
  assert.equal(fsErrorDetail(null), '');
});

test('错误脱敏：渲染层失败上报只收 kind / code / message 三个短字符串，路径与超长文本都收掉', () => {
  const KINDS = new Set(['unhandledrejection', 'ui-chain']);
  // 正常形状：路径只留最后一节，kind / code 原样过白名单
  assert.deepEqual(
    sanitizeFailureReport(
      {
        kind: 'ui-chain',
        code: 'ENOENT',
        message: "ENOENT: no such file or directory, open 'D:\\我的小说\\斗罗\\0001-第1章.txt'"
      },
      KINDS
    ),
    { kind: 'ui-chain', code: 'ENOENT', message: "ENOENT: no such file or directory, open '…\\0001-第1章.txt'" }
  );
  // kind 不在白名单 / 大小写不符 / 空 → null（日志里只许出现约定好的 few 种 kind）
  assert.equal(sanitizeFailureReport({ kind: 'boom', code: 'X', message: 'x' }, KINDS), null);
  assert.equal(sanitizeFailureReport({ kind: 'UNHANDLEDREJECTION', code: 'X', message: 'x' }, KINDS), null);
  assert.equal(sanitizeFailureReport({ kind: '', code: 'X', message: 'x' }, KINDS), null);
  // 形状不合法 → null（不抛错：上报失败不该反过来干扰渲染层）
  for (const bad of [null, undefined, 'text', 42, [], [1, 2]]) {
    assert.equal(sanitizeFailureReport(bad, KINDS), null);
  }
  // 白名单本身不合法 → 一律 null（宁可不记，也不放任意 kind 进日志）
  assert.equal(sanitizeFailureReport({ kind: 'ui-chain', code: 'X', message: 'x' }, null), null);
  assert.equal(sanitizeFailureReport({ kind: 'ui-chain', code: 'X', message: 'x' }, []), null);
  // code / message 都不合法时没有可记的东西 → null；只有一个可记就照记
  assert.equal(sanitizeFailureReport({ kind: 'ui-chain', code: 'CODE WITH SPACE', message: '' }, KINDS), null);
  assert.deepEqual(sanitizeFailureReport({ kind: 'ui-chain', code: '', message: '窗口正在销毁' }, KINDS), {
    kind: 'ui-chain',
    code: '',
    message: '窗口正在销毁'
  });
  // code 走字符白名单（与 describeForUi 同口径）、message 收控制字符与超长
  const long = sanitizeFailureReport({ kind: 'ui-chain', code: 'A'.repeat(80), message: `前\u0000后 ${'字'.repeat(400)}` }, KINDS);
  assert.equal(long.code.length, 40);
  assert.equal(long.message.includes('\u0000'), false);
  assert.ok(long.message.length <= 320, '按 cleanText 的上限截断');
  // 数字 code 会被 safeString 收成字符串（与 describeForUi 同口径），字符不合法才丢
  assert.deepEqual(sanitizeFailureReport({ kind: 'ui-chain', code: 5, message: '' }, KINDS), {
    kind: 'ui-chain',
    code: '5',
    message: ''
  });
});

test('错误脱敏静态闸门：main.js 的 IPC 失败出口走 error-text，全部 core 不许把 err.message 直接拼给界面', () => {
  const mainText = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const failBody = mainText.slice(mainText.indexOf('function fail(err, channel)'));
  const failEnd = failBody.indexOf('\n}\n');
  const body = failBody.slice(0, failEnd === -1 ? 1200 : failEnd);
  // 回给渲染层的 code / message 必须来自 errorText.describeForUi（原始 err.message 只许进日志）
  assert.match(body, /errorText\.describeForUi\(err\)/);
  assert.match(body, /return \{ ok: false, code: described\.code, message: described\.message \};/);
  assert.equal(body.includes('err.message'), false);

  // 回归闸门：core 里再出现 `${err.message}` 这种直通字符串就红（本轮修掉的几处都是这个形状）
  const risky = /`[^`]*\$\{(?:err|e|error)\.message\}[^`]*`/;
  const offenders = [];
  for (const name of fs.readdirSync(path.join(ROOT, 'core'))) {
    if (!name.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(ROOT, 'core', name), 'utf8');
    if (risky.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);

  // 日志侧：message / stack 都必须过红actPaths（正文遮罩之外再收一层路径）
  const logsText = fs.readFileSync(path.join(ROOT, 'core', 'logs.js'), 'utf8');
  assert.match(logsText, /errorText\.redactPaths\(text\)/);
  assert.match(logsText, /errorText\.redactPaths\(maskLongCjk\(line\), \{ keep: 2 \}\)/);
});

test('错误脱敏静态闸门：notifyInternalError 的控制台输出走 describeForUi（B2 / S5）', () => {
  const mainText = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = mainText.indexOf('function notifyInternalError(kind, err) {');
  assert.notEqual(start, -1, 'main.js 里仍要有 notifyInternalError');
  const rest = mainText.slice(start);
  const end = rest.indexOf('// B1（审计 E2 / E6）');
  assert.notEqual(end, -1, '找不到 notifyInternalError 的结束锚点');
  const body = rest.slice(0, end);

  // 终端那行必须用 error-text 的脱敏文案（与 fail() 同一口径）：fs 错误的 message 里带完整绝对路径，
  // 直接打 described.message 等于把用户名 / 书库位置丢进控制台与日志采集。
  assert.match(body, /const shown = errorText\.describeForUi\(err\);/, '控制台文案必须先过 describeForUi');
  const consoleAt = body.indexOf('console.error(');
  assert.notEqual(consoleAt, -1, '控制台留痕入口不能消失（终端里仍要能看出出了哪种错）');
  const consoleLine = body.slice(consoleAt, body.indexOf(');', consoleAt) + 2);
  assert.match(consoleLine, /shown\.message/, 'console.error 必须打 describeForUi 的 message');
  assert.equal(
    consoleLine.includes('described.message'),
    false,
    '不许把 logsLib.describeError 的原始 message 打到控制台（fs 错误会带完整绝对路径）'
  );
  // 日志侧 / 界面广播口径不许跟着改：logError 仍收原始错误（core/logs.js 自己遮罩），
  // 广播仍只用 INTERNAL_ERROR_TEXT 的固定文案（细节只进日志）。
  assert.match(body, /logError\(kind, err\)/, '日志侧仍走原始错误，由 core/logs.js 脱敏');
  assert.match(body, /message: INTERNAL_ERROR_TEXT\[kind\]/, '界面广播仍是固定文案，不回传错误细节');
});
