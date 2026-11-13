const test = require('node:test');
const assert = require('node:assert/strict');
const proofread = require('../core/proofread');
const format = require('../core/format');
const glossary = require('../core/glossary');

const only = (result, rule) => result.issues.filter((issue) => issue.rule === rule);

test('校对：干净正文不报任何问题（单空行不算多余空行）', () => {
  const result = proofread.proofreadText('　　风从海面吹来。\n\n他收起了帆。');
  assert.equal(result.total, 0);
  assert.equal(result.issues.length, 0);
  assert.equal(result.paragraphs, 2);
  assert.equal(result.chars, 13);
  assert.equal(result.truncated, false);
  for (const rule of proofread.RULE_ORDER) assert.equal(result.byRule[rule], 0);
});

test('校对：空文本 / null / 纯空白都安全', () => {
  for (const input of ['', null, undefined, '   ']) {
    const result = proofread.proofreadText(input);
    assert.equal(result.total, 0);
    assert.deepEqual(result.issues, []);
    assert.equal(result.chars, 0);
  }
});

test('校对：半角标点残留只报告、给出原字符和建议字符', () => {
  const text = '他说,你好.';
  const result = proofread.proofreadText(text);
  const issues = only(result, 'halfwidth-punct');
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map((issue) => issue.index), [2, 5]);
  assert.deepEqual(issues.map((issue) => issue.match), [',', '.']);
  assert.equal(issues[0].message, '半角标点「,」建议改成「，」');
  assert.equal(issues[1].message, '半角标点「.」建议改成「。」');
  assert.equal(issues[0].line, 1);
  assert.equal(issues[0].column, 3);
  assert.equal(issues[0].ruleLabel, '半角标点');
  // 只报告：原文一个字都没被改（函数纯，返回值里也不带改后的正文）
  assert.equal(result.issues.some((issue) => 'text' in issue), false);
});

test('校对：数字 / 时间 / 网址 / 英文缩写里的半角标点不误报', () => {
  const text = '版本 3.14，时间 12:30，网址 www.a.com，缩写 A.开头，价格 1,000 元。';
  const result = proofread.proofreadText(text);
  assert.equal(only(result, 'halfwidth-punct').length, 0);
});

test('校对：半角标点判定与 format.convertPunct / formatText 完全一致', () => {
  const lines = [
    '他说,"你好"。',
    '价格3.14元,时间12:30,他笑了.',
    '什么?!这也行...',
    'Hello, world. 这句话没有中文标点?',
    '他问:「真的吗?」然后走了.'
  ];
  for (const line of lines) {
    let count = 0;
    const positions = [];
    format.convertPunct(line, (index) => {
      count += 1;
      positions.push(index);
    });
    const direct = format.convertPunct(line);
    assert.equal(count, direct.count);
    const result = proofread.proofreadText(line);
    const issues = only(result, 'halfwidth-punct');
    assert.equal(issues.length, direct.count, line);
    assert.deepEqual(issues.map((issue) => issue.index), positions, line);
    assert.equal(format.formatText(line, { indent: 'none', blankLines: 'keep' }).stats.punctFixed, direct.count);
  }
});

test('校对：超长段落按去空白后的字数判断，阈值可调', () => {
  const long = '字'.repeat(501);
  const result = proofread.proofreadText(long);
  const issues = only(result, 'long-paragraph');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].message, '这一段 501 字（超过 500 字）');
  assert.equal(issues[0].index, 0);
  assert.equal(issues[0].length, 501);
  assert.equal(issues[0].match, long.slice(0, 24));

  const atLimit = proofread.proofreadText('字'.repeat(500));
  assert.equal(only(atLimit, 'long-paragraph').length, 0);

  const custom = proofread.proofreadText('字'.repeat(80), { longParagraph: 50 });
  assert.equal(only(custom, 'long-paragraph').length, 1);
  assert.equal(only(custom, 'long-paragraph')[0].message, '这一段 80 字（超过 50 字）');
});

test('校对：超长段落的字数不含缩进和行尾空白', () => {
  const text = `　　${'字'.repeat(499)}   `;
  const result = proofread.proofreadText(text, { longParagraph: 500 });
  assert.equal(only(result, 'long-paragraph').length, 0);
  const longer = proofread.proofreadText(`　　${'字'.repeat(501)}   `, { longParagraph: 500 });
  assert.equal(only(longer, 'long-paragraph').length, 1);
});

test('校对：重复用词——300 字内同一双字词出现 3 次才报', () => {
  const text = '突然，他停下。突然，他回头。突然，他笑了。';
  const result = proofread.proofreadText(text);
  const issues = only(result, 'repeat-word');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].match, '突然');
  assert.equal(issues[0].count, 3);
  assert.equal(issues[0].window, 300);
  assert.equal(issues[0].message, '「突然」在 300 字内出现 3 次');
  assert.equal(issues[0].index, text.indexOf('突然'));
});

test('校对：重复用词——只出现 2 次不报，窗口内凑不满 3 次也不报', () => {
  const twice = proofread.proofreadText('他突然笑了，然后又突然停下。');
  assert.equal(only(twice, 'repeat-word').filter((issue) => issue.match === '突然').length, 0);

  const filler = (n) => Array.from({ length: n }, (_v, i) => String.fromCharCode(0x4e00 + ((i * 97) % 900))).join('');
  const spread = `突然${filler(150)}突然${filler(150)}突然`;
  const narrow = proofread.proofreadText(spread, { repeatWindow: 300 });
  assert.equal(narrow.issues.filter((issue) => issue.match === '突然').length, 0);
  const wide = proofread.proofreadText(spread, { repeatWindow: 500 });
  assert.equal(wide.issues.filter((issue) => issue.match === '突然').length, 1);
});

test('校对：重复用词——重叠命中不重复计数（「哈哈哈哈」不算 3 次）', () => {
  const four = proofread.proofreadText('哈哈哈哈');
  assert.equal(four.issues.filter((issue) => issue.match === '哈哈').length, 0);
  const eight = proofread.proofreadText('哈哈哈哈哈哈哈哈');
  const hits = eight.issues.filter((issue) => issue.match === '哈哈');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 4);
});

test('校对：重复用词——count 是窗口内的实际次数，repeatCount 可调', () => {
  const text = '突然突然突然突然，他站住了。';
  const result = proofread.proofreadText(text, { repeatCount: 4 });
  const hits = result.issues.filter((issue) => issue.match === '突然');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 4);
  assert.equal(proofread.proofreadText(text, { repeatCount: 5 }).issues.filter((i) => i.match === '突然').length, 0);
});

test('校对：重复用词只在段落内部找，跨段落拼起来的相同双字词不算', () => {
  const text = '突然\n突然\n突然';
  const result = proofread.proofreadText(text);
  assert.equal(result.issues.filter((issue) => issue.match === '突然').length, 0);
});

test('校对：重复用词——重叠二字词只报一次（「突然想起」×3 不刷三条）', () => {
  const text = '突然想起母亲，突然想起父亲，突然想起那年夏天。';
  const result = proofread.proofreadText(text);
  const hits = result.issues.filter((issue) => issue.rule === 'repeat-word');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match, '突然');
  assert.equal(hits[0].count, 3);
});

test('校对：连续标点——3 个及以上才报，「！？」「……」「——」不误报', () => {
  const three = proofread.proofreadText('他喊：「？！？」');
  const issues = only(three, 'punct-run');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].match, '？！？');
  assert.equal(issues[0].message, '连续 3 个标点「？！？」');

  assert.equal(only(proofread.proofreadText('他喊：「！？」'), 'punct-run').length, 0);
  assert.equal(only(proofread.proofreadText('他……没说完。'), 'punct-run').length, 0);
  assert.equal(only(proofread.proofreadText('他——没说完。'), 'punct-run').length, 0);
  assert.equal(only(proofread.proofreadText('「？？？」'), 'punct-run').length, 1);
  assert.equal(only(proofread.proofreadText('「！！！」'), 'punct-run').length, 1);
  // 连排省略号算一个单位：两个单位不报，三个单位（……？！）报
  assert.equal(only(proofread.proofreadText('「……？！」'), 'punct-run').length, 1);
  // 不跨行
  assert.equal(only(proofread.proofreadText('？\n？\n？'), 'punct-run').length, 0);
});

