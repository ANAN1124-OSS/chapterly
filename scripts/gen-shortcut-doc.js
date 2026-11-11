'use strict';
// 系统键文档生成器（1.6.0 F4a）。
//
// 为什么要有这个脚本：`?` 页与 README 的「系统键」表必须是同一份数据，否则加一个快捷键
// 就要在两边各改一次、迟早对不上。声明表只有 renderer/command-catalog.js 的 SYSTEM_KEYS
// 一份，这个脚本把它渲染成 README 里的 markdown 表（两个标记之间）。
//
// 用法：
//   node scripts/gen-shortcut-doc.js --check   # 只校验：README 与模块不一致 → 退出 1（单测口径）
//   node scripts/gen-shortcut-doc.js --write   # 重写 README 两个标记之间的表
//
// 只读 / 只写 README 这一个文件，不碰配置、不碰书库、零依赖。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const START_MARK = '<!-- system-keys:start -->';
const END_MARK = '<!-- system-keys:end -->';

// markdown 单元格里的竖线要转义（键位里目前没有，但别让以后加的文案把表拆坏）。
function cell(text) {
  return String(text == null ? '' : text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function renderSystemKeyTable(keys) {
  const rows = keys.map((key) => `| \`${cell(key.kbd)}\` | ${cell(key.title)} | ${cell(key.scope)} |`);
  return ['| 键位 | 作用 | 生效范围 |', '| --- | --- | --- |', ...rows].join('\n');
}

function readReadme() {
  return fs.readFileSync(README, 'utf8');
}

// README 里两个标记之间的表格（去掉标记后的第一个换行；换行统一成 \n 再比）。
function readTableFromReadme(text) {
  const startAt = text.indexOf(START_MARK);
  const endAt = text.indexOf(END_MARK);
  if (startAt < 0 || endAt < 0 || endAt < startAt) {
    throw new Error(`README.md 缺系统键表标记（${START_MARK} … ${END_MARK}）`);
  }
  return text
    .slice(startAt + START_MARK.length, endAt)
    .replace(/^\r?\n/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '');
}

function expectedTable() {
  const catalog = require(path.join(ROOT, 'renderer', 'command-catalog.js'));
  if (!Array.isArray(catalog.SYSTEM_KEYS)) throw new Error('命令目录没有导出 SYSTEM_KEYS');
  return renderSystemKeyTable(catalog.SYSTEM_KEYS);
}

// 两个标记之间的旧表 → 新表；保持文件原有的换行风格（README 是 CRLF）。
function replaceTable(text, table) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const startAt = text.indexOf(START_MARK);
  const endAt = text.indexOf(END_MARK);
  if (startAt < 0 || endAt < 0 || endAt < startAt) {
    throw new Error(`README.md 缺系统键表标记（${START_MARK} … ${END_MARK}）`);
  }
  const body = eol + table.split('\n').join(eol) + eol;
  return text.slice(0, startAt + START_MARK.length) + body + text.slice(endAt);
}

function main(argv) {
  const wantWrite = argv.includes('--write');
  const text = readReadme();
  const expected = expectedTable();
  const actual = readTableFromReadme(text);
  if (actual === expected) {
    console.log(`系统键表一致（${expected.split('\n').length - 2} 条）`);
    return 0;
  }
  if (!wantWrite) {
    console.error('系统键表与 renderer/command-catalog.js 的 SYSTEM_KEYS 不一致：');
    console.error('  跑 node scripts/gen-shortcut-doc.js --write 重新生成');
    return 1;
  }
  fs.writeFileSync(README, replaceTable(text, expected));
  console.log('已重写 README 系统键表');
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exitCode = 2;
  }
}

module.exports = {
  START_MARK,
  END_MARK,
  renderSystemKeyTable,
  readTableFromReadme,
  replaceTable
};