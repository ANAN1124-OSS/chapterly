// 导出简繁转换（v0.8 P0 N7）：内置字表 + 常见词纠正 + 只转换传入的字符串。
// 不读盘、不写盘、不依赖 Electron；只测 core/s2t.js。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const s2t = require('../core/s2t');

test('简繁字表：没有写错的词条、没有同一字两种写法、没有反推冲突', () => {
  assert.deepEqual(s2t.INVALID_PAIRS, [], '每个词条必须是两个不同的字符');
  assert.deepEqual(s2t.PAIR_CONFLICTS, [], '同一个字不能既转 A 又转 B');
  assert.deepEqual(s2t.T2S_CONFLICTS, [], '繁→简反推与补充字表不能冲突');
  // 字表够不够用：只做常用字，但也不能少得离谱（少于 800 个就没法用）
  assert.ok(s2t.S2T_SIZE >= 800, `简→繁字表太小：${s2t.S2T_SIZE}`);
  assert.ok(s2t.T2S_SIZE >= s2t.S2T_SIZE, `繁→简字表应覆盖反推：${s2t.T2S_SIZE}`);
  // 每条短语等长（转换前后字数不变），且没有从空串开始的词条
  for (const [from, to] of [...s2t.S2T_PHRASES, ...s2t.T2S_PHRASES]) {
    assert.ok(from.length > 0, '短语不能为空');
    assert.equal(from.length, to.length, `短语长度不一致：${from}=${to}`);
  }
  // 抽查几个最常用的字 / 词，防止字表被误删
  for (const pair of ['说說', '门門', '国國', '时時', '发發', '后後', '里裡', '台臺']) {
    assert.ok(s2t.S2T_PAIRS.includes(pair), `字表缺少 ${pair}`);
  }
});

// A5（整合版审计，v1.8.0 WP-33）：简→繁字表原分两段写——前段 540 条，后段 905 条里
// 有 516 条与前段逐字重复，靠 parsePairs 静默去重；覆盖审计得同时核对两段。
// 现在两段已合并为一份去重表（保持首次出现顺序，转换结果逐字节不变），parsePairs 的
// 「同一边重复只留第一条 + 冲突记账」保留为兜底。本用例钉住三件事：源表零重复、
// parsePairs 零丢弃、原两段各自独有的条目一条不少（覆盖审计只核对这一份表）。
test('简繁字表：两大段重叠字表已合并为一份去重表（A5）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 's2t.js'), 'utf8');
  const at = source.indexOf('const S2T_RAW = parsePairs(');
  assert.ok(at > 0, '找不到 S2T_RAW 字表');
  const bodyStart = source.indexOf('`', at) + 1;
  const tokens = source.slice(bodyStart, source.indexOf('`', bodyStart)).split(/\s+/).filter(Boolean);

  // 合并后的源表自身零重复：同一个「简体字 + 繁体写法」只出现一次
  assert.equal(new Set(tokens).size, tokens.length, '合并后的源表仍有重复条目');
  // 同一个简体字在源表里只能有一种繁体写法（有冲突就该进 PAIR_CONFLICTS）
  assert.equal(new Set(tokens.map((t) => t[0])).size, tokens.length, '同一个简体字在源表里有两种写法');
  // parsePairs 在这份表上零丢弃：导出条目数 / 顺序与源表逐项相同（旧两段靠它静默去重）
  assert.equal(s2t.S2T_PAIRS.length, tokens.length, 'parsePairs 丢弃了条目：源表不是一份去重表');
  assert.deepEqual(s2t.S2T_PAIRS, tokens, '导出顺序应与源表首次出现顺序一致');
  assert.equal(s2t.S2T_SIZE, tokens.length, '字符映射数量应与去重后的源表一致');

  // 覆盖审计（原两段都要核）：前段独有 24 条 + 后段独有的补充条目抽查，一条都不能少
  for (const pair of [
    // 原第一段独有（第二段没有再列）
    '党黨', '独獨', '儿兒', '丰豐', '广廣', '汉漢', '后後', '几幾', '据據', '么麼',
    '台臺', '万萬', '与與', '着著', '卤鹵', '聂聶', '枪槍', '伞傘', '汤湯', '汹洶',
    '锈鏽', '盐鹽', '犹猶', '云雲',
    // 原第二段独有的补充条目（第一段没有）
    '专專', '丧喪', '乌烏', '乔喬', '争爭', '于於', '亿億', '仓倉', '伟偉', '伪偽',
    '厂廠', '冈岡', '划劃', '咸鹹', '咏詠', '嘱囑', '嚣囂', '壳殼', '壶壺', '夸誇'
  ]) {
    assert.ok(s2t.S2T_PAIRS.includes(pair), `合并后缺少 ${pair}`);
  }

  // parsePairs 的去重 / 冲突记账仍是兜底：以后新增或粘贴条目再撞车时，单测仍能从
  // PAIR_CONFLICTS 抓到，而不是静默改变某个字的转换方向
  assert.match(
    source,
    /if \(seen\.has\(key\)\) \{\s*if \(seen\.get\(key\) !== token\[1\]\) conflicts\.push/,
    'parsePairs 的「同一边重复只留第一条 + 冲突记账」兜底被删了'
  );
});