test('校对：多余空行——2 个及以上连续空行才报，单个空行不报', () => {
  const single = proofread.proofreadText('第一段。\n\n第二段。');
  assert.equal(only(single, 'blank-lines').length, 0);

  const double = proofread.proofreadText('第一段。\n\n\n第二段。');
  const issues = only(double, 'blank-lines');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].count, 2);
  assert.equal(issues[0].message, '这里有 2 个连续空行');
  assert.equal(issues[0].line, 2);
  assert.equal(issues[0].snippet.match, '2 个空行');
  assert.equal(issues[0].snippet.before, '第一段。');
  assert.equal(issues[0].snippet.after, '第二段。');

  // 只有全角空格「空行（含缩进）」，本身是 1 个空行，不报
  assert.equal(only(proofread.proofreadText('甲。\n　　\n乙。'), 'blank-lines').length, 0);
  assert.equal(only(proofread.proofreadText('甲。\n　　\n　　\n乙。'), 'blank-lines').length, 1);
});

test('校对：开头 / 结尾的连续空行也会报出来', () => {
  const leading = proofread.proofreadText('\n\n正文。');
  const leadIssues = only(leading, 'blank-lines');
  assert.equal(leadIssues.length, 1);
  assert.equal(leadIssues[0].index, 0);
  assert.equal(leadIssues[0].snippet.before, '');

  const trailing = proofread.proofreadText('正文。\n\n\n');
  assert.equal(only(trailing, 'blank-lines').length, 1);
});

test('校对：CRLF / CR / BOM 归一成 LF 后再定位，位置能直接在编辑区选中', () => {
  const text = '\uFEFF他说,好。\r\n\r\n\r\n下一段。';
  const result = proofread.proofreadText(text);
  const normalized = '他说,好。\n\n\n下一段。';
  const comma = result.issues.find((issue) => issue.rule === 'halfwidth-punct');
  assert.equal(comma.index, 2);
  assert.equal(normalized.slice(comma.index, comma.index + comma.match.length), comma.match);
  const blanks = result.issues.find((issue) => issue.rule === 'blank-lines');
  assert.equal(blanks.line, 2);
  assert.equal(normalized.slice(blanks.index, blanks.index + blanks.match.length), blanks.match);
});

test('校对：每条结果的 match 都能在原文对应位置原样取到', () => {
  const text = '第一段,这里有问题。突然，突然，突然。\n\n\n他问：「？！？」\n结尾。';
  const normalized = text.replace(/\r\n?/g, '\n');
  const result = proofread.proofreadText(text);
  assert.ok(result.issues.length >= 4);
  for (const issue of result.issues) {
    if (!issue.match) continue;
    assert.equal(
      normalized.slice(issue.index, issue.index + issue.match.length),
      issue.match,
      `${issue.rule} @${issue.index}`
    );
  }
});

test('校对：结果按位置排序，同位置按规则顺序', () => {
  const result = proofread.proofreadText('他说,好。\n\n\n？？？');
  const indexes = result.issues.map((issue) => issue.index);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
});

test('校对：1 基行号 / 列号正确（缩进也算列）', () => {
  const text = '第一行。\n　　第二行,这里有逗号。';
  const result = proofread.proofreadText(text);
  const issue = result.issues.find((item) => item.rule === 'halfwidth-punct');
  assert.equal(issue.line, 2);
  assert.equal(issue.column, 6);
});

test('校对：超量时只保留前 maxIssues 条，但总数与各规则条数照实统计', () => {
  const text = '他,'.repeat(300);
  const result = proofread.proofreadText(text, { maxIssues: 20, longParagraph: 2000 });
  assert.equal(result.issues.length, 20);
  assert.equal(result.total, 300);
  assert.equal(result.byRule['halfwidth-punct'], 300);
  assert.equal(result.truncated, true);
  // 保留下来的仍是排好序的前 20 条
  assert.deepEqual(
    result.issues.map((issue) => issue.index),
    Array.from({ length: 20 }, (_v, i) => i * 2 + 1)
  );
});

