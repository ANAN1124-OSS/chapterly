// B9（v1.8.0 WP-29）：自定义正文字体读取缓存。
//
// 改前 main.js 的 font:read 每次把 ≤24 MB 的字体文件整读进内存再转 ~32 MB base64 过 IPC：
// 切书（每本书可能配置了同一份字体）/ 换主题 / 重新打开同一本书都会重复读盘 + 编码。
// 字体文件在两次读取之间极少变化，这里按「realpath + mtime + size」缓存 base64 结果：
//   · 路径 / 修改时间 / 大小任一变化 → key 不同 → 自然失效（外部替换字体文件也能读到新内容）；
//   · 只缓存最近 maxEntries（默认 2）份，大字体不会无限占内存（2 × ~32 MB 是上界）；
//   · 缓存不参与安全判定：main.js 仍然每次 realpath / 扩展名 / 大小闸门 / picked 路径校验，
//     这里只跳过「已校验过的同一个文件」的读盘与 base64 编码。
//
// 纯逻辑、不读盘（stat 由调用方做）、不依赖 Electron，Node 单测直接 require。

const DEFAULT_MAX_ENTRIES = 2;

function createFontReadCache(options) {
  const settings = options && typeof options === 'object' ? options : {};
  const rawMax = Math.floor(Number(settings.maxEntries));
  const maxEntries = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : DEFAULT_MAX_ENTRIES;
  const entries = new Map(); // key -> { name, size, base64 }

  // 字体文件的缓存键：realpath + mtimeMs + size。stat 由调用方给（它刚做过大小闸门）。
  function keyOf(filePath, stat) {
    const source = stat && typeof stat === 'object' ? stat : {};
    return [String(filePath == null ? '' : filePath), Number(source.mtimeMs) || 0, Number(source.size) || 0].join('\u0000');
  }

  // 命中时把条目挪到 Map 末尾（LRU 次序）；未命中返回 null。
  function get(key) {
    if (!key || !entries.has(key)) return null;
    const value = entries.get(key);
    entries.delete(key);
    entries.set(key, value);
    return { name: value.name, size: value.size, base64: value.base64 };
  }

  function put(key, value) {
    if (!key || !value || typeof value !== 'object') return false;
    const base64 = typeof value.base64 === 'string' ? value.base64 : '';
    if (!base64) return false;
    entries.delete(key);
    entries.set(key, {
      name: String(value.name == null ? '' : value.name),
      size: Number(value.size) || 0,
      base64
    });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
    return true;
  }

  function size() {
    return entries.size;
  }

  function clear() {
    entries.clear();
  }

  return { keyOf, get, put, size, clear, maxEntries };
}

module.exports = { createFontReadCache, DEFAULT_MAX_ENTRIES };