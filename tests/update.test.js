const test = require('node:test');
const assert = require('node:assert/strict');
const updateLib = require('../core/update');

// 假网络：不真连 GitHub，按测试需要返回 {status, text} 或抛错。
function fakeFetch(response) {
  const calls = [];
  const fn = async (options) => {
    calls.push(options);
    if (response instanceof Error) throw response;
    return response;
  };
  fn.calls = calls;
  return fn;
}

function releaseJson(overrides = {}) {
  return JSON.stringify({
    tag_name: 'v0.7.0',
    name: 'v0.7.0 · 体验层',
    html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0',
    published_at: '2026-11-01T00:00:00Z',
    prerelease: false,
    draft: false,
    ...overrides
  });
}

test('检查更新：版本号解析接受 v 前缀 / 两位 / 预发布 / build 元数据', () => {
  assert.equal(updateLib.parseVersion('0.4.1').text, '0.4.1');
  assert.equal(updateLib.parseVersion(' v0.4.1 ').text, '0.4.1');
  assert.equal(updateLib.parseVersion('1.2').text, '1.2.0');
  assert.equal(updateLib.parseVersion('1').text, '1.0.0');
  assert.equal(updateLib.parseVersion('0.5.0-beta.2').text, '0.5.0-beta.2');
  assert.equal(updateLib.parseVersion('0.5.0+build.9').text, '0.5.0');
  assert.equal(updateLib.parseVersion('0.5.0-rc.1+build.9').text, '0.5.0-rc.1');
  for (const bad of ['', '   ', 'v', '0.4.1.2', '0..1', '0.4.x', '-1.0.0', '0.4.1-', '0.4.1-beta..1', null, 42]) {
    assert.equal(updateLib.parseVersion(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('检查更新：版本比较按 主.次.修订 逐段比', () => {
  assert.equal(updateLib.compareVersions('0.4.1', '0.4.1'), 0);
  assert.equal(updateLib.compareVersions('0.4.2', '0.4.1'), 1);
  assert.equal(updateLib.compareVersions('0.11.0', '0.4.9'), 1);
  assert.equal(updateLib.compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(updateLib.compareVersions('v0.4.1', '0.4.2'), -1);
  assert.equal(updateLib.isNewerVersion('0.7.0', '0.4.1'), true);
  assert.equal(updateLib.isNewerVersion('0.4.1', '0.4.1'), false);
  assert.equal(updateLib.isNewerVersion('0.4.0', '0.4.1'), false);
});

test('检查更新：预发布版排序（beta < rc、数字 < 字母、正式版最高）', () => {
  assert.equal(updateLib.compareVersions('1.0.0-beta', '1.0.0-rc.1'), -1);
  assert.equal(updateLib.compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(updateLib.compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(updateLib.compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(updateLib.compareVersions('1.0.0', '1.0.0-rc.9'), 1);
  assert.equal(updateLib.compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(updateLib.compareVersions('bad', '1.0.0'), null);
});

test('检查更新：只接受本仓库的 https GitHub Release 链接', () => {
  const good = [
    'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0',
    'https://github.com/ANAN1124-OSS/chapterly/releases/latest',
    'https://github.com/ANAN1124-OSS/chapterly/releases'
  ];
  for (const url of good) assert.equal(updateLib.safeReleaseUrl(url), url);
  const bad = [
    'http://github.com/ANAN1124-OSS/chapterly/releases',
    'https://github.com.evil.example/ANAN1124-OSS/chapterly/releases',
    'https://evil.example/ANAN1124-OSS/chapterly/releases',
    'https://github.com/ANAN1124-OSS/chapterly-evil/releases',
    'https://github.com/ANAN1124-OSS/chapterly/issues',
    'https://github.com:8443/ANAN1124-OSS/chapterly/releases',
    'https://user:pass@github.com/ANAN1124-OSS/chapterly/releases',
    'javascript:alert(1)',
    '',
    null
  ];
  for (const url of bad) assert.equal(updateLib.safeReleaseUrl(url), '', `应拒绝 ${url}`);
});

test('检查更新：没有 html_url 时按 tag 拼下载页，坏 tag 退回 Release 列表', () => {
  assert.equal(
    updateLib.releasePageUrl('v0.7.0'),
    'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0'
  );
  assert.equal(
    updateLib.releasePageUrl('0.7.0-beta.1'),
    'https://github.com/ANAN1124-OSS/chapterly/releases/tag/0.7.0-beta.1'
  );
  assert.equal(updateLib.releasePageUrl('../evil'), updateLib.RELEASES_URL);
  assert.equal(updateLib.releasePageUrl(''), updateLib.RELEASES_URL);
});

test('检查更新：解析 GitHub Release JSON，字段清洗后只留需要的元数据', () => {
  const parsed = updateLib.parseReleasePayload(JSON.parse(releaseJson()));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.release.version, '0.7.0');
  assert.equal(parsed.release.tag, 'v0.7.0');
  assert.equal(parsed.release.name, 'v0.7.0 · 体验层');
  assert.equal(parsed.release.publishedAt, '2026-11-01T00:00:00.000Z');
  assert.equal(
    parsed.release.url,
    'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0'
  );
});

test('检查更新：恶意 html_url 退回按 tag 拼的官方下载页', () => {
  const parsed = updateLib.parseReleasePayload(
    JSON.parse(releaseJson({ html_url: 'http://evil.example/download' }))
  );
  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.release.url,
    'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0'
  );
});

test('检查更新：缺版本号 / 草稿 / 非对象都返回明确错误', () => {
  assert.equal(updateLib.parseReleasePayload(JSON.parse(releaseJson({ tag_name: '' }))).code, 'BAD_RELEASE');
  assert.equal(updateLib.parseReleasePayload(JSON.parse(releaseJson({ tag_name: 'nightly' }))).code, 'BAD_RELEASE');
  assert.equal(updateLib.parseReleasePayload(JSON.parse(releaseJson({ draft: true }))).code, 'BAD_RELEASE');
  assert.equal(updateLib.parseReleasePayload(null).code, 'BAD_RESPONSE');
  assert.equal(updateLib.parseReleasePayload([]).code, 'BAD_RESPONSE');
});

test('检查更新：发现新版本时返回 update + 当前 / 最新版本与下载页', async () => {
  const fetchText = fakeFetch({ status: 200, text: releaseJson() });
  const result = await updateLib.checkForUpdates({ currentVersion: '0.4.1', fetchText });
  assert.equal(result.status, 'update');
  assert.equal(result.currentVersion, '0.4.1');
  assert.equal(result.latestVersion, '0.7.0');
  assert.equal(result.releaseUrl, 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0');
  assert.match(result.message, /发现新版本 v0\.7\.0/);
  assert.equal(fetchText.calls.length, 1);
  assert.equal(fetchText.calls[0].url, updateLib.LATEST_RELEASE_API);
  assert.ok(fetchText.calls[0].timeoutMs >= 1500);
});

test('检查更新：同版本 / 更旧的版本都返回 latest，不会提示降级', async () => {
  const same = await updateLib.checkForUpdates({
    currentVersion: '0.7.0',
    fetchText: fakeFetch({ status: 200, text: releaseJson() })
  });
  assert.equal(same.status, 'latest');
  assert.match(same.message, /已经是最新版本/);
  const older = await updateLib.checkForUpdates({
    currentVersion: '0.9.0',
    fetchText: fakeFetch({ status: 200, text: releaseJson() })
  });
  assert.equal(older.status, 'latest');
  assert.equal(older.latestVersion, '0.7.0');
});

test('检查更新：当前版本是预发布时，同号正式版算更新', async () => {
  const result = await updateLib.checkForUpdates({
    currentVersion: '0.7.0-beta.1',
    fetchText: fakeFetch({ status: 200, text: releaseJson() })
  });
  assert.equal(result.status, 'update');
  assert.equal(result.currentVersion, '0.7.0-beta.1');
});

test('检查更新：没网 / 超时都转成友好错误，不抛错', async () => {
  const offline = Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' });
  const network = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch(offline)
  });
  assert.equal(network.status, 'error');
  assert.equal(network.code, 'NETWORK');
  assert.match(network.message, /连不上 GitHub/);

  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const timeout = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch(abort)
  });
  assert.equal(timeout.status, 'error');
  assert.equal(timeout.code, 'TIMEOUT');
  assert.match(timeout.message, /超时/);
});

test('检查更新：HTTP 404 / 403 / 500 各给一句能看懂的提示', async () => {
  const notFound = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 404, text: '' })
  });
  assert.equal(notFound.code, 'NO_RELEASE');
  assert.match(notFound.message, /还没有发布版本/);

  const limited = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 403, text: '' })
  });
  assert.equal(limited.code, 'RATE_LIMIT');

  const server = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 500, text: '' })
  });
  assert.equal(server.code, 'HTTP_ERROR');
  assert.match(server.message, /HTTP 500/);
});

