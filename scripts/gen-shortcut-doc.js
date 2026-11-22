'use strict';
// 系统键文档生成器（1.6.0 F4a；三审 D14 起同时维护 README 与 docs/使用手册.md）。
//
// 为什么要有这个脚本：`?` 页与 README / 使用手册的「系统键」表必须是同一份数据，否则加一个
// 快捷键就要在几处各改一次、迟早对不上。声明表只有 renderer/command-catalog.js 的 SYSTEM_KEYS
// 一份，这个脚本把它渲染成两个文档里的 markdown 表（各自两个标记之间）。
//
// 用法：
//   node scripts/gen-shortcut-doc.js --check   # 只校验：两份文档与模块不一致 → 退出 1（单测口径）
//   node scripts/gen-shortcut-doc.js --write   # 重写两份文档标记之间的表
//
// 只读 / 只写这两个文档，不碰配置、不碰书库、零依赖。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 三审 D14：使用手册里「系统键」标题后面原本只有一句说明、没有表（「标题冒号后无表」），
// 而且它承诺「单测会校验没有漂移」。现在两份文档共用同一张生成表 + 同一个单测锚点。
const DOC_FILES = [
  { label: 'README.md', path: path.join(ROOT, 'README.md') },
  { label: 'docs/使用手册.md', path: path.join(ROOT, 'docs', '使用手册.md') }
];
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

// 指定文档里两个标记之间的表格（去掉标记后的第一个换行；换行统一成 \n 再比）。
function readTableFromFile(text, label) {
  const startAt = text.indexOf(START_MARK);
  const endAt = text.indexOf(END_MARK);
  if (startAt < 0 || endAt < 0 || endAt < startAt) {
    throw new Error(`${label} 缺系统键表标记（${START_MARK} … ${END_MARK}）`);
  }
  return text
    .slice(startAt + START_MARK.length, endAt)
    .replace(/^\r?\n/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '');
}

function readTableFromReadme(text) {
  return readTableFromFile(text, 'README.md');
}

function expectedTable() {
  const catalog = require(path.join(ROOT, 'renderer', 'command-catalog.js'));
  if (!Array.isArray(catalog.SYSTEM_KEYS)) throw new Error('命令目录没有导出 SYSTEM_KEYS');
  return renderSystemKeyTable(catalog.SYSTEM_KEYS);
}

// 两个标记之间的旧表 → 新表；保持文件原有的换行风格（README / 使用手册都是 CRLF）。
function replaceTableInFile(text, table, label) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const startAt = text.indexOf(START_MARK);
  const endAt = text.indexOf(END_MARK);
  if (startAt < 0 || endAt < 0 || endAt < startAt) {
    throw new Error(`${label} 缺系统键表标记（${START_MARK} … ${END_MARK}）`);
  }
  const body = eol + table.split('\n').join(eol) + eol;
  return text.slice(0, startAt + START_MARK.length) + body + text.slice(endAt);
}

function replaceTable(text, table) {
  return replaceTableInFile(text, table, 'README.md');
}

function main(argv) {
  const wantWrite = argv.includes('--write');
  const expected = expectedTable();
  let failed = false;
  for (const file of DOC_FILES) {
    const text = fs.readFileSync(file.path, 'utf8');
    const actual = readTableFromFile(text, file.label);
    if (actual === expected) {
      console.log(`${file.label} 系统键表一致（${expected.split('\n').length - 2} 条）`);
      continue;
    }
    if (!wantWrite) {
      console.error(`${file.label} 的系统键表与 renderer/command-catalog.js 的 SYSTEM_KEYS 不一致：`);
      console.error('  跑 node scripts/gen-shortcut-doc.js --write 重新生成');
      failed = true;
      continue;
    }
    fs.writeFileSync(file.path, replaceTableInFile(text, expected, file.label));
    console.log(`已重写 ${file.label} 系统键表`);
  }
  return failed ? 1 : 0;
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
  DOC_FILES,
  renderSystemKeyTable,
  readTableFromFile,
  readTableFromReadme,
  replaceTableInFile,
  replaceTable
};