test('校对：选项清洗——脏值回落默认、越界夹紧、字符串数字可用', () => {
  assert.deepEqual(proofread.sanitizeOptions(undefined), { ...proofread.DEFAULT_OPTIONS });
  assert.deepEqual(proofread.sanitizeOptions(null), { ...proofread.DEFAULT_OPTIONS });
  assert.deepEqual(proofread.sanitizeOptions('不是对象'), { ...proofread.DEFAULT_OPTIONS });
  const clamped = proofread.sanitizeOptions({
    longParagraph: 1,
    repeatWindow: 999999,
    repeatCount: 1,
    maxIssues: 0
  });
  assert.equal(clamped.longParagraph, 50);
  assert.equal(clamped.repeatWindow, 5000);
  assert.equal(clamped.repeatCount, 2);
  assert.equal(clamped.maxIssues, 20);
  const strings = proofread.sanitizeOptions({
    longParagraph: '600',
    repeatWindow: '120',
    repeatCount: '4',
    maxIssues: '30'
  });
  assert.deepEqual(strings, { longParagraph: 600, repeatWindow: 120, repeatCount: 4, maxIssues: 30 });
  assert.deepEqual(proofread.sanitizeOptions({ longParagraph: NaN }), { ...proofread.DEFAULT_OPTIONS });
});

test('校对：同样的输入结果完全一致（纯函数、可回归）', () => {
  const text = '他说,好。突然，突然，突然。\n\n\n「？！？」';
  const a = proofread.proofreadText(text);
  const b = proofread.proofreadText(text);
  assert.deepEqual(a, b);
  const options = { longParagraph: 100 };
  proofread.proofreadText(text, options);
  assert.deepEqual(options, { longParagraph: 100 }, '不修改调用方传进来的选项对象');
});

test('校对：上下文片段带前后文，mark 部分是命中的原文', () => {
  const text = '前面还有一点文字,这里出了问题，后面也还有一点文字。';
  const result = proofread.proofreadText(text);
  const issue = result.issues.find((item) => item.rule === 'halfwidth-punct');
  assert.equal(issue.snippet.match, ',');
  assert.ok(issue.snippet.before.endsWith('文字'));
  assert.ok(issue.snippet.after.startsWith('这里出了问题'));
});

test('校对：自定义词表——命中位置 / 建议 / 行号列号 / 按规则统计', () => {
  const text = '他做为旁观者。\n他决定做为见证人。\n这里有两个禁词和禁词。';
  const entries = [
    { term: '做为', suggestion: '作为' },
    { term: '禁词', suggestion: '' },
    { term: '做为', suggestion: '当作' }
  ];
  const result = proofread.proofreadText(text, {}, entries);
  assert.equal(result.customWordCount, 2, '重复的词只算一个（保留第一次的建议）');
  assert.equal(result.byRule['custom-word'], 4);
  const custom = only(result, 'custom-word');
  assert.deepEqual(
    custom.map((issue) => [issue.match, issue.suggestion, issue.index, issue.line, issue.column]),
    [
      ['做为', '作为', 1, 1, 2],
      ['做为', '作为', 11, 2, 4],
      ['禁词', '', 23, 3, 6],
      ['禁词', '', 26, 3, 9]
    ]
  );
  assert.equal(custom[0].ruleLabel, '自定义词表');
  assert.equal(custom[0].message, '词表里的「做为」建议改成「作为」');
  assert.equal(custom[2].message, '命中校对词表里的「禁词」');
  assert.equal(custom[0].length, 2);
  assert.ok(custom[0].snippet.match === '做为');
  // 只报告：原文没有被改
  assert.equal(text, '他做为旁观者。\n他决定做为见证人。\n这里有两个禁词和禁词。');
});

test('校对：没有校对词表时只有内置五条规则，行为与以前一致', () => {
  const text = '他说,好。突然，突然，突然。';
  const withNothing = proofread.proofreadText(text);
  const withEmpty = proofread.proofreadText(text, {}, []);
  assert.deepEqual(withNothing, withEmpty);
  assert.equal(withNothing.customWordCount, 0);
  assert.equal(withNothing.byRule['custom-word'], 0);
  assert.equal(proofread.RULE_ORDER[proofread.RULE_ORDER.length - 1], 'custom-word');
  assert.equal(proofread.RULE_LABELS['custom-word'], '自定义词表');
  // 脏词条被忽略，不会把函数弄崩
  const dirty = proofread.proofreadText(text, {}, [null, 42, { term: '' }, '好']);
  assert.equal(dirty.customWordCount, 1);
  assert.equal(dirty.byRule['custom-word'], 1);
});

