// 原子写的回归测试（v0.9 C-7 数据安全回归 C7）。
//
// 为什么单独一个文件：`core/atomic.js` 是「所有写盘都必须原子写」这条红线的**唯一实现**
// （临时文件 → fsync → rename，失败重试），但在此之前只有一个间接用例
// （storage.test.js 的「目标被目录占用时抛错且不残留临时文件」）。这一份把契约逐条钉住：
//   1. 重试策略：只重试 EPERM / EBUSY / EACCES / ENOTEMPTY；别的一律立刻抛，不白等。
//   2. 「要么旧完整版、要么新完整版」：失败时目标一个字节不动、临时文件不残留。
//   3. 临时文件必须和目标**同目录**（rename 不能跨卷）且以「.」开头（脏不了目录列表）。
//   4. fsync 必须在 rename **之前**（静态闸门：顺序不许调换，否则断电会丢内容）。
//   5. stripBom：BOM 的行为（读侧不再收编：CSTO-A05 删掉死导出 readJson）。
//   6. 反回退：core/storage.js 与 main.js 不许绕过 atomic 直接写盘。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const atomic = require('../core/atomic');

const RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'];
const NON_RETRY_CODES = ['ENOENT', 'ENOSPC', 'EXDEV', 'EISDIR'];

const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-atomic-') => tmpCleanup.mkTmp(prefix);

// 临时替换 fs/promises 的 rename（atomic.js 调用时查表，所以替换模块对象上的属性就能生效）。
// 返回 restore()，**必须**放在 finally 里调用，否则会把后面所有用例的写盘弄坏。
function patchRename(impl) {
  const real = fs.rename;
  Object.defineProperty(fs, 'rename', { value: impl, configurable: true, writable: true });
  return () => Object.defineProperty(fs, 'rename', { value: real, configurable: true, writable: true });
}

function fsError(code) {
  return Object.assign(new Error(`${code}: 模拟失败`), { code });
}

async function tmpEntries(dir) {
  const names = await fs.readdir(dir);
  return names.filter((name) => name.includes('.tmp-'));
}

test('重试策略：可重试错误（EPERM / EBUSY / EACCES / ENOTEMPTY）会重试，成功后返回', async () => {
  for (const code of RETRY_CODES) {
    const dir = await mkTmp();
    const from = path.join(dir, 'a.txt');
    const to = path.join(dir, 'b.txt');
    await fs.writeFile(from, '内容', 'utf8');
    let attempts = 0;
    const real = fs.rename;
    const restore = patchRename(async (src, dest) => {
      attempts += 1;
      if (attempts <= 2) throw fsError(code);
      return real.call(fs, src, dest);
    });
    try {
      await atomic.renameWithRetry(from, to);
      assert.equal(attempts, 3, `${code} 应该在第 3 次成功`);
      assert.equal(await fs.readFile(to, 'utf8'), '内容');
      assert.equal(await fs.access(from).then(() => true, () => false), false);
    } finally {
      restore();
    }
  }
});

test('重试策略：不可重试错误立刻抛（不重试、不白等）：ENOENT / ENOSPC / EXDEV / EISDIR', async () => {
  for (const code of NON_RETRY_CODES) {
    const dir = await mkTmp();
    let attempts = 0;
    const restore = patchRename(async () => {
      attempts += 1;
      throw fsError(code);
    });
    try {
      await assert.rejects(
        () => atomic.renameWithRetry(path.join(dir, 'a'), path.join(dir, 'b'), { delay: 1 }),
        (err) => err.code === code
      );
      assert.equal(attempts, 1, `${code} 不该重试`);
    } finally {
      restore();
    }
  }
});

test('重试策略：重试用尽后抛最后一次错误（tries 生效，且最后一次不再 sleep）', async () => {
  const dir = await mkTmp();
  let attempts = 0;
  const restore = patchRename(async () => {
    attempts += 1;
    throw fsError('EBUSY');
  });
  try {
    await assert.rejects(
      () => atomic.renameWithRetry(path.join(dir, 'a'), path.join(dir, 'b'), { tries: 3, delay: 1 }),
      (err) => err.code === 'EBUSY'
    );
    assert.equal(attempts, 3);
    attempts = 0;
    await assert.rejects(
      () => atomic.renameWithRetry(path.join(dir, 'a'), path.join(dir, 'b'), { tries: 1, delay: 1 }),
      (err) => err.code === 'EBUSY'
    );
    assert.equal(attempts, 1, 'tries=1 只尝试一次');
  } finally {
    restore();
  }
});