test('简繁档位：只认空串 / s2t / t2s，其它值都当「不转换」', () => {
  assert.equal(s2t.normalizeMode(''), '');
  assert.equal(s2t.normalizeMode('s2t'), 's2t');
  assert.equal(s2t.normalizeMode('t2s'), 't2s');
  assert.equal(s2t.normalizeMode('S2T'), '', '大小写不认');
  assert.equal(s2t.normalizeMode('t2s '), '', '不做 trim 猜测');
  assert.equal(s2t.normalizeMode(null), '');
  assert.equal(s2t.normalizeMode(undefined), '');
  assert.equal(s2t.normalizeMode(123), '');
  assert.equal(s2t.normalizeMode('zh-tw'), '');

  assert.equal(s2t.isEnabled('s2t'), true);
  assert.equal(s2t.isEnabled('t2s'), true);
  assert.equal(s2t.isEnabled(''), false);
  assert.equal(s2t.isEnabled('bad'), false);

  assert.equal(s2t.modeLabel(''), '不转换');
  assert.equal(s2t.modeLabel('s2t'), '简体 → 繁体');
  assert.equal(s2t.modeLabel('t2s'), '繁体 → 简体');
  assert.equal(s2t.modeLabel('bad'), '不转换');
});

test('不转换 / 坏输入：原样返回，非字符串按空串处理', () => {
  const text = '后来他发现门后说话的人。\r\n\r\n第二段\uFEFF';
  assert.equal(s2t.convertText(text, ''), text, '不转换时逐字符不变');
  assert.equal(s2t.convertText(text, 'bad'), text, '坏档位不猜，按不转换');
  assert.equal(s2t.convertText(text, undefined), text);
  assert.equal(s2t.convertText('', 's2t'), '', '空串还是空串');
  assert.equal(s2t.convertText(undefined, 's2t'), '');
  assert.equal(s2t.convertText(null, 't2s'), '');
  assert.equal(s2t.convertText(123, 's2t'), '');
});

test('简 → 繁：常用字、词组纠正、标点换行都不动', () => {
  const input = '后来他发现，门后说话的人头发干净，计划着怎么收获，什么也没有。';
  const expected = '後來他發現，門後說話的人頭髮乾淨，計劃著怎麼收穫，什麼也沒有。';
  assert.equal(s2t.convertText(input, 's2t'), expected);

  // 一简对多繁的常见词：短语表纠正（头发 / 髮，干净 / 乾，皇后 / 后）
  assert.equal(s2t.convertText('头发', 's2t'), '頭髮');
  assert.equal(s2t.convertText('理发师给白发老人剪头发', 's2t'), '理髮師給白髮老人剪頭髮');
  assert.equal(s2t.convertText('皇后和太后在后宫', 's2t'), '皇后和太后在後宮');
  assert.equal(s2t.convertText('地面上面有条面条', 's2t'), '地面上面有條麵條');
  assert.equal(s2t.convertText('一只猫和一只狗', 's2t'), '一隻貓和一隻狗');
  assert.equal(s2t.convertText('关系很好，联系不上', 's2t'), '關係很好，聯繫不上');
  assert.equal(s2t.convertText('乾隆年间很干净', 's2t'), '乾隆年間很乾淨');
  assert.equal(s2t.convertText('稻田里种稻谷', 's2t'), '稻田裡種稻穀');
  assert.equal(s2t.convertText('他舍不得走，施舍了一点钱', 's2t'), '他捨不得走，施捨了一點錢');

  // 空白 / 数字 / 英文 / 标点 / 换行原样保留
  const mixed = '第1章　Hello, world!\r\n\t（测试）……「引号」';
  const converted = s2t.convertText(mixed, 's2t');
  assert.equal(converted, '第1章　Hello, world!\r\n\t（測試）……「引號」');
  assert.equal(converted.length, mixed.length, '转换前后长度不变');
});