test('校对：同一处既有内置规则又有词表命中时按位置排序（同位置内置规则在前）', () => {
  const text = '他说,好。';
  const result = proofread.proofreadText(text, {}, [{ term: ',', suggestion: '，' }]);
  const atComma = result.issues.filter((issue) => issue.index === 2);
  assert.deepEqual(
    atComma.map((issue) => issue.rule),
    ['halfwidth-punct', 'custom-word']
  );
  assert.equal(result.total, 2);
});

test('校对：词表命中重叠时只报最长的那个，不受词表顺序影响', () => {
  const text = '这里有色情小说和色情图片。';
  const entries = [
    { term: '色情', suggestion: '' },
    { term: '色情小说', suggestion: '成人小说' }
  ];
  const result = proofread.proofreadText(text, {}, entries);
  assert.deepEqual(
    only(result, 'custom-word').map((issue) => [issue.match, issue.index, issue.suggestion]),
    [
      ['色情小说', 3, '成人小说'],
      ['色情', 8, '']
    ]
  );
});

test('校对：词表命中同样受 maxIssues 限制，总数照实统计', () => {
  // 用英文字母构造：只命中词表，不会顺手触发「重复用词」等中文规则
  const text = 'a'.repeat(50);
  const result = proofread.proofreadText(text, { maxIssues: 20 }, [{ term: 'a', suggestion: '' }]);
  assert.equal(result.total, 50);
  assert.equal(result.byRule['custom-word'], 50);
  assert.equal(result.issues.length, 20);
  assert.equal(result.truncated, true);
});

test('校对：带词表时结果仍可回归，且不修改调用方数组', () => {
  const entries = [{ term: '做为', suggestion: '作为' }];
  const copy = JSON.parse(JSON.stringify(entries));
  const text = '他做为见证人。';
  const a = proofread.proofreadText(text, {}, entries);
  const b = proofread.proofreadText(text, {}, entries);
  assert.deepEqual(a, b);
  assert.deepEqual(entries, copy);
});

test('校对：已清洗入参不再二次 sanitize（注入计数，V44）', () => {
  const raw = [
    { term: ' 做为 ', suggestion: '作为' },
    { term: '做为', suggestion: '当作' },
    { term: '', suggestion: 'x' },
    '禁词'
  ];
  const cleanEntries = glossary.sanitizeEntries(raw);
  assert.deepEqual(cleanEntries, [
    { term: '做为', suggestion: '作为' },
    { term: '禁词', suggestion: '' }
  ], '前置：读到出口时词条已被清洗（parseGlossary / readGlossaryFiles 同一口径）');

  const origSanitize = glossary.sanitizeEntries;
  const origFindHits = glossary.findHits;
  const calls = { sanitize: 0, findOptions: null };
  // 注入计数：proofread.js 与测试共享同一个 core/glossary 模块对象，替换导出即可看到调用次数。
  glossary.sanitizeEntries = (...args) => {
    calls.sanitize += 1;
    return origSanitize(...args);
  };
  glossary.findHits = (text, entries, options) => {
    calls.findOptions = options || null;
    return origFindHits(text, entries, options);
  };
  try {
    const text = '他做为见证人，这里有个禁词。';

    // 旧调用（不带标记）照旧可用：proofreadText 只在入口清洗一次，之后把「已清洗」交给 findHits。
    const legacy = proofread.proofreadText(text, {}, raw);
    assert.equal(legacy.byRule['custom-word'], 2);
    assert.equal(legacy.customWordCount, 2);
    assert.equal(calls.sanitize, 1, '旧调用只清洗一次');
    assert.equal(calls.findOptions && calls.findOptions.sanitized, true, 'findHits 收到「已清洗」标记，不再二次清洗');

    // 已清洗入参（主进程读取出口）不再洗第二遍：计数必须归零。
    calls.sanitize = 0;
    calls.findOptions = null;
    const trusted = proofread.proofreadText(text, { entriesSanitized: true }, cleanEntries);
    assert.equal(calls.sanitize, 0, '已清洗入参：proofreadText 不再调用 sanitizeEntries');
    assert.ok(calls.findOptions && calls.findOptions.sanitized === true, 'findHits 同样跳过再清洗');
    assert.deepEqual(trusted, legacy, '两条路的校对结果逐字一致（行为等价）');

    // findHits 的公开 API 默认语义不变：直接传脏词条仍会自己清洗。
    const direct = origFindHits(text, raw);
    assert.equal(direct.entryCount, 2);
    assert.deepEqual(direct.hits.map((hit) => hit.term), ['做为', '禁词']);
  } finally {
    glossary.sanitizeEntries = origSanitize;
    glossary.findHits = origFindHits;
  }
});