test('atomicWriteFile：写盘失败时目标文件一个字节不动、临时文件不残留（绝不出现半截文件）', async () => {
  const dir = await mkTmp();
  const target = path.join(dir, '书目.json');
  await fs.writeFile(target, '旧完整版', 'utf8');
  // EACCES 是「可重试」但这里让它一直失败：最终必须抛错，且旧文件原样
  const restore = patchRename(async () => {
    throw fsError('EACCES');
  });
  try {
    await assert.rejects(() => atomic.atomicWriteFile(target, '新内容', 'utf8'), (err) => err.code === 'EACCES');
  } finally {
    restore();
  }
  assert.equal(await fs.readFile(target, 'utf8'), '旧完整版', '目标文件必须还是旧完整版');
  assert.deepEqual(await tmpEntries(dir), [], '失败后不许留下临时文件');
});

test('atomicWriteFile：临时文件与目标同目录、以「.」开头带 .tmp-，成功后自动消失', async () => {
  const dir = await mkTmp();
  const target = path.join(dir, '001-起风.txt');
  const seen = [];
  const real = fs.rename;
  const restore = patchRename(async (src, dest) => {
    seen.push({
      sameDir: path.dirname(src) === path.dirname(dest),
      base: path.basename(src),
      targetBase: path.basename(dest),
      existsBeforeRename: await fs.access(src).then(() => true, () => false)
    });
    return real.call(fs, src, dest);
  });
  try {
    await atomic.atomicWriteFile(target, '正文', 'utf8');
  } finally {
    restore();
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sameDir, true, '临时文件必须和目标同目录（rename 不能跨卷）');
  assert.equal(seen[0].targetBase, '001-起风.txt');
  assert.match(seen[0].base, /^\.001-起风\.txt\.tmp-\d+-\d+-[a-z0-9]+$/);
  assert.equal(seen[0].existsBeforeRename, true, 'rename 之前临时文件必须已经写好');
  assert.deepEqual(await tmpEntries(dir), [], '成功后临时文件应已被 rename 走');
  assert.equal(await fs.readFile(target, 'utf8'), '正文');
});