test('检查更新：坏 JSON / 空响应 / 超大响应 / 坏状态都不崩', async () => {
  const badJson = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 200, text: 'not json' })
  });
  assert.equal(badJson.code, 'BAD_JSON');

  const empty = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 200, text: '   ' })
  });
  assert.equal(empty.code, 'BAD_RESPONSE');

  const huge = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 200, text: 'x'.repeat(updateLib.MAX_RESPONSE_CHARS + 1) })
  });
  assert.equal(huge.code, 'TOO_LARGE');

  const badStatus = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 'oops', text: '{}' })
  });
  assert.equal(badStatus.code, 'BAD_RESPONSE');

  const noResponse = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch(null)
  });
  assert.equal(noResponse.code, 'BAD_RESPONSE');
});

test('检查更新：当前版本坏 / 没有网络实现时返回结构化错误', async () => {
  const badCurrent = await updateLib.checkForUpdates({
    currentVersion: 'dev',
    fetchText: fakeFetch({ status: 200, text: releaseJson() })
  });
  assert.equal(badCurrent.status, 'error');
  assert.equal(badCurrent.code, 'BAD_CURRENT');

  const noFetch = await updateLib.checkForUpdates({ currentVersion: '0.4.1' });
  assert.equal(noFetch.status, 'error');
  assert.equal(noFetch.code, 'NO_FETCH');
});

