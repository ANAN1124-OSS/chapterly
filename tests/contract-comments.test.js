'use strict';
// 模块头 host 契约与 REQUIRED_HOST 对账（RSHE-A-04 / RPAN-C05 / RPAN-A-06）：
// 这些模块的头注释就是装配说明书；成员数写少、清单漏人或 REQUIRED_HOST 里有而清单没有，
// 按注释接线的调用者就会漏传（启动即 TypeError）。这里钉两件事：
//   ① 头注释声明的成员数 == REQUIRED_HOST.length；
//   ② REQUIRED_HOST 的每个成员名都出现在头注释里。
// 只扫「显式写了 host N 个成员」的模块（没有计数的模块不在本闸门范围）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

test('模块头 host 契约：成员数 == REQUIRED_HOST 长度，清单不漏成员', () => {
  let checked = 0;
  const files = fs.readdirSync(RENDERER_DIR).filter((name) => name.endsWith('.js')).sort();
  for (const name of files) {
    const source = fs.readFileSync(path.join(RENDERER_DIR, name), 'utf8').replace(/\r\n/g, '\n');
    const claimed = /host (?:正好 )?(\d+) 个成员/.exec(source);
    const requiredBlock = /const REQUIRED_HOST = \[([\s\S]*?)\];/.exec(source);
    if (!claimed || !requiredBlock) continue;
    checked += 1;
    const members = [...requiredBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    const headerEnd = source.indexOf('(function (root, factory)');
    assert.ok(headerEnd > 0, `${name}：要能定位模块头注释的结束`);
    const header = source.slice(0, headerEnd);
    assert.equal(
      claimed[1],
      String(members.length),
      `${name}：头注释写 ${claimed[1]} 个成员，REQUIRED_HOST 是 ${members.length} 个`
    );
    const missing = members.filter(
      (member) => !new RegExp(`(^|[^\\w$])${member.replace(/\$/g, '\\$')}([^\\w]|$)`).test(header)
    );
    assert.deepEqual(missing, [], `${name}：头注释的 host 清单漏了 ${missing.join(' / ')}`);
  }
  assert.ok(checked >= 10, `闸门要真的覆盖到声明成员数的模块（实际 ${checked} 个）`);
});