test('静态闸门：临时文件 → fsync → rename 的顺序不许调换，失败路径要清理临时文件', async () => {
  const src = await fs.readFile(path.join(__dirname, '..', 'core', 'atomic.js'), 'utf8');
  // C6（审计 S8）：临时文件改用 'wx'（撞名 / 残留临时文件直接失败，绝不覆盖）
  const openAt = src.indexOf("fs.open(tmp, 'wx')");
  const writeAt = src.indexOf('handle.writeFile(data, encoding)');
  const syncAt = src.indexOf('await handle.sync()');
  const closeAt = src.indexOf('await handle.close()', syncAt);
  const renameAt = src.indexOf('await renameWithRetry(tmp, filePath)');
  assert.ok(openAt > 0 && writeAt > openAt, '先 open 再 writeFile');
  assert.ok(syncAt > writeAt, '写完之后必须 fsync');
  assert.ok(closeAt > syncAt, 'fsync 之后才 close');
  assert.ok(renameAt > closeAt, 'fsync + close 之后才 rename');
  assert.match(src, /catch \(err\) \{[\s\S]*?fs\.unlink\(tmp\)/, '失败路径必须删掉临时文件');
  for (const name of ['atomicWriteFile', 'renameWithRetry', 'writeJsonAtomic', 'stripBom', 'sleep']) {
    assert.equal(typeof atomic[name], 'function', `导出 ${name} 不许被删`);
  }
});

test('atomicWriteFileStream：逐块写出、整段成功后 rename，临时文件不残留', async () => {
  const dir = await mkTmp();
  const target = path.join(dir, '导出.txt');
  const seen = [];
  const real = fs.rename;
  const restore = patchRename(async (src, dest) => {
    seen.push({ src: path.basename(src), existsBeforeRename: await fs.access(src).then(() => true, () => false) });
    return real.call(fs, src, dest);
  });
  const chunks = ['\uFEFF', '第一章\r\n\r\n', '正文一\r\n\r\n', '第二章\r\n\r\n', '正文二\r\n'];
  try {
    await atomic.atomicWriteFileStream(target, async (write) => {
      for (const chunk of chunks) await write(chunk);
    });
  } finally {
    restore();
  }
  assert.equal(await fs.readFile(target, 'utf8'), chunks.join(''));
  assert.equal(seen.length, 1);
  assert.match(seen[0].src, /^\.导出\.txt\.tmp-\d+-\d+-[a-z0-9]+$/);
  assert.equal(seen[0].existsBeforeRename, true, 'rename 前所有块必须已经写完');
  assert.deepEqual(await tmpEntries(dir), [], '成功后临时文件应已被 rename 走');
  // 空块 / null 不写（分卷名可能为空）：不影响最终字节
  const target2 = path.join(dir, '空块.txt');
  await atomic.atomicWriteFileStream(target2, async (write) => {
    await write(null);
    await write('');
    await write('甲');
  });
  assert.equal(await fs.readFile(target2, 'utf8'), '甲');
});

test('atomicWriteFileStream：中途失败 → 目标文件一个字节不动、临时文件不残留（不出半截导出）', async () => {
  const dir = await mkTmp();
  const target = path.join(dir, '导出.txt');
  await fs.writeFile(target, '旧完整版', 'utf8');
  await assert.rejects(
    () =>
      atomic.atomicWriteFileStream(target, async (write) => {
        await write('新的第一块');
        throw new Error('读章节失败');
      }),
    /读章节失败/
  );
  assert.equal(await fs.readFile(target, 'utf8'), '旧完整版', '失败时目标文件必须还是旧完整版');
  assert.deepEqual(await tmpEntries(dir), [], '失败后不许留下临时文件');
  // 目标原本不存在：失败后也不许留下半截文件
  const target2 = path.join(dir, '新建.txt');
  await assert.rejects(
    () =>
      atomic.atomicWriteFileStream(target2, async (write) => {
        await write('半截');
        throw new Error('中断');
      }),
    /中断/
  );
  await assert.rejects(() => fs.access(target2), (err) => err.code === 'ENOENT', '不许落出半截文件');
  assert.deepEqual(await tmpEntries(dir), []);
});

test('静态闸门：流式原子写同样是「临时文件 → fsync → rename」，失败清临时文件', async () => {
  const src = await fs.readFile(path.join(__dirname, '..', 'core', 'atomic.js'), 'utf8');
  const fnAt = src.indexOf('async function atomicWriteFileStream(');
  assert.ok(fnAt > 0, 'atomicWriteFileStream 必须存在');
  const body = src.slice(fnAt, src.indexOf('\n}', fnAt));
  const openAt = body.indexOf("fs.open(tmp, 'wx')");
  const produceAt = body.indexOf('await produce(write)');
  const syncAt = body.indexOf('await handle.sync()');
  const closeAt = body.indexOf('await handle.close()', syncAt);
  const renameAt = body.indexOf('await renameWithRetry(tmp, filePath)');
  assert.ok(openAt > 0 && produceAt > openAt, '先开临时文件再交给写入回调');
  assert.ok(syncAt > produceAt, '所有块写完必须 fsync');
  assert.ok(closeAt > syncAt, 'fsync 之后才 close');
  assert.ok(renameAt > closeAt, 'fsync + close 之后才 rename');
  assert.match(body, /catch \(err\) \{[\s\S]*?fs\.unlink\(tmp\)/, '失败路径必须删掉临时文件');
  assert.equal(typeof atomic.atomicWriteFileStream, 'function');
});

test('atomicWriteFile：并发写不同的文件——临时文件名互不重复、全部成功、不留临时文件', async () => {
  const dir = await mkTmp();
  const bases = [];
  const real = fs.rename;
  const restore = patchRename(async (src, dest) => {
    bases.push(path.basename(src));
    return real.call(fs, src, dest);
  });
  const payloads = Array.from({ length: 20 }, (_, i) => `第${i}版 ` + 'x'.repeat(i * 37));
  try {
    await Promise.all(
      payloads.map((text, i) => atomic.atomicWriteFile(path.join(dir, `并发-${i}.txt`), text, 'utf8'))
    );
  } finally {
    restore();
  }
  assert.equal(bases.length, 20);
  assert.equal(new Set(bases).size, 20, '并发时临时文件名必须互不重复');
  assert.deepEqual(await tmpEntries(dir), [], '并发写不许留下临时文件');
  for (let i = 0; i < payloads.length; i += 1) {
    assert.equal(await fs.readFile(path.join(dir, `并发-${i}.txt`), 'utf8'), payloads[i]);
  }
});

test('atomicWriteFile：同一路径并发写也只会是「整份的某一版」，不会写出半截内容', async () => {
  // 实测（本机 Windows，5 轮）：同一路径 8 路以上同时 rename 时会争用到把 3 次重试耗尽 → 干净的 EPERM 失败；
  // 产品里同一个文件的写盘本来就被串行化（书锁 / 单窗口单书 / 一次只保存一章），所以这里钉的是红线：
  // **绝不出现半截文件**，失败也必须是可重试码且不留临时文件。
  const dir = await mkTmp();
  const target = path.join(dir, '并发.txt');
  const payloads = Array.from({ length: 5 }, (_, i) => `第${i}版 ` + 'x'.repeat(i * 37));
  const results = await Promise.allSettled(payloads.map((text) => atomic.atomicWriteFile(target, text, 'utf8')));
  for (const result of results) {
    if (result.status === 'rejected') {
      assert.ok(
        ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(result.reason.code),
        `失败只允许是可重试的系统错误：${result.reason.code}`
      );
    }
  }
  assert.ok(results.some((result) => result.status === 'fulfilled'), '至少有一次要写成功');
  const finalText = await fs.readFile(target, 'utf8');
  assert.ok(payloads.includes(finalText), '最终内容必须是某一次的完整内容（不能是拼接 / 截断）');
  assert.deepEqual(await tmpEntries(dir), [], '并发写不许留下临时文件');
});

test('writeJsonAtomic：两空格缩进 + 结尾换行，原样能读回', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, '书目.json');
  const obj = { version: 1, chapters: [{ id: 'ch_001', file: '001-起风.txt', name: '起风' }] };
  await atomic.writeJsonAtomic(file, obj);
  assert.equal(await fs.readFile(file, 'utf8'), `${JSON.stringify(obj, null, 2)}\n`);
});