test('简 → 繁：歧义字不硬转，短语没覆盖就保持原样（宁可不转，也不转错）', () => {
  // 这些字在繁体里另有写法，字表故意不收；单独出现时保持原样
  const ambiguous = '只 系 面 余 谷 舍 志 制 表 松 向 周 采 游 折 征 致 占 注 卷 刮 胡 回 家 克 困 累 蒙 佣 秋 姜 郁 丑';
  assert.equal(s2t.convertText(ambiguous, 's2t'), ambiguous);
  // 但常用词由短语表覆盖
  assert.equal(s2t.convertText('只有一只船', 's2t'), '只有一隻船');
  assert.equal(s2t.convertText('计划周末旅游', 's2t'), '計劃週末旅遊');
  assert.equal(s2t.convertText('制作复杂的表格', 's2t'), '製作複雜的表格');
  assert.equal(s2t.convertText('松树很轻松', 's2t'), '松樹很輕鬆');
  assert.equal(s2t.convertText('着急的著作', 's2t'), '著急的著作');
  // 字表里没有的字（生僻字 / 繁体本字 / 表情）原样保留
  assert.equal(s2t.convertText('龘𠮷😀', 's2t'), '龘𠮷😀');
});

// C21（整合版审计）：简体的「里 / 划」同时是繁体里的另一个本字（里 = 长度 / 行政单位，
// 划 = 划船 / 划火柴），字表按最常用义收「里→裡」「划→劃」之后，常见词会被主动转错
// （公里→公裡、划破→劃破）。按模块「宁可不转，也不转错」的政策，用短语表的保持词条纠正。
test('简 → 繁：「里 / 划」的常见词保持原字（C21）', () => {
  // [简体, 繁体]：简→繁逐字钉住；繁→简必须回到同一个简体；长度必须相等（字数统计不受影响）
  const protectedWords = [
    ['公里', '公里'], ['里程', '里程'], ['里程碑', '里程碑'], ['英里', '英里'],
    ['海里', '海里'], ['华里', '華里'], ['千里', '千里'], ['百里', '百里'],
    ['万里', '萬里'], ['邻里', '鄰里'], ['乡里', '鄉里'], ['故里', '故里'],
    ['里弄', '里弄'], ['里巷', '里巷'], ['里长', '里長'],
    ['划破', '划破'], ['划火柴', '划火柴'], ['划伤', '划傷'], ['划痕', '划痕'],
    ['划得来', '划得來'], ['划不来', '划不來']
  ];
  for (const [simp, trad] of protectedWords) {
    assert.equal(s2t.convertText(simp, 's2t'), trad, `简→繁：${simp}`);
    assert.equal(s2t.convertText(trad, 't2s'), simp, `繁→简：${trad}`);
    assert.equal(trad.length, simp.length, `长度不变：${simp}`);
    // 短语表里真有这条保持词条：以后删掉它字表又会把词转错，这里先钉住
    assert.ok(
      s2t.S2T_PHRASES.some(([from, to]) => from === simp && to === trad),
      `短语表缺少保护词条：${simp}=${trad}`
    );
  }
  // 句子里同样生效（不是只在孤立词上）
  assert.equal(
    s2t.convertText('从这里出发，走了三公里，火柴划破了手。', 's2t'),
    '從這裡出發，走了三公里，火柴划破了手。'
  );

  // 反例：「里」当「里面」讲、「划」当「计划 / 划分」讲时必须照常转，保护不能越界
  const stillConverted = [
    ['这里', '這裡'], ['那里', '那裡'], ['哪里', '哪裡'], ['心里', '心裡'],
    ['手里', '手裡'], ['家里', '家裡'], ['城里', '城裡'], ['夜里', '夜裡'],
    ['里头', '裡頭'], ['里边', '裡邊'], ['里外', '裡外'], ['里面', '裡面'],
    ['骨子里', '骨子裡'],
    ['计划', '計劃'], ['划分', '劃分'], ['划时代', '劃時代'], ['策划', '策劃'],
    ['规划', '規劃'], ['划清', '劃清'], ['划一', '劃一']
  ];
  for (const [simp, trad] of stillConverted) {
    assert.equal(s2t.convertText(simp, 's2t'), trad, `该转的还是要转：${simp}`);
  }
  // 本轮是「加保护词条」，不是「把字移出字表」：字表仍保留这两个常用映射
  for (const pair of ['里裡', '划劃']) {
    assert.ok(s2t.S2T_PAIRS.includes(pair), `字表应仍保留 ${pair}`);
  }
});