test('检查更新：结果带时区无关的 ISO 时间，便于界面显示', async () => {
  const result = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 200, text: releaseJson() }),
    now: () => Date.UTC(2026, 10, 1, 3, 30, 0)
  });
  assert.equal(result.checkedAt, '2026-11-01T03:30:00.000Z');
  assert.equal(result.publishedAt, '2026-11-01T00:00:00.000Z');
});

test('检查更新：超时参数夹在 1.5–30 秒，坏值回默认', async () => {
  const fetchText = fakeFetch({ status: 200, text: releaseJson() });
  await updateLib.checkForUpdates({ currentVersion: '0.4.1', fetchText, timeoutMs: 50 });
  assert.equal(fetchText.calls[0].timeoutMs, 1500);
  await updateLib.checkForUpdates({ currentVersion: '0.4.1', fetchText, timeoutMs: 999999 });
  assert.equal(fetchText.calls[1].timeoutMs, 30000);
  await updateLib.checkForUpdates({ currentVersion: '0.4.1', fetchText, timeoutMs: 'bad' });
  assert.equal(fetchText.calls[2].timeoutMs, updateLib.DEFAULT_TIMEOUT_MS);
});

test('检查更新：模块本身不联网、不写盘，只通过传入的 fetchText 取数据', async () => {
  const before = new Set(Object.keys(require.cache));
  const fetchText = fakeFetch({ status: 200, text: releaseJson() });
  const result = await updateLib.checkForUpdates({ currentVersion: '0.4.1', fetchText });
  assert.equal(result.status, 'update');
  // 纯函数：调用前后 require 缓存不变（没有偷偷加载 fs / net / http）
  assert.deepEqual(new Set(Object.keys(require.cache)), before);
});

// ---------- 1.6.0 H5（审计 S-02）：更新响应的限长与单飞 ----------
// 旧实现只认 `content-length`：头里没有这个字段时 `res.text()` 会把整包读进内存再截断，
// 一个恶意的 / 坏的响应就能把主进程的内存顶起来。这里钉住三件事：
//   ① 流式读正文，1 MB（MAX_RESPONSE_CHARS）处停下并 cancel 掉流，返回 tooLarge 标记；
//   ② 跨 chunk 的多字节字符不乱码，正常小响应原样返回；
//   ③ in-flight 单飞：并发两次只发一次请求，结束后再点一次会重新发。
// core/update 侧新增 tooLarge 契约：明确回 TOO_LARGE，不尝试解析半个 JSON。
const updateResponseLib = require('../core/update-response');