// ---------- 1.5.0 功能-2：六条规则 + 单条开关 ----------

test('校对：1.5.0 规则表——新四条插在自定义词表之前，默认开关与文案齐全', () => {
  assert.deepEqual(proofread.RULE_ORDER, [
    'halfwidth-punct',
    'long-paragraph',
    'repeat-word',
    'punct-run',
    'blank-lines',
    'cjk-latin-spacing',
    'ellipsis',
    'dash',
    'fullwidth-digit',
    'custom-word'
  ]);
  assert.equal(proofread.DEFAULT_RULES['cjk-latin-spacing'], false, '中英间距是风格偏好，默认关');
  for (const rule of proofread.RULE_ORDER) {
    if (rule === 'cjk-latin-spacing') continue;
    assert.equal(proofread.DEFAULT_RULES[rule], true, `${rule} 默认开`);
  }
  assert.deepEqual(Object.keys(proofread.RULE_LABELS).sort(), [...proofread.RULE_ORDER].sort());
  assert.equal(proofread.RULE_LABELS['cjk-latin-spacing'], '中英间距');
  assert.equal(proofread.RULE_LABELS.ellipsis, '省略号');
  assert.equal(proofread.RULE_LABELS.dash, '破折号');
  assert.equal(proofread.RULE_LABELS['fullwidth-digit'], '全角数字');
  // 结果里带「这次真正生效的开关」，渲染层面板照着画
  assert.deepEqual(proofread.proofreadText('风停了。').rules, { ...proofread.DEFAULT_RULES });
});

test('校对：sanitizeRules——只认布尔、缺省补默认、脏值回落、不改入参', () => {
  assert.deepEqual(proofread.sanitizeRules(undefined), { ...proofread.DEFAULT_RULES });
  assert.deepEqual(proofread.sanitizeRules(null), { ...proofread.DEFAULT_RULES });
  assert.deepEqual(proofread.sanitizeRules('不是对象'), { ...proofread.DEFAULT_RULES });
  assert.deepEqual(proofread.sanitizeRules([]), { ...proofread.DEFAULT_RULES });
  const raw = { ellipsis: false, dash: 'no', 'fullwidth-digit': 0 };
  const rules = proofread.sanitizeRules(raw);
  assert.equal(rules.ellipsis, false);
  assert.equal(rules.dash, true, '非布尔按默认（dash 默认开）');
  assert.equal(rules['fullwidth-digit'], true, '数字 0 不算 false');
  assert.deepEqual(raw, { ellipsis: false, dash: 'no', 'fullwidth-digit': 0 }, '不改调用方对象');
});

test('校对：中英间距——默认关；开启后汉字与拉丁字母 / 数字的每个边界报一条', () => {
  const text = '他用iPhone手机，OK。';
  assert.equal(only(proofread.proofreadText(text), 'cjk-latin-spacing').length, 0, '默认不查');
  const result = proofread.proofreadText(text, { rules: { 'cjk-latin-spacing': true } });
  const hits = only(result, 'cjk-latin-spacing');
  assert.deepEqual(
    hits.map((issue) => [issue.index, issue.match]),
    [
      [1, '用i'],
      [7, 'e手']
    ]
  );
  assert.equal(hits[0].message, '「用i」之间建议加一个空格');
  assert.equal(hits[0].suggestion, '用 i');
  assert.equal(text.slice(hits[0].index, hits[0].index + hits[0].match.length), '用i');
  assert.equal(hits[0].line, 1);
  // 反例：已经加空格 / 纯英文 / 中文标点挨着英文（「他说，iPhone」「OK。」）都不算缺空格
  for (const clean of ['他用 iPhone 手机', 'Hello, world.', '他说，iPhone', '3.14', '第 3 章']) {
    assert.equal(
      only(proofread.proofreadText(clean, { rules: { 'cjk-latin-spacing': true } }), 'cjk-latin-spacing')
        .length,
      0,
      clean
    );
  }
});

test('校对：省略号——3 个及以上半角点 / 「。。。」各报一条，中文省略号与两个点不报', () => {
  const three = only(proofread.proofreadText('他说...'), 'ellipsis');
  assert.equal(three.length, 1);
  assert.equal(three[0].index, 2);
  assert.equal(three[0].match, '...');
  assert.equal(three[0].message, '省略号「...」建议改成「……」');
  assert.equal(three[0].suggestion, '……');
  const six = only(proofread.proofreadText('六个点......'), 'ellipsis');
  assert.equal(six.length, 1);
  assert.equal(six[0].match, '......');
  // 「。。。」同时被 ④ 连续标点报一次：两条各说一件事（这条给改法）
  const full = proofread.proofreadText('他说。。。');
  assert.deepEqual(only(full, 'ellipsis').map((issue) => issue.match), ['。。。']);
  assert.deepEqual(only(full, 'punct-run').map((issue) => issue.match), ['。。。']);
  // 反例：中文省略号 / 两个半角点 / 两个句号 / 网址里的点
  for (const clean of ['他说……没说完。', '他说..', '两个句号。。', 'www.a.com']) {
    assert.equal(only(proofread.proofreadText(clean), 'ellipsis').length, 0, clean);
  }
});

test('校对：破折号——「--」「---」与单个「—」建议「——」，标准「——」/ 日期 / 分隔线不报', () => {
  const two = only(proofread.proofreadText('他说--然后走了'), 'dash');
  assert.equal(two.length, 1);
  assert.equal(two[0].index, 2);
  assert.equal(two[0].match, '--');
  assert.equal(two[0].message, '破折号「--」建议用两个「——」');
  assert.equal(two[0].suggestion, '——');
  assert.equal(only(proofread.proofreadText('他说---然后走了'), 'dash')[0].match, '---');
  const single = only(proofread.proofreadText('他来了—然后走了'), 'dash');
  assert.equal(single.length, 1);
  assert.equal(single[0].match, '—');
  // 反例：标准破折号 / 日期区间 / 单独的分隔线 / 英文连字符
  for (const clean of ['他——没说完。', '12-30 出发', '----', 'A-B 测试']) {
    assert.equal(only(proofread.proofreadText(clean), 'dash').length, 0, clean);
  }
});

test('校对：全角数字——一整段合成一条并给出半角建议，半角数字不报', () => {
  const result = proofread.proofreadText('２０２４年１２月，这是第１章。');
  const hits = only(result, 'fullwidth-digit');
  assert.deepEqual(
    hits.map((issue) => [issue.index, issue.match, issue.suggestion]),
    [
      [0, '２０２４', '2024'],
      [5, '１２', '12'],
      [12, '１', '1']
    ]
  );
  assert.equal(hits[0].message, '全角数字「２０２４」建议改成半角「2024」');
  assert.equal(only(proofread.proofreadText('2024 年 12 月'), 'fullwidth-digit').length, 0);
});

test('校对：单条开关——关掉某条后它一条都不产出，其它规则照常', () => {
  const text = '他说...然后走了--真的。';
  const all = proofread.proofreadText(text);
  assert.equal(all.byRule.ellipsis, 1);
  assert.equal(all.byRule.dash, 1);
  const off = proofread.proofreadText(text, { rules: { ellipsis: false } });
  assert.equal(off.byRule.ellipsis, 0);
  assert.equal(off.byRule.dash, 1);
  assert.equal(off.total, all.total - 1);
  assert.deepEqual(off.issues.filter((issue) => issue.rule === 'ellipsis'), []);
  assert.equal(off.rules.ellipsis, false);
  assert.equal(all.rules.ellipsis, true);
  // 全关 = 0 条（统计口径还在：byRule 每条都是 0）
  const rules = {};
  for (const rule of proofread.RULE_ORDER) rules[rule] = false;
  const none = proofread.proofreadText(text, { rules });
  assert.equal(none.total, 0);
  assert.deepEqual(none.issues, []);
  for (const rule of proofread.RULE_ORDER) assert.equal(none.byRule[rule], 0);
  // 自定义词表也能关：关掉后不做词表扫描，但词数照实统计（面板还要显示词表状态）
  const gloss = [{ term: '真的', suggestion: '确实' }];
  assert.equal(proofread.proofreadText(text, {}, gloss).byRule['custom-word'], 1);
  const noGloss = proofread.proofreadText(text, { rules: { 'custom-word': false } }, gloss);
  assert.equal(noGloss.byRule['custom-word'], 0);
  assert.equal(noGloss.customWordCount, 1);
});

