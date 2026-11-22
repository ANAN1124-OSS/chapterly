// I7（三审·低）：软错误包络的唯一约定。
//
// 背景：fail() 只覆盖「抛错」的失败；另有一批频道在**成功回包**的 data 里用业务字段表达
// 「这次没做成」。收编前三种形状并存（{ saved:false } / { draft:null } / { added:false } /
// { removed:false }，其中 crash:discard-draft 同频道还两种形状），渲染层各自消费、新增频道
// 没有单一约定可循。
//
// 本文件钉三件事：
//   ① 构造器形状：软错误恒为 { ok:false, code, message }，附加字段（既有判别字段）保留；
//   ② 机器清单：SOFT_ERROR_CHANNELS 里每个频道的注册点都真的在用 softFailure；
//   ③ 防回潮：main.js / ipc/proofread.js 里不许再出现旧的软错误字面量形状。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SOFT_ERROR_FIELDS, SOFT_ERROR_CHANNELS, softFailure } = require('../ipc/soft-error');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

test('I7：softFailure 恒回 { ok:false, code, message }，附加字段保留、保留字段不可被覆盖', () => {
  assert.deepEqual(SOFT_ERROR_FIELDS, ['ok', 'code', 'message']);
  assert.deepEqual(softFailure('DRAFT_UNAVAILABLE', '草稿目录暂时不可用'), {
    ok: false,
    code: 'DRAFT_UNAVAILABLE',
    message: '草稿目录暂时不可用'
  });
  // 既有判别字段作为附加字段保留（旧渲染层按 saved / draft / added / removed 消费，语义不变）
  assert.deepEqual(softFailure('DISABLED', '关着', { saved: false, removed: 0 }), {
    ok: false,
    code: 'DISABLED',
    message: '关着',
    saved: false,
    removed: 0
  });
  // extra 里再塞 ok / code / message 一律忽略：包络的三个字段只能由构造器给
  assert.deepEqual(softFailure('X', '说明', { ok: true, code: 'OTHER', message: '别的', extra: 1 }), {
    ok: false,
    code: 'X',
    message: '说明',
    extra: 1
  });
  // 坏 extra（非对象 / 数组）不影响包络本身
  for (const bad of [null, undefined, 'text', 42, []]) {
    assert.deepEqual(softFailure('X', '说明', bad), { ok: false, code: 'X', message: '说明' });
  }
  assert.equal(Object.isFrozen(SOFT_ERROR_FIELDS), true);
  assert.equal(Object.isFrozen(SOFT_ERROR_CHANNELS), true);
});

test('I7 机器清单：清单里每个频道的注册点都在用 softFailure（新增软错误频道必须登记）', () => {
  // 机器清单直接扫原文：注释里提到频道名不会写成 handle('频道' 的注册形状。
  const sourceOf = {};
  for (const rel of ['main.js', 'ipc/proofread.js']) sourceOf[rel] = read(rel);
  const entries = Object.entries(SOFT_ERROR_CHANNELS);
  assert.ok(entries.length >= 8, `软错误频道清单太短：${entries.length}`);
  for (const [channel, file] of entries) {
    const source = sourceOf[file];
    assert.ok(source, `清单里的文件不在扫描范围：${file}`);
    const at = source.indexOf(`handle('${channel}'`);
    const atBook = source.indexOf(`handleBook('${channel}'`);
    const start = at >= 0 ? at : atBook;
    assert.ok(start >= 0, `${file} 里找不到频道 ${channel}`);
    // 切出这一条注册（到下一个两条空格缩进的 handle( / handleBook( 为止）
    const rest = source.slice(start);
    const next = rest.slice(1).search(/\n {2}(?:async function |function |handleBook\(|handle\()/);
    const block = next === -1 ? rest : rest.slice(0, next + 1);
    assert.match(block, /softFailure\(/, `${channel} 的软错误分支必须用 softFailure（不许自拼形状）`);
  }
});

test('I7 防回潮：main.js / ipc/proofread.js 不再出现旧的软错误字面量', () => {
  const LEGACY = [
    /return \{ saved: false, code/,
    /return \{ draft: null, code/,
    /return \{ removed: false/,
    /return \{ canceled: false, added: false, code/,
    /return \{ canceled: false, removed: false, code/,
    /return \{ ok: false, removed: 0, code/,
    /return \{ ok: false, code: list\.code/
  ];
  for (const rel of ['main.js', 'ipc/proofread.js']) {
    // 扫原文：下面的形状都是「return { … }」对象字面量，注释里不会出现（注释只写字段名）。
    const source = read(rel);
    for (const pattern of LEGACY) {
      assert.equal(pattern.test(source), false, `${rel} 里还有旧软错误形状：${pattern}`);
    }
  }
});