test('检查更新：响应声明超限（tooLarge）→ 明确 TOO_LARGE，不尝试解析', async () => {
  assert.equal(updateLib.MAX_RESPONSE_CHARS, 1024 * 1024);
  const result = await updateLib.checkForUpdates({
    currentVersion: '0.4.1',
    fetchText: fakeFetch({ status: 200, text: '', tooLarge: true })
  });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'TOO_LARGE');
  assert.ok(result.message && result.message.length > 0, '要给作者一句能看懂的提示');
});

test('更新响应限长：没有 content-length 的流式响应在 1 MB 处停下并取消流（不整包读）', async () => {
  const encoder = new TextEncoder();
  const chunk = encoder.encode('x'.repeat(65536));
  const totalChunks = 128; // 8 MB：整包读完要 128 次 pull
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (pulls >= totalChunks) {
        controller.close();
        return;
      }
      pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    }
  });
  const response = new Response(stream);
  assert.equal(response.headers.get('content-length'), null, '这个桩响应必须没有 content-length');
  const out = await updateResponseLib.readResponseTextLimited(response, updateLib.MAX_RESPONSE_CHARS);
  assert.equal(out.tooLarge, true, '超限要明确标记');
  assert.equal(out.text.length, updateLib.MAX_RESPONSE_CHARS + 1, '只读到上限多一点，不整包收下');
  assert.equal(cancelled, true, '到上限就 cancel 掉流，别继续拉');
  assert.ok(pulls < 64, `1 MB 只该拉约 16 个 64 KB chunk，实际 ${pulls} 次`);
});

test('更新响应限长：跨 chunk 的多字节字符不乱码，正常小响应原样返回', async () => {
  const text = '{"tag_name":"v1.0.0","name":"章回 · 发布说明"}';
  const bytes = Buffer.from(text, 'utf8');
  const stream = new ReadableStream({
    start(controller) {
      // 故意在汉字中间切断（UTF-8 一个汉字 3 字节）
      controller.enqueue(new Uint8Array(bytes.subarray(0, 25)));
      controller.enqueue(new Uint8Array(bytes.subarray(25)));
      controller.close();
    }
  });
  const out = await updateResponseLib.readResponseTextLimited(new Response(stream), 1024);
  assert.deepEqual(out, { text, tooLarge: false });
  // 非流式 / 旧桩（只有 text()）：照旧能用
  const legacy = await updateResponseLib.readResponseTextLimited({ text: async () => text }, 1024);
  assert.deepEqual(legacy, { text, tooLarge: false });
  // 坏入参不炸
  assert.deepEqual(await updateResponseLib.readResponseTextLimited(null, 1024), { text: '', tooLarge: false });
  assert.deepEqual(await updateResponseLib.readResponseTextLimited({ text: async () => 42 }, 1024), {
    text: '',
    tooLarge: false
  });
});

test('检查更新：in-flight 单飞 —— 并发两次只发一次请求，结束后再点会重新发', async () => {
  const single = updateResponseLib.createSingleFlight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const task = async () => {
    calls += 1;
    await gate;
    return { ok: true, n: calls };
  };
  const first = single(task);
  const second = single(task);
  assert.equal(calls, 1, '第二次并发点击不能真的再发一次请求');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a, b, '并发两次拿到同一个结果对象');
  assert.deepEqual(a, { ok: true, n: 1 });
  // 请求结束后再点一次：重新发
  const third = await single(async () => {
    calls += 1;
    return { ok: true, n: calls };
  });
  assert.equal(calls, 2);
  assert.deepEqual(third, { ok: true, n: 2 });
  // 失败也要能释放（不能一次失败以后再点都返回同一个旧错误）
  const boom = single(async () => {
    calls += 1;
    throw new Error('network down');
  });
  await assert.rejects(boom, /network down/);
  const after = await single(async () => {
    calls += 1;
    return { ok: true, n: calls };
  });
  assert.equal(calls, 4);
  assert.deepEqual(after, { ok: true, n: 4 });
});

test('源码闸门：main.js 的更新检查走限长流式读 + 单飞，不再直接 res.text()', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs
    .readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  assert.match(source, /updateResponseLib\.readResponseTextLimited\(/, '更新响应要走限长流式读');
  assert.match(source, /updateResponseLib\.createSingleFlight\(/, '更新检查要加 in-flight 单飞');
  const start = source.indexOf('async function fetchReleaseResponse(');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start, '找不到 fetchReleaseResponse');
  const body = source.slice(start, end);
  assert.equal(/await res\.text\(\)/.test(body), false, 'fetchReleaseResponse 里不能再直接 res.text() 整包读');
});