test('CSTO-A05：读侧不再从 atomic 导出（生产零调用，读 JSON 由调用方 fs.readFile + stripBom 自理）', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(atomic, 'readJson'), false, 'atomic 不许再导出死读侧入口');
});

test('stripBom：只吃开头那个 BOM，普通文本 / 数字 / null 都安全', () => {
  assert.equal(atomic.stripBom('\uFEFFabc'), 'abc');
  assert.equal(atomic.stripBom('abc'), 'abc');
  assert.equal(atomic.stripBom('a\uFEFFb'), 'a\uFEFFb', '只有开头才算 BOM');
  assert.equal(atomic.stripBom(null), '');
  assert.equal(atomic.stripBom(undefined), '');
  assert.equal(atomic.stripBom(42), '42');
});

test('readJson 已删（CSTO-A05）：坏输入不会再被一个无人使用的读侧入口掩盖', () => {
  assert.equal(typeof atomic.readJson, 'undefined');
});

test('反回退：core/storage.js 与 main.js 不许绕过原子写（不直接 writeFile / writeFileSync / createWriteStream）', async () => {
  const root = path.join(__dirname, '..');
  for (const rel of ['core/storage.js', 'main.js']) {
    const src = await fs.readFile(path.join(root, rel), 'utf8');
    for (const bad of ['fs.writeFile(', 'writeFileSync(', 'createWriteStream(', 'fs.appendFile(', 'appendFileSync(']) {
      assert.equal(src.includes(bad), false, `${rel} 不许出现 ${bad}（落盘必须经过 core/atomic.js）`);
    }
    assert.match(src, /require\('\.\/atomic'\)|require\('\.\/core\/atomic'\)/, `${rel} 必须用 core/atomic.js`);
  }
  // 唯一允许直接写文件的是导入暂存目录（core/importer.js）：那里写的是「还没成为书」的临时目录，
  // 写坏了直接丢掉整个暂存目录，不会污染任何已有书 / 章节。
  const importer = await fs.readFile(path.join(root, 'core', 'importer.js'), 'utf8');
  assert.equal(importer.includes('fs.writeFile('), true, 'importer 的暂存写入是有意的（不改就不该动它）');
});
