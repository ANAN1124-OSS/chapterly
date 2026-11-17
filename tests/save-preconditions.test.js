// WP1（审计 E-N1 / E-N2，中 #1/#2）：保存前置条件补全。
//
// 三条契约（先红后绿）：
//   1) 书目身份 stamp：prepareChapterSave 返回它读到的 书目.json 身份（size + mtimeMs）；
//      chapter:save 把这份 stamp 交给 writeBookMeta，写前核对——不一致（含被外部换大 / 删掉）就抛
//      META_CHANGED，一个字节都不写、也不轮换 .bak。外部同步盘 / 另一实例并发改书目不再被整份覆盖。
//   2) 章节内容指纹：编辑器载入（chapter:load → { track:true }）记下「那一版」的首尾哈希；
//      保存前 mtime 对得上但内容变了（rsync -t / robocopy /COPY:DAT / 部分同步盘）→ EXTERNAL_CHANGE。
//      指纹口径与搜索索引每章 contentHash 完全一致（core/chapter-fingerprint.js 唯一实现）。
//   3) 普通保存轮换 .bak：writeBookMeta 新增 rotateBak（默认 false，老调用方语义不变），
//      chapter:save 显式开启——每次正文保存都把「写盘前的 书目.json」原样留成 .bak。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const openBooks = require('../core/open-books');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
// 源码在工作树里是 CRLF；静态闸门只关心语义，统一成 LF 再切片（免得 indexOf 落空）
const read = (rel) => fss.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

async function mkTmp() {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-save-precond-')));
}

// 与生产同形的演练书：书文件夹名含空格、一章正文已落盘。
async function makeBook(root, title = '保存 前置 空格') {
  const created = await storage.createBook(root, title);
  const bookPath = created.path;
  const first = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, first.chapters[0].file, '阿明走进屋里。');
  const meta = await storage.readBookMeta(bookPath);
  return { bookPath, meta };
}

function channelBody(source, channel) {
  const start = source.indexOf(`handleBook('${channel}'`);
  assert.ok(start > 0, `main.js 里找不到 ${channel}`);
  const end = source.indexOf('\n  });', start + 1);
  assert.ok(end > start, `${channel} 的注册体找不到结尾`);
  return source.slice(start, end);
}

// ---------- R1：书目身份 stamp 不一致 → META_CHANGED，外部那一版原样保留 ----------
test('R1（E-N1）：载入后外部改了 书目.json → 写前核对 stamp 抛 META_CHANGED，外部版本逐字节保留、不轮换 .bak', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root, '保存 前置 空格 R1');
  assert.ok(bookPath.includes(' '), '用例前提：书文件夹路径含空格（含空格路径注入）');
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');

  // 与 chapter:save 同形：先 prepare 读到 T1 meta（拿到 stamp），再写正文 / 写 meta。
  const prepared = await storage.prepareChapterSave(bookPath, meta.chapters[0].id);
  assert.ok(prepared.metaStamp && prepared.metaStamp.size > 0, 'prepareChapterSave 必须返回书目文件身份 stamp');

  // 外部同步盘在「读 meta 之后、写 meta 之前」写入新版书目（多了一章）。
  const external = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  external.chapters.push({
    id: 'ch_ext_1',
    file: '999-外部新增.txt',
    name: '外部新增章',
    createdAt: new Date().toISOString()
  });
  const externalBytes = `${JSON.stringify(external, null, 2)}\n`;
  await fs.writeFile(metaPath, externalBytes, 'utf8');

  await assert.rejects(
    () =>
      storage.writeBookMeta(bookPath, prepared.meta, {
        ensureDir: false,
        rotateBak: true,
        expectedStamp: prepared.metaStamp
      }),
    (err) => {
      assert.equal(err.code, 'META_CHANGED');
      assert.match(err.message, /应用外/);
      assert.match(err.message, /没有写盘/);
      assert.equal(err.message.includes(root), false, '错误文案不带本机完整路径');
      return true;
    }
  );
  assert.equal(await fs.readFile(metaPath, 'utf8'), externalBytes, '外部那一版书目必须原样保留（不静默覆盖）');
  assert.equal(await storage.exists(bakPath), false, '被拒绝的保存一个字节都不写，也不轮换 .bak');
});