test('校对：新规则的位置 / 片段都能在原文原样取到，且按位置与规则顺序排', () => {
  const text = '他喊...然后——走了--不、２０２４年。他用iPhone手机。';
  const rules = { 'cjk-latin-spacing': true };
  const normalized = text.replace(/\r\n?/g, '\n');
  const result = proofread.proofreadText(text, { rules });
  const fresh = result.issues.filter((issue) =>
    ['cjk-latin-spacing', 'ellipsis', 'dash', 'fullwidth-digit'].includes(issue.rule)
  );
  assert.ok(fresh.length >= 5, JSON.stringify(fresh.map((issue) => issue.rule)));
  for (const issue of fresh) {
    assert.equal(normalized.slice(issue.index, issue.index + issue.match.length), issue.match, issue.rule);
  }
  const indexes = result.issues.map((issue) => issue.index);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
});

// 1.6.0 A5 / P-08：整本校对（book:proofread）逐章只读正文，但明细预算用完后仍会把每一条命中
// 的上下文片段（前后各 18 字 + 空白压缩）拼出来再丢掉。加「只要位置、不拼结果」开关：
// snippets:false 时 snippet 一律 null，位置 / 行号 / 匹配文本 / 提示文案与默认逐项一致。
test('P-08：snippets:false 只要位置、不拼上下文片段（条数 / 规则分布 / 位置 / 文案逐项一致）', () => {
  const text = '他说,好。\n\n\n\n第二段？？？「……」Ａ１';
  const full = proofread.proofreadText(text);
  const lean = proofread.proofreadText(text, { snippets: false });
  assert.ok(full.issues.length >= 4, JSON.stringify(full.issues.map((issue) => issue.rule)));
  assert.equal(lean.total, full.total, '总数要照实统计（截断口径不变）');
  assert.deepEqual(lean.byRule, full.byRule, '各规则条数逐项一致');
  assert.equal(lean.issues.length, full.issues.length);
  assert.ok(
    full.issues.every((issue) => issue.snippet && typeof issue.snippet === 'object'),
    '默认仍然拼片段（校对面板的上下文列要用）'
  );
  assert.ok(
    lean.issues.every((issue) => issue.snippet === null),
    '不拼片段时 snippet 一律 null（含 blank-lines 自己拼的那条）'
  );
  const strip = (issue) => {
    const { snippet, ...rest } = issue;
    return rest;
  };
  assert.deepEqual(lean.issues.map(strip), full.issues.map(strip), '位置 / 行号 / 匹配文本 / 提示文案不许因为不拼片段而变');
  assert.deepEqual(lean.rules, full.rules, '规则开关照旧回传');
});

test('P-08 接线闸门：整本校对明细预算用完后，后续章节只算位置不拼片段', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = main.indexOf("handleBook('book:proofread'");
  assert.ok(start > 0, 'main.js 里找不到 book:proofread');
  const end = main.indexOf('\n  });', start);
  assert.ok(end > start, 'book:proofread 的处理函数没有按预期结束');
  const region = main.slice(start, end);
  assert.match(region, /issues\.length >= BOOK_ISSUE_LIMIT/, '整本校对仍按 1500 条明细预算收口');
  assert.match(region, /snippets: false/, '预算用完后要传 snippets:false（不再为丢掉的明细拼片段）');
  assert.match(region, /snippetsWanted/, '要有一个跨章记住的「还要不要片段」状态');
});
