const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_MATCHES,
  findMatches,
  findMatchesAll,
  countMatches,
  replaceAllLiteral,
  makeSnippet,
  findNextMatch
} = require('../core/find');

test('查找：字面量匹配、多个结果、中文与英文', () => {
  assert.deepEqual(findMatches('阿明说：阿明走了', '阿明').map((m) => m.index), [0, 4]);
  assert.equal(countMatches('aaa', 'aa'), 1, '不重叠匹配');
  assert.deepEqual(findMatches('Hello World', 'world'), [{ index: 6, length: 5 }], '默认不区分大小写');
  assert.deepEqual(findMatches('Hello World', 'world', { caseSensitive: true }), []);
  assert.deepEqual(findMatches('Hello World', 'World', { caseSensitive: true }), [{ index: 6, length: 5 }]);
  assert.deepEqual(findMatches('任意文本', ''), [], '空查询返回空');
  assert.deepEqual(findMatches('', '阿明'), []);
});

test('查找：不搞正则，特殊字符按字面量处理', () => {
  const text = '价格 3.14 元 (含税) [备注] a*b';
  assert.equal(countMatches(text, '3.14'), 1);
  assert.equal(countMatches(text, '(含税)'), 1);
  assert.equal(countMatches(text, '[备注]'), 1);
  assert.equal(countMatches(text, 'a*b'), 1);
  assert.equal(countMatches(text, '.*'), 0, '正则元字符不能当通配符');
});

test('替换：全部替换、保留原文其余内容、次数正确', () => {
  const res = replaceAllLiteral('阿明说：阿明走了。', '阿明', '小明');
  assert.equal(res.text, '小明说：小明走了。');
  assert.equal(res.count, 2);

  const none = replaceAllLiteral('没有命中', '阿明', '小明');
  assert.equal(none.text, '没有命中');
  assert.equal(none.count, 0);
});

test('替换：区分大小写开关、删除（替换成空串）', () => {
  assert.equal(replaceAllLiteral('Foo foo FOO', 'foo', 'x').text, 'x x x');
  assert.equal(
    replaceAllLiteral('Foo foo FOO', 'foo', 'x', { caseSensitive: true }).text,
    'Foo x FOO'
  );
  assert.equal(replaceAllLiteral('阿明阿明', '阿明', '').text, '');
});

test('替换：特殊字符不会破坏文本', () => {
  const res = replaceAllLiteral('3.14 元，价格 3.14', '3.14', '3.15');
  assert.equal(res.text, '3.15 元，价格 3.15');
});

test('替换：超过命中上限时如实回 truncated（C4 / WP-05，不能把截断当全部替换完成）', () => {
  const text = 'a'.repeat(MAX_MATCHES + 2);
  const over = replaceAllLiteral(text, 'a', 'b');
  assert.equal(over.count, MAX_MATCHES, '只替换前 MAX_MATCHES 处');
  assert.equal(over.truncated, true, '必须明确回报截断');
  assert.equal(over.limit, MAX_MATCHES);
  assert.equal(over.text, 'b'.repeat(MAX_MATCHES) + 'aa', '第 MAX_MATCHES + 1 处起原样保留');
  // 正好到上限不算截断（与 findMatchesAll 同一口径）
  const exact = replaceAllLiteral('a'.repeat(MAX_MATCHES), 'a', 'b');
  assert.equal(exact.count, MAX_MATCHES);
  assert.equal(exact.truncated, false);
  assert.equal(exact.text, 'b'.repeat(MAX_MATCHES));
  // 没有命中 / 空查询：次数 0、不截断、原文原样返回
  const none = replaceAllLiteral('没有命中', '阿明', '小明');
  assert.deepEqual(none, { text: '没有命中', count: 0, truncated: false, limit: MAX_MATCHES });
  assert.deepEqual(replaceAllLiteral('abc', '', 'x'), { text: 'abc', count: 0, truncated: false, limit: MAX_MATCHES });
});