// ---------- R2：stamp 一致 → 写盘成功，普通保存也把上一版轮换成 .bak ----------
test('R2（E-N1）：stamp 一致 → 写盘成功，普通保存（rotateBak）把写盘前的上一版逐字节留成 .bak', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root, '保存 前置 空格 R2');
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');

  const prepared = await storage.prepareChapterSave(bookPath, meta.chapters[0].id);
  const before = await fs.readFile(metaPath, 'utf8');
  const saved = await storage.saveChapterText(bookPath, prepared.chapter.file, '小明走进屋里。', { ensureDir: false });
  prepared.chapter.chars = saved.chars;
  const written = await storage.writeBookMeta(bookPath, prepared.meta, {
    ensureDir: false,
    rotateBak: true,
    expectedStamp: prepared.metaStamp
  });

  assert.equal(written.chapters[0].chars, saved.chars, '书目里的字数缓存要随保存更新');
  assert.equal(await fs.readFile(bakPath, 'utf8'), before, '.bak 必须逐字节等于写盘前的上一版（不是重新序列化）');
  assert.notEqual(await fs.readFile(metaPath, 'utf8'), before, '主文件已经是最新版');
});

// ---------- R3：连续两次普通保存 → .bak 始终是「上一次写盘的那一版」 ----------
test('R3（E-N1）：连续两次普通保存 → 第二次后的 .bak 正好是第一次写盘后的主文件', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root, '连续保存 备份');
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  const chapterId = meta.chapters[0].id;

  const first = await storage.prepareChapterSave(bookPath, chapterId);
  const firstSaved = await storage.saveChapterText(bookPath, first.chapter.file, '第一版。', { ensureDir: false });
  first.chapter.chars = firstSaved.chars;
  await storage.writeBookMeta(bookPath, first.meta, {
    ensureDir: false,
    rotateBak: true,
    expectedStamp: first.metaStamp
  });
  const afterFirstSave = await fs.readFile(metaPath, 'utf8');

  const second = await storage.prepareChapterSave(bookPath, chapterId);
  const secondSaved = await storage.saveChapterText(bookPath, second.chapter.file, '第二版，更长一点。', { ensureDir: false });
  second.chapter.chars = secondSaved.chars;
  await storage.writeBookMeta(bookPath, second.meta, {
    ensureDir: false,
    rotateBak: true,
    expectedStamp: second.metaStamp
  });

  assert.equal(await fs.readFile(bakPath, 'utf8'), afterFirstSave, '.bak 必须滚动成「上一次写盘的那一版」');
});

// ---------- R4：保留 size+mtime 的外部改写 → 内容指纹不一致 → EXTERNAL_CHANGE ----------
test('R4（E-N2）：保留 size+mtime 的外部改写（rsync -t / robocopy /COPY:DAT）→ EXTERNAL_CHANGE，正文一个字节不动', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root, '指纹 保留时间戳');
  const chapter = meta.chapters[0];
  const filePath = path.join(bookPath, chapter.file);

  // 先把 mtime 钉到整毫秒（Windows utimes 能精确还原），再走编辑器载入链路记录基线。
  const pinned = new Date(1700000000000);
  await fs.utimes(filePath, pinned, pinned);
  const loaded = await storage.loadChapterText(bookPath, chapter.file, { track: true });
  assert.equal(loaded.mtimeMs, pinned.getTime(), '用例前提：载入时 mtime 是钉住的那一版');

  // 外部改写：同字节长度（中文 3 字节/字）、时间戳原样保留。
  const before = await fs.readFile(filePath, 'utf8');
  const rewritten = before.replace('阿明', '小明');
  assert.equal(Buffer.byteLength(rewritten, 'utf8'), Buffer.byteLength(before, 'utf8'), '用例前提：改写前后字节数相同');
  await fs.writeFile(filePath, rewritten, 'utf8');
  await fs.utimes(filePath, pinned, pinned);
  const after = await fs.stat(filePath);
  assert.equal(after.mtimeMs, loaded.mtimeMs, '用例前提：改写后 mtime 仍是载入时那一版（时间戳被保留）');
  assert.equal(after.size, loaded.size, '用例前提：改写后 size 不变');

  await assert.rejects(
    () => storage.prepareChapterSave(bookPath, chapter.id, { expectedMtimeMs: loaded.mtimeMs }),
    (err) => {
      assert.equal(err.code, openBooks.CODE.EXTERNAL_CHANGE);
      assert.match(err.message, /时间戳/);
      assert.match(err.message, /内容/);
      assert.match(err.message, /已阻止这次保存/);
      return true;
    }
  );
  assert.equal(await fs.readFile(filePath, 'utf8'), rewritten, '被拦下的保存绝不写盘（外部那一版原样留着）');
});