test('繁 → 简：多对一映射、语境例外、常见词', () => {
  const input = '後來他發現，門後說話的人頭髮乾淨，計劃著怎麼收穫，什麼也沒有。';
  const expected = '后来他发现，门后说话的人头发干净，计划着怎么收获，什么也没有。';
  assert.equal(s2t.convertText(input, 't2s'), expected);

  // 多对一：發 / 髮 都变回 发
  assert.equal(s2t.convertText('白髮 and 發現', 't2s'), '白发 and 发现');
  // 语境例外：著作 / 著名 / 乾隆 保持原样，动词「著」按短语改「着」
  assert.equal(s2t.convertText('他的著作很著名，乾隆年间', 't2s'), '他的著作很著名，乾隆年间');
  assert.equal(s2t.convertText('他看著我，坐著不動', 't2s'), '他看着我，坐着不动');
  assert.equal(s2t.convertText('瞭解、明瞭、瞭望', 't2s'), '了解、明了、瞭望');
  assert.equal(s2t.convertText('藉口和憑藉', 't2s'), '借口和凭借');
  assert.equal(s2t.convertText('穿著、計畫、傢俱、規畫', 't2s'), '穿着、计划、家具、规划');
  assert.equal(s2t.convertText('週末、一隻、麵條、穀物、輕鬆、剩餘', 't2s'), '周末、一只、面条、谷物、轻松、剩余');
  // 空白 / 数字 / 英文 / 标点 / 换行原样保留
  const mixed = '第1章　Hello, world!\r\n\t（測試）……「引號」';
  assert.equal(s2t.convertText(mixed, 't2s'), '第1章　Hello, world!\r\n\t（测试）……「引号」');
});

test('简繁互转：无歧义句子来回一致，长度始终不变', () => {
  const simplified = '后来他发现门后说话的人头发干净，什么也没有。';
  const traditional = s2t.convertText(simplified, 's2t');
  assert.equal(traditional, '後來他發現門後說話的人頭髮乾淨，什麼也沒有。');
  assert.equal(s2t.convertText(traditional, 't2s'), simplified, '来回转换回到原文');
  assert.equal(traditional.length, simplified.length, '长度不变（字数统计不受影响）');
  // 长文本也保持长度不变（含换行 / 标点 / 数字）
  const long = `${simplified}\r\n`.repeat(200);
  const convertedLong = s2t.convertText(long, 's2t');
  assert.equal(convertedLong.length, long.length);
  assert.equal((convertedLong.match(/\r\n/g) || []).length, 200, '换行没有被吞掉');
});