test('上下文片段：去掉换行、头尾省略标记', () => {
  const text = '第一段\n阿明走进屋里，看见桌上有一封信。';
  const index = text.indexOf('阿明');
  const snippet = makeSnippet(text, index, 2, 6);
  assert.equal(snippet.match, '阿明');
  assert.ok(snippet.before.includes('第一段'), '跨行的前后文会被压成空格');
  assert.ok(!snippet.before.includes('\n'));
  const tail = makeSnippet('短句', 0, 1, 50);
  assert.equal(tail.ellipsisStart, false);
  assert.equal(tail.ellipsisEnd, false);
});

test('替换这一处：从光标位置往后找下一处（光标落在命中内部时算这一处）', () => {
  const text = '阿明走了，阿明回头，阿明笑了。';
  const first = findNextMatch(text, '阿明', 0);
  assert.equal(first.index, 0, '第 1 处');
  assert.equal(first.total, 3);
  assert.deepEqual(first.match, { index: 0, length: 2 });

  const second = findNextMatch(text, '阿明', 5); // 第 1 处之后
  assert.equal(second.index, 1, '第 2 处');
  assert.equal(second.match.index, 5);

  const inside = findNextMatch(text, '阿明', 6); // 光标正好在第 2 处里面
  assert.equal(inside.index, 1);
  assert.equal(inside.match.index, 5);

  assert.equal(findNextMatch(text, '阿明', text.length), null, '文末之后没有下一处');
  assert.equal(findNextMatch(text, '不存在', 0), null);
  assert.equal(findNextMatch('', '阿明', 0), null);
});

test('替换这一处：沿用字面量与大小写策略', () => {
  assert.equal(findNextMatch('Foo foo', 'foo', 0).index, 0);
  const sensitive = findNextMatch('Foo foo', 'foo', 0, { caseSensitive: true });
  assert.equal(sensitive.index, 0, '区分大小写时只有一处命中');
  assert.equal(sensitive.match.index, 4);
  assert.equal(findNextMatch('价格 3.14 元', '3.14', 0).match.index, 3);
  // 越界/非法 fromIndex：负数按 0；超过文末按「后面没有了」处理
  assert.equal(findNextMatch('阿明阿明', '阿明', -10).index, 0);
  assert.equal(findNextMatch('阿明阿明', '阿明', 999), null);
});

test('命中上限：正好到上限不算截断，再多一处就明确回 truncated', () => {
  assert.equal(MAX_MATCHES, 5000);
  const exact = findMatchesAll('a'.repeat(MAX_MATCHES), 'a');
  assert.equal(exact.matches.length, MAX_MATCHES);
  assert.equal(exact.truncated, false);

  const over = findMatchesAll('a'.repeat(MAX_MATCHES + 3), 'a');
  assert.equal(over.matches.length, MAX_MATCHES);
  assert.equal(over.truncated, true);
  // findMatches 照旧只回数组（老的调用方不用改）
  assert.equal(findMatches('a'.repeat(MAX_MATCHES + 3), 'a').length, MAX_MATCHES);
  assert.equal(findMatchesAll('', 'a').truncated, false);
  assert.equal(findMatchesAll('abc', '').matches.length, 0);
});

// ---------- 输入热路径（v1.8.0 WP-27 / B3） ----------

test('B3/WP-27：findNextMatch 增量 indexOf 与「先取全量命中再挑」口径逐案例一致', () => {
  // 参考实现 = 旧实现（findMatchesAll 的命中列表 + 两条 findIndex 判定），只用于对照。
  // 审计修复 #10（E6）：返回形状多了 truncated，截断且光标之后没有可定位命中时回空结果哨兵。
  const reference = (text, query, fromIndex, options) => {
    const found = findMatchesAll(text, query, options);
    const matches = found.matches;
    const truncated = found.truncated;
    const rawFrom = Number(fromIndex);
    const from = Math.max(0, Math.min(Number.isFinite(rawFrom) ? Math.floor(rawFrom) : 0, text.length));
    let index = matches.findIndex((match) => match.index <= from && from < match.index + match.length);
    if (index < 0) index = matches.findIndex((match) => match.index >= from);
    if (index < 0) {
      return truncated ? { index: -1, total: matches.length, truncated: true, match: null } : null;
    }
    return { index, total: matches.length, truncated, match: matches[index] };
  };
  const texts = [
    '阿明走了，阿明回头，阿明笑了。',
    'aaaa',
    'aaaaa',
    'Foo foo FOO foo',
    '\u0130stanbul istanbul Istanbul',
    '价格 3.14 元，3.14 又是 3.14',
    'a'.repeat(MAX_MATCHES + 3),
    `${'的'.repeat(MAX_MATCHES + 2)}结尾`,
    'x'.repeat(120) + '重复词'.repeat(40)
  ];
  const queries = ['阿明', 'aa', 'foo', 'FOO', '3.14', 'İstanbul', 'a', '的', '重复词', '不存在', ''];
  let cases = 0;
  for (const text of texts) {
    for (const query of queries) {
      for (const caseSensitive of [false, true]) {
        const options = { caseSensitive };
        const step = Math.max(1, Math.floor(text.length / 19));
        for (let from = -3; from <= text.length + 3; from += step) {
          assert.deepEqual(
            findNextMatch(text, query, from, options),
            reference(text, query, from, options),
            `text=${text.length} query=${query} from=${from} cs=${caseSensitive}`
          );
          cases += 1;
        }
      }
    }
  }
  assert.ok(cases > 100, '覆盖足够多的位置');
  // 5000 上限语义：第 5001 处不可见（旧实现列表只有前 5000 处），第 5000 处照旧可见。
  const capped = 'a'.repeat(MAX_MATCHES + 3);
  const lastVisible = findNextMatch(capped, 'a', MAX_MATCHES - 1);
  assert.equal(lastVisible.index, MAX_MATCHES - 1);
  assert.equal(lastVisible.total, MAX_MATCHES, 'total 仍是列表长度（受上限约束）');
  assert.equal(lastVisible.truncated, true, '命中超过上限必须如实回 truncated（E6 / 审计 #10）');
  // 第 5001 处：返回截断哨兵（match 为 null），让界面说「超过单章上限」而不是「没有下一处了」。
  assert.deepEqual(
    findNextMatch(capped, 'a', MAX_MATCHES),
    { index: -1, total: MAX_MATCHES, truncated: true, match: null }
  );
});

test('替换这一处（E6 / 审计 #10）：命中没到上限时 truncated 恒为 false，正常返回形状不变', () => {
  const exact = findNextMatch('a'.repeat(MAX_MATCHES), 'a', 0);
  assert.equal(exact.truncated, false, '正好 5000 处不算截断（与 findMatchesAll 同一口径）');
  assert.equal(exact.total, MAX_MATCHES);
  const small = findNextMatch('阿明走了，阿明回头。', '阿明', 0);
  assert.equal(small.truncated, false);
  assert.equal(small.total, 2);
  assert.deepEqual(small.match, { index: 0, length: 2 });
  const lastOne = findNextMatch('a'.repeat(MAX_MATCHES), 'a', MAX_MATCHES - 1);
  assert.equal(lastOne.index, MAX_MATCHES - 1);
  assert.equal(lastOne.truncated, false, '最后一处落在上限内：没有更多命中');
});

test('B3/WP-27 静态闸门：findNextMatch 不许再物化全量命中，5000 上限仍在同一个循环里', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs
    .readFileSync(path.join(__dirname, '..', 'core', 'find.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const body = /function findNextMatch\([\s\S]*?\n\}\n/.exec(src);
  assert.ok(body, '找不到 findNextMatch');
  const code = body[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/findMatches(All)?\(/.test(code), '不许在 findNextMatch 里调 findMatches / findMatchesAll');
  assert.match(code, /indexOf\(needle, from2\)/, '必须用 indexOf 增量推进');
  assert.match(code, /while \(total < MAX_MATCHES\)/, '命中上限必须保留在增量循环里');
  assert.ok(!/\.push\(/.test(code), '不许把命中物化成数组');
});