// ---------- R5：main.js 接线（stamp + rotateBak + META_CHANGED 部分成功回包） ----------
test('R5（静态接线）：chapter:save 传 expectedStamp + rotateBak，META_CHANGED 按「正文已落盘」单独回包', () => {
  const body = channelBody(read('main.js'), 'chapter:save');
  assert.match(
    body,
    /storage\.writeBookMeta\(bookPath, meta, \{ ensureDir: false, rotateBak: true, expectedStamp: prepared\.metaStamp \}\)/,
    'chapter:save 必须带 expectedStamp（书目身份）与 rotateBak（普通保存也留上一版），且保留 ensureDir:false'
  );
  assert.ok(body.includes("metaErr.code === 'META_CHANGED'"), 'META_CHANGED 要有单独回包分支');
  assert.match(body, /正文已写入磁盘，但书目在保存途中被应用外的程序改过/, '回包文案必须说明「正文已落盘、书目没更新」');
  assert.ok(body.includes("code: 'META_CHANGED'"), 'META_CHANGED 错误码原样带给渲染层（救稿出口按码分支）');
  assert.ok(body.includes("code: 'META_SAVE_FAILED'"), '其它书目写失败仍是 A7 的 META_SAVE_FAILED 部分成功（语义不变）');
  assert.ok(body.includes('bodySaved: true'), 'META_SAVE_FAILED 的 partial 字段不回退');
});

// ---------- R6：ipc chapter:load 记录「编辑器载入那一版」指纹 ----------
test('R6（静态接线）：ipc/book.js 的 chapter:load 用 { track: true } 记录内容指纹基线', () => {
  const src = read('ipc/book.js');
  const start = src.indexOf("handleBook('chapter:load'");
  assert.ok(start > 0, 'ipc/book.js 里找不到 chapter:load');
  const body = src.slice(start, start + 400);
  assert.match(body, /loadChapterText\(bookPath, file, \{ track: true \}\)/, 'chapter:load 必须带 { track: true }（否则生产链路没有内容基线）');
});

// ---------- 失败注入 F1：含空格路径 × 书目只读（EPERM/EACCES/EBUSY） ----------
test('F1（E-N1）：含空格路径 × 书目只读 → 权限类错误、主文件逐字节不变、不留临时文件；恢复后可重试成功', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root, '保存 前置 空格 权限');
  const metaPath = path.join(bookPath, '书目.json');
  const before = await fs.readFile(metaPath, 'utf8');

  const prepared = await storage.prepareChapterSave(bookPath, meta.chapters[0].id);
  await fs.chmod(metaPath, 0o444);
  let failure = null;
  try {
    await storage.writeBookMeta(bookPath, prepared.meta, {
      ensureDir: false,
      rotateBak: true,
      expectedStamp: prepared.metaStamp
    });
  } catch (err) {
    failure = err;
  } finally {
    await fs.chmod(metaPath, 0o666);
  }
  assert.ok(failure, '书目只读时必须写盘失败（否则这个注入没有意义）');
  assert.ok(
    ['EPERM', 'EACCES', 'EBUSY'].includes(failure.code),
    `应为权限 / 占用类错误，实际 ${failure.code}`
  );
  assert.equal(await fs.readFile(metaPath, 'utf8'), before, '失败时主文件一个字节不变');
  const leftovers = (await fs.readdir(bookPath)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '不许留下原子写临时文件');

  // 恢复权限后照常能写：一次失败不把书卡成只读（stamp 重新读、不沿用旧基线）。
  const again = await storage.prepareChapterSave(bookPath, (await storage.readBookMeta(bookPath)).chapters[0].id);
  await assert.doesNotReject(() =>
    storage.writeBookMeta(bookPath, again.meta, {
      ensureDir: false,
      rotateBak: true,
      expectedStamp: again.metaStamp
    })
  );
});

// ---------- 失败注入 F2：书目被外部换成超大文件（稀疏） ----------
test('F2（E-N1）：书目被外部换成超大文件 → META_CHANGED，超大文件原样留着、.bak 不创建（不整份读进内存）', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root, '书目换大文件');
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  const prepared = await storage.prepareChapterSave(bookPath, meta.chapters[0].id);

  const hugeSize = storage.MAX_META_READ_BYTES + 1024;
  await fs.truncate(metaPath, hugeSize); // 稀疏文件：只改大小
  await assert.rejects(
    () =>
      storage.writeBookMeta(bookPath, prepared.meta, {
        ensureDir: false,
        rotateBak: true,
        expectedStamp: prepared.metaStamp
      }),
    (err) => err.code === 'META_CHANGED'
  );
  assert.equal((await fs.stat(metaPath)).size, hugeSize, '超大文件必须原样留着（一个字节都不能写）');
  assert.equal(await storage.exists(bakPath), false, '超大上一版不许被读进内存再轮换');
});