test('书目显示字段：书名 / 作者 / 章名 / 卷名跟着转，id / 文件名 / 结构字段不动', () => {
  const meta = {
    id: 'book-1',
    title: '门后的人',
    author: '说话人',
    schemaVersion: 1,
    chapters: [
      { id: 'c1', file: '001.txt', name: '开端', chars: 12 },
      { id: 'c2', file: '002.txt', name: '', chars: 0 },
      { id: 'c3', file: '003.txt', name: '说话', chars: 0 }
    ],
    volumes: [
      { id: 'v1', name: '上卷' },
      { id: 'v2', name: '' }
    ]
  };
  const before = JSON.stringify(meta);
  const converted = s2t.convertMeta(meta, 's2t');
  assert.equal(JSON.stringify(meta), before, '不修改调用方对象');
  assert.equal(converted.title, '門後的人');
  assert.equal(converted.author, '說話人');
  assert.equal(converted.chapters[0].name, '開端');
  assert.equal(converted.chapters[1].name, '', '空章名还是空');
  assert.equal(converted.chapters[2].name, '說話');
  assert.equal(converted.volumes[0].name, '上卷');
  assert.equal(converted.volumes[1].name, '');
  // 结构字段一律不动
  assert.equal(converted.id, 'book-1');
  assert.equal(converted.schemaVersion, 1);
  assert.deepEqual(
    converted.chapters.map((c) => [c.id, c.file, c.chars]),
    [['c1', '001.txt', 12], ['c2', '002.txt', 0], ['c3', '003.txt', 0]]
  );
  assert.deepEqual(converted.volumes.map((v) => v.id), ['v1', 'v2']);

  // 不转换 / 坏输入：原对象直接返回，不复制也不改
  assert.equal(s2t.convertMeta(meta, ''), meta);
  assert.equal(s2t.convertMeta(meta, 'bad'), meta);
  assert.equal(s2t.convertMeta(null, 's2t'), null);
  assert.equal(s2t.convertMeta(undefined, 's2t'), undefined);
  assert.equal(s2t.convertMeta('not-meta', 's2t'), 'not-meta');
  // 缺 chapters / volumes 的旧书目也不崩
  const oldMeta = { id: 'x', title: '旧书' };
  assert.deepEqual(s2t.convertMeta(oldMeta, 't2s'), { id: 'x', title: '旧书' });
});

// IO-01（2026-11-26 审计）：繁→简的反推只来自 S2T 字表 + T2S_EXTRA，而 S2T 按政策不收
// 干 / 冲 / 布 / 卜（一简对多繁）—— 补充表又漏了对应的 幹 / 衝 / 佈 / 蔔，导致「幹部衝動佈置」
// 这种正常繁体句子转不回简体。「萝卜」的「卜」同理（单字转必然是「蘿卜」，占卜 的 卜 不能动），
// 只能走短语表。这里双向钉住，并守住「宁可不转，也不转错」。
test('繁 → 简补充表 + 萝卜短语（IO-01）', () => {
  // 繁 → 简：一个成句的繁体句子逐字回到简体
  assert.equal(s2t.convertText('幹部衝動佈置', 't2s'), '干部冲动布置');
  // 四个补充字单独也都能回（蔔 只可能出现在萝卜这类词里，不应改变其它用法）
  assert.equal(s2t.convertText('幹 衝 佈 蔔', 't2s'), '干 冲 布 卜');
  // 简 → 繁：萝卜 的 卜 走短语（占卜 仍是 占卜，字表不收 卜）
  assert.equal(s2t.convertText('萝卜', 's2t'), '蘿蔔');
  assert.equal(s2t.convertText('胡萝卜', 's2t'), '胡蘿蔔');
  assert.equal(s2t.convertText('占卜', 's2t'), '占卜', '占卜 不能被萝卜的短语带偏');
  // 来回复原：短语与补充表要能对上（不然导出的繁体稿再导回简体会残留）
  const simplified = '萝卜和胡萝卜';
  assert.equal(s2t.convertText(s2t.convertText(simplified, 's2t'), 't2s'), simplified);
  // 补充条目必须是这次明确加的四对，不能被反推 / 别的条目顶掉
  for (const pair of ['幹干', '衝冲', '佈布', '蔔卜']) {
    assert.ok(s2t.T2S_EXTRA_PAIRS.includes(pair), `繁→简补充表缺少 ${pair}`);
  }
  // 短语表里真有萝卜的保持词条（单字表永远转不对，删掉就回退）
  assert.ok(
    s2t.S2T_PHRASES.some(([from, to]) => from === '萝卜' && to === '蘿蔔'),
    '短语表缺少 萝卜=蘿蔔'
  );
});