// ---------- 失败注入 F3：超大 meta（META_TOO_LARGE）先于 stamp 核对 ----------
test('F3（E-N1）：超大 meta 报 META_TOO_LARGE，主文件与 .bak 一个字节都不写（写侧 32 MB 闸门不回退）', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root, '超大书目闸门');
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  const before = await fs.readFile(metaPath, 'utf8');
  const prepared = await storage.prepareChapterSave(bookPath, meta.chapters[0].id);
  const huge = {
    ...prepared.meta,
    chapters: [{ ...prepared.meta.chapters[0], name: 'x'.repeat(storage.MAX_META_READ_BYTES + 1024) }]
  };
  await assert.rejects(
    () =>
      storage.writeBookMeta(bookPath, huge, {
        ensureDir: false,
        rotateBak: true,
        expectedStamp: prepared.metaStamp
      }),
    (err) => err.code === 'META_TOO_LARGE' && /没有写盘/.test(err.message)
  );
  assert.equal(await fs.readFile(metaPath, 'utf8'), before, '主文件一个字节没变');
  assert.equal(await storage.exists(bakPath), false, '超限时也不轮换 .bak');
});

// ---------- F5：冲突后可重试（走「仍然覆盖保存」= force，读到最新书目 → 第二次保存成功） ----------
test('F5（E-N1）：外部书目冲突后走覆盖保存（force）拿到新 stamp → 第二次保存成功（救人路径可走通）', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root, '冲突后重试');
  const metaPath = path.join(bookPath, '书目.json');
  const chapterId = meta.chapters[0].id;

  const stale = await storage.prepareChapterSave(bookPath, chapterId);
  // 外部只改了 title（合法书目），模拟同步盘落盘。
  const external = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  external.title = '冲突后重试-外部改名';
  await fs.writeFile(metaPath, `${JSON.stringify(external, null, 2)}\n`, 'utf8');
  await assert.rejects(
    () => storage.writeBookMeta(bookPath, stale.meta, { ensureDir: false, rotateBak: true, expectedStamp: stale.metaStamp }),
    (err) => err.code === 'META_CHANGED'
  );

  // 再按一次保存：stamp 已经变了，主进程会先回 EXTERNAL_CHANGE（A7/E-N6 的「部分成功回包缺 mtime」
  // 是 WP14 低批的既有缺口）；作者选「仍然覆盖保存」后走 force = expectedMtimeMs 0 —— 这里钉 storage 层：
  // force 路径不受旧 mtime / 旧指纹约束，prepare 读到最新书目（新 stamp）后正文与书目都写成功。
  const fresh = await storage.prepareChapterSave(bookPath, chapterId, { expectedMtimeMs: 0 });
  assert.equal(fresh.meta.title, '冲突后重试-外部改名', '重试必须基于外部最新书目');
  const saved = await storage.saveChapterText(bookPath, fresh.chapter.file, '重试后的正文。', { ensureDir: false });
  fresh.chapter.chars = saved.chars;
  await assert.doesNotReject(() =>
    storage.writeBookMeta(bookPath, fresh.meta, {
      ensureDir: false,
      rotateBak: true,
      expectedStamp: fresh.metaStamp
    })
  );
  const after = await storage.readBookMeta(bookPath);
  assert.equal(after.title, '冲突后重试-外部改名', '外部改的标题没有被覆盖');
  assert.equal(after.chapters[0].chars, saved.chars, '这次保存的字数缓存落到书目里');
});

// ---------- 静态闸门：writeBookMeta 的 stamp 核对也必须走同句柄，不许按路径 stat ----------
test('F6（静态闸门）：writeBookMeta 的 stamp 核对走 open → handle.stat（不新增按路径 fs.stat(metaPath)）', () => {
  const src = read('core/storage.js');
  const start = src.indexOf('async function writeBookMeta(');
  const end = src.indexOf('async function listTxtFiles(', start);
  assert.ok(start >= 0 && end > start, '找不到 writeBookMeta');
  const body = src.slice(start, end);
  assert.ok(body.includes('handle.stat()'), 'stamp / 轮换身份必须用句柄上的 fstat');
  assert.equal(body.includes('fs.stat(metaPath)'), false, '不许按路径 stat 主文件（闸门与核对会脱节）');
  assert.match(body, /META_CHANGED/, '写前身份不符要报 META_CHANGED');
  assert.match(body, /structural \|\| rotateBak/, '普通保存轮换 .bak 走显式选项，不改变默认语义');
});