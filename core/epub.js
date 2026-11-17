// EPUB 导出：把「书目 + 各章正文」拼成一本能直接丢进阅读器 / 发给编辑的 EPUB。
//
// 这里全部是纯函数：不读盘、不依赖 Electron，zip 用 Node 内置 zlib 手拼，
// 不引入任何第三方运行时依赖（项目只有 devDependencies）。
//
// 支持按卷 / 按章节范围导出（v0.8 P0 N8）：范围解析复用 core/exporter.resolveExportRange，
// 只把选中的章节打进包里；章号、章名仍按全书顺序（和 TXT 范围导出同一规则），
// 卷名页只生成选中章节所在的卷，封面章数 = 本次导出的章数。
//
// EPUB 结构（EPUB 3，另外带一份 EPUB 2 的 toc.ncx 兜底，老阅读器也能认出目录）：
//   mimetype                        必须第一个、不压缩
//   META-INF/container.xml          指向 OEBPS/content.opf
//   OEBPS/content.opf               元数据 + manifest + spine（+ guide 兼容 EPUB2）
//   OEBPS/nav.xhtml                 EPUB3 目录：分卷 = 二级目录
//   OEBPS/toc.ncx                   EPUB2 目录兜底（分卷同样嵌套）
//   OEBPS/style.css                 段首缩进 2 字 + 段间空一行（和 TXT 导出的排版规则一致）
//   OEBPS/cover.xhtml               纯文字封面页（本书没有封面图，按提案生成文字封面）
//   OEBPS/text/volume-0001.xhtml    有名字的卷各一张卷名页（分卷 → 目录级）
//   OEBPS/text/chapter-0001.xhtml   一章一个 XHTML，文件编号 = 全书章号
const crypto = require('node:crypto');
const chaptersLib = require('./chapters');
const exporter = require('./exporter');
const { buildZip, streamZip, crc32 } = require('./zip');
// XML 字符清洗 / 转义 / 切段只有一份实现（和 DOCX 导出共用，见 core/xml.js）；
// 导出时间戳也在那里（经 core/exporter.normalizeExportInput 统一取，本文件不再直接引用）。
const { escapeXml, paragraphsFromText } = require('./xml');

const EPUB_MIMETYPE = 'application/epub+zip';
const EPUB_DIR = 'OEBPS';
const EPUB_LANGUAGE = 'zh-CN';
const EPUB_VERSION = '3.0';

// X-N11（WP18）：封面 / 目录这些固定文案以前硬编码简体，繁体导出会出现「书名 / 目录条目 /
// 正文都转繁，唯目录页大标题仍『目录』」。这里只收调用方算好的三份文案（core/epub.js 不引 s2t，
// 由 ipc/export.js 按导出档位过 convertText）；缺省 / 空串 / 非字符串回默认，默认产物不变。
const DEFAULT_EPUB_LABELS = Object.freeze({ nav: '目录', cover: '封面', toc: '目录' });

function normalizeLabels(input) {
  const raw = input && input.labels && typeof input.labels === 'object' ? input.labels : null;
  const pick = (key) => {
    const value = raw && typeof raw[key] === 'string' ? raw[key].trim() : '';
    return value || DEFAULT_EPUB_LABELS[key];
  };
  return { nav: pick('nav'), cover: pick('cover'), toc: pick('toc') };
}

// 段首缩进 2 字 + 段间留出一整行（line-height 1.75 ⇒ 空行也是 1.75em）。
// 正文里的空行在拼 HTML 时已经被丢掉，段间留白统一由这里负责，避免「双倍行距」。
const STYLE_CSS = `/* 章回导出的 EPUB：段首缩进 2 字、段间空一行 */
html {
  font-size: 100%;
}
body {
  margin: 0 1.2em;
  font-family: "Songti SC", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC", serif;
  line-height: 1.75;
  text-align: justify;
}
h1.chapter-title,
h1.part-title {
  font-size: 1.4em;
  font-weight: bold;
  text-align: center;
  text-indent: 0;
  margin: 1.2em 0 1.6em;
}
p {
  text-indent: 2em;
  margin: 0 0 1.75em 0;
}
.cover {
  margin-top: 25%;
  text-align: center;
}
.cover-title {
  font-size: 2em;
  text-indent: 0;
  margin: 0 0 1em 0;
}
.cover-meta {
  font-size: 0.9em;
  color: #666666;
  text-indent: 0;
}
.part {
  margin-top: 30%;
  text-align: center;
}
.part-title {
  text-indent: 0;
}
`;

// ---------- XML / HTML ----------
// 字符清洗 / 转义 / 切段在 core/xml.js（和 DOCX 导出共用同一份实现），这里只拼 XHTML / OPF / NCX 标签。
function xhtmlDocument({ title, lang, cssHref, body }) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE html>',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">`,
    '<head>',
    '<meta charset="utf-8"/>',
    `<title>${escapeXml(title)}</title>`,
    `<link rel="stylesheet" type="text/css" href="${escapeXml(cssHref)}"/>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

function chapterDocument({ title, text, lang, cssHref }) {
  const paragraphs = paragraphsFromText(text);
  const lines = [
    '<section epub:type="chapter" class="chapter">',
    `  <h1 class="chapter-title">${escapeXml(title)}</h1>`
  ];
  for (const paragraph of paragraphs) lines.push(`  <p>${escapeXml(paragraph)}</p>`);
  lines.push('</section>');
  return xhtmlDocument({ title, lang, cssHref, body: lines.join('\n') });
}

function volumeDocument({ title, lang, cssHref }) {
  const body = [
    '<section epub:type="part" class="part">',
    `  <h1 class="part-title">${escapeXml(title)}</h1>`,
    '</section>'
  ].join('\n');
  return xhtmlDocument({ title, lang, cssHref, body });
}

// rangeLabel 只在「按卷 / 按章节范围」导出时传（全书导出为空，封面和以前完全一样）
function coverDocument({ title, chapterCount, volumeCount, rangeLabel, lang, cssHref }) {
  const meta = [];
  if (rangeLabel) meta.push(rangeLabel);
  meta.push(`共 ${chapterCount} 章`);
  if (volumeCount > 0) meta.push(`${volumeCount} 卷`);
  const body = [
    '<section epub:type="cover" class="cover">',
    `  <h1 class="cover-title">${escapeXml(title)}</h1>`,
    `  <p class="cover-meta">${escapeXml(meta.join(' · '))}</p>`,
    '</section>'
  ].join('\n');
  return xhtmlDocument({ title, lang, cssHref, body });
}

// 目录条目：{ label, href, children? }。分卷 = 一个带 children 的条目（二级目录）。
function renderNavList(items, depth) {
  const pad = '  '.repeat(depth);
  const lines = [`${pad}<ol>`];
  for (const item of items) {
    if (item.children && item.children.length) {
      lines.push(`${pad}  <li>`);
      lines.push(`${pad}    <a href="${escapeXml(item.href)}">${escapeXml(item.label)}</a>`);
      lines.push(...renderNavList(item.children, depth + 2));
      lines.push(`${pad}  </li>`);
    } else {
      lines.push(`${pad}  <li><a href="${escapeXml(item.href)}">${escapeXml(item.label)}</a></li>`);
    }
  }
  lines.push(`${pad}</ol>`);
  return lines;
}

function navDocument({ title, lang, items, cssHref, heading = DEFAULT_EPUB_LABELS.nav }) {
  const body = [
    '<nav epub:type="toc" id="toc">',
    `  <h1>${escapeXml(heading)}</h1>`,
    ...renderNavList(items, 1),
    '</nav>'
  ].join('\n');
  return xhtmlDocument({ title, lang, cssHref, body });
}

function navDepth(items) {
  let depth = 1;
  for (const item of items) {
    if (item.children && item.children.length) depth = Math.max(depth, 1 + navDepth(item.children));
  }
  return depth;
}

function renderNavPoints(items, depth, counter) {
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const item of items) {
    counter.value += 1;
    const order = counter.value;
    lines.push(`${pad}<navPoint id="np${order}" playOrder="${order}">`);
    lines.push(`${pad}  <navLabel><text>${escapeXml(item.label)}</text></navLabel>`);
    lines.push(`${pad}  <content src="${escapeXml(item.href)}"/>`);
    if (item.children && item.children.length) {
      lines.push(...renderNavPoints(item.children, depth + 1, counter));
    }
    lines.push(`${pad}</navPoint>`);
  }
  return lines;
}

function ncxDocument({ title, identifier, lang, items }) {
  const depth = navDepth(items);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="' + escapeXml(lang) + '">',
    '  <head>',
    `    <meta name="dtb:uid" content="${escapeXml(identifier)}"/>`,
    `    <meta name="dtb:depth" content="${depth}"/>`,
    '    <meta name="dtb:totalPageCount" content="0"/>',
    '    <meta name="dtb:maxPageNumber" content="0"/>',
    '  </head>',
    `  <docTitle><text>${escapeXml(title)}</text></docTitle>`,
    '  <navMap>',
    ...renderNavPoints(items, 2, { value: 0 }),
    '  </navMap>',
    '</ncx>',
    ''
  ].join('\n');
}

function containerDocument() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    '  <rootfiles>',
    `    <rootfile full-path="${EPUB_DIR}/content.opf" media-type="application/oebps-package+xml"/>`,
    '  </rootfiles>',
    '</container>',
    ''
  ].join('\n');
}

function opfDocument({ title, identifier, modified, lang, manifest, spine, labels = DEFAULT_EPUB_LABELS }) {
  const manifestLines = manifest.map((item) => {
    const properties = item.properties ? ` properties="${escapeXml(item.properties)}"` : '';
    return `    <item id="${escapeXml(item.id)}" href="${escapeXml(item.href)}" media-type="${escapeXml(item.mediaType)}"${properties}/>`;
  });
  const spineLines = spine.map((idref) => `    <itemref idref="${escapeXml(idref)}"/>`);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<package xmlns="http://www.idpf.org/2007/opf" version="${EPUB_VERSION}" unique-identifier="pub-id" xml:lang="${escapeXml(lang)}">`,
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `    <dc:identifier id="pub-id">${escapeXml(identifier)}</dc:identifier>`,
    `    <dc:title>${escapeXml(title)}</dc:title>`,
    `    <dc:language>${escapeXml(lang)}</dc:language>`,
    `    <meta property="dcterms:modified">${escapeXml(modified)}</meta>`,
    '  </metadata>',
    '  <manifest>',
    ...manifestLines,
    '  </manifest>',
    '  <spine toc="ncx">',
    ...spineLines,
    '  </spine>',
    '  <guide>',
    `    <reference type="cover" title="${escapeXml(labels.cover)}" href="cover.xhtml"/>`,
    `    <reference type="toc" title="${escapeXml(labels.toc)}" href="nav.xhtml"/>`,
    '  </guide>',
    '</package>',
    ''
  ].join('\n');
}

// ---------- 书籍结构 ----------
// 审计修复 #24（R1）：chapterList / 入参归一 / 空书与空范围检查全部收进
// core/exporter.normalizeExportInput（和 DOCX 导出共用一份），本文件不再抄第二份。
function pad4(n) {
  return String(n).padStart(4, '0');
}

// 书目 id 稳定 ⇒ 同一本书每次导出 identifier 不变（阅读器不会当成新书重复导入）。
// 按 UUID v5 的形状补上版本位 / 变体位，避免阅读器校验 identifier 时报「不是合法 UUID」。
function bookIdentifier(seed) {
  const hex = crypto
    .createHash('sha1')
    .update(String(seed == null ? '' : seed))
    .digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalizeInput(input) {
  const { meta, chapters, texts, title, plan, stamp } = exporter.normalizeExportInput(input);
  const lang =
    typeof (input && input.language) === 'string' && input.language.trim()
      ? input.language.trim()
      : EPUB_LANGUAGE;
  // 全书导出的 identifier 和以前完全一样（同一本书每次导出不变）；
  // 按卷 / 按范围导出加上范围种子，免得阅读器把「一卷」当成整本书的另一个版本。
  const rangeSeed =
    plan.mode === 'all'
      ? ''
      : `#${plan.mode}:${
          plan.mode === 'volume' ? plan.volumeId || 'none' : `${plan.from}-${plan.to}`
        }`;
  const identifier =
    typeof (input && input.identifier) === 'string' && input.identifier.trim()
      ? input.identifier.trim()
      : bookIdentifier(`${meta.id || title}${rangeSeed}`);
  return { meta, chapters, texts, title, lang, identifier, stamp, plan, labels: normalizeLabels(input) };
}

// B1（审计 #17 / WP13）：文件清单与元数据只有这一份顺序。
// 非章节文件（mimetype / container / nav / ncx / css / cover / opf）直接给具体字符串；
// 章节文件给 { index, title } 描述符 —— buildBundle 用整本 texts 同步填，
// streamEpub 用 readText 逐章读，两边顺序 / 内容由 R3 的逐字节对拍锁住。
function bundlePlan(input) {
  const { meta, chapters, texts, title, lang, identifier, stamp, plan, labels } = normalizeInput(input);
  // 1.7.0 P4-1：分组收编到 core/exporter.groupByVolume（txt / docx / epub 共用一份）
  const groups = exporter.groupByVolume(meta, plan.indexes);
  const items = [];
  const manifest = [];
  const spine = [];
  const navItems = [];
  let volumeCount = 0;

  items.push({ name: 'mimetype', data: EPUB_MIMETYPE, store: true });
  items.push({ name: 'META-INF/container.xml', data: containerDocument() });

  manifest.push({ id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' });
  manifest.push({ id: 'ncx', href: 'toc.ncx', mediaType: 'application/x-dtbncx+xml' });
  manifest.push({ id: 'css', href: 'style.css', mediaType: 'text/css' });
  manifest.push({ id: 'cover', href: 'cover.xhtml', mediaType: 'application/xhtml+xml' });
  spine.push('cover');

  for (const group of groups) {
    const hasVolumePage = Boolean(group.volumeId && group.name);
    let volumeHref = null;
    if (hasVolumePage) {
      volumeCount += 1;
      volumeHref = `text/volume-${pad4(volumeCount)}.xhtml`;
      const id = `vol${volumeCount}`;
      items.push({
        name: `${EPUB_DIR}/${volumeHref}`,
        data: volumeDocument({ title: group.name, lang, cssHref: '../style.css' })
      });
      manifest.push({ id, href: volumeHref, mediaType: 'application/xhtml+xml' });
      spine.push(id);
    }
    const children = [];
    for (const index of group.indexes) {
      const chapter = chapters[index];
      const number = index + 1;
      const href = `text/chapter-${pad4(number)}.xhtml`;
      const id = `ch${number}`;
      // 章名 / 章号规则和 TXT 导出完全一致（core/chapters.formatTitle）：
      // 按卷编号时标题用各卷自己的章号；包内文件名 / id 仍按全书下标（内部标识，不显示）。
      const chapterTitle = chaptersLib.formatTitle(meta, index, chapter && chapter.name);
      items.push({ name: `${EPUB_DIR}/${href}`, chapter: { index, title: chapterTitle } });
      manifest.push({ id, href, mediaType: 'application/xhtml+xml' });
      spine.push(id);
      const item = { label: chapterTitle, href };
      if (hasVolumePage) children.push(item);
      else navItems.push(item);
    }
    if (hasVolumePage) navItems.push({ label: group.name, href: volumeHref, children });
  }

  items.push({
    name: `${EPUB_DIR}/nav.xhtml`,
    data: navDocument({ title, lang, items: navItems, cssHref: 'style.css', heading: labels.nav })
  });
  items.push({
    name: `${EPUB_DIR}/toc.ncx`,
    data: ncxDocument({ title, identifier, lang, items: navItems })
  });
  items.push({ name: `${EPUB_DIR}/style.css`, data: STYLE_CSS });
  items.push({
    name: `${EPUB_DIR}/cover.xhtml`,
    data: coverDocument({
      title,
      chapterCount: plan.count,
      volumeCount,
      rangeLabel: plan.mode === 'all' ? '' : plan.label,
      lang,
      cssHref: 'style.css'
    })
  });
  items.push({
    name: `${EPUB_DIR}/content.opf`,
    data: opfDocument({
      title,
      identifier,
      modified: stamp.iso,
      lang,
      manifest,
      spine,
      labels
    })
  });

  return { items, meta, chapters, texts, title, lang, identifier, stamp, plan, chapterCount: plan.count, volumeCount };
}

function buildBundle(input) {
  const planInfo = bundlePlan(input);
  const { items, texts, title, lang, identifier, stamp, plan, chapterCount, volumeCount } = planInfo;
  // 空范围检查已在 normalizeInput（core/exporter.normalizeExportInput）里统一做，这里不重复。
  const files = items.map((item) => {
    if (!item.chapter) return item;
    const text = texts[item.chapter.index] == null ? '' : texts[item.chapter.index];
    return {
      name: item.name,
      data: chapterDocument({ title: item.chapter.title, text, lang, cssHref: '../style.css' })
    };
  });
  return {
    files,
    chapterCount,
    volumeCount,
    title,
    identifier,
    modified: stamp.iso,
    date: stamp.date,
    rangeMode: plan.mode,
    rangeLabel: plan.label
  };
}

// 只产出文件清单（单测用）；写盘请用 buildEpub()
function epubFiles(input) {
  return buildBundle(input).files;
}

// 产出可写盘的 EPUB 字节（异步：zip 压缩在线程池里跑，整本导出不卡主进程）。
// input = { meta, texts, range?, language?, identifier?, modified?, zipDate? }
//   meta / texts 就绪与 TXT 导出相同的「书目 + 各章正文（顺序对齐）」；
//   range 可选（见 core/exporter.resolveExportRange）：只导出选中的卷 / 章节；
//   modified 默认现在，传固定值可让同样的内容导出成完全一样的字节（单测用）。
async function buildEpub(input) {
  const bundle = buildBundle(input);
  const zipDate = (input && input.zipDate) || bundle.date;
  const buffer = await buildZip(bundle.files, { date: zipDate });
  return {
    buffer,
    chapterCount: bundle.chapterCount,
    volumeCount: bundle.volumeCount,
    bytes: buffer.length,
    title: bundle.title,
    identifier: bundle.identifier,
    modified: bundle.modified,
    rangeMode: bundle.rangeMode,
    rangeLabel: bundle.rangeLabel
  };
}

// B1（审计 #17 / WP13）：流式导出 —— 按「卷 → 章」逐个生成 XHTML 并立刻交给 zip 写入器，
// 不再把整本 texts 数组 / 全书 XHTML 清单 / 整包 Buffer 常驻。正文由 readText(index, chapter)
// 按章读（ipc/export.js 负责覆盖章与简繁转换），峰值约为「一章 + 它的 XHTML」。
// 产物与 buildBundle → buildZip 逐字节一致（R3 对拍）；返回字段与 buildEpub 相同（没有 buffer）。
async function streamEpub(input, write) {
  if (typeof write !== 'function') throw new TypeError('streamEpub 需要写入回调');
  const planInfo = bundlePlan(input);
  const { items, chapters, texts, lang, plan, stamp } = planInfo;
  const readText = input && typeof input.readText === 'function' ? input.readText : null;
  const fallbackTexts = Array.isArray(texts) ? texts : [];
  const entries = (async function* epubEntries() {
    for (const item of items) {
      if (!item.chapter) {
        yield item;
        continue;
      }
      const { index, title } = item.chapter;
      const text = readText
        ? await readText(index, chapters[index])
        : fallbackTexts[index] == null
          ? ''
          : fallbackTexts[index];
      yield { name: item.name, data: chapterDocument({ title, text, lang, cssHref: '../style.css' }) };
    }
  })();
  const zipDate = (input && input.zipDate) || stamp.date;
  const result = await streamZip(entries, { date: zipDate }, write);
  return {
    chapterCount: planInfo.chapterCount,
    volumeCount: planInfo.volumeCount,
    bytes: result.bytes,
    title: planInfo.title,
    identifier: planInfo.identifier,
    modified: stamp.iso,
    rangeMode: plan.mode,
    rangeLabel: plan.label
  };
}

// 导出对话框默认文件名：全书 = 书名.epub；按卷 / 按范围 = 书名-范围.epub
// （范围规则和 TXT 导出完全一致，由 core/exporter.exportFileName 统一实现）
function epubFileName(meta, range) {
  return exporter.exportFileName(meta, range, 'epub');
}

module.exports = {
  buildZip,
  crc32,
  paragraphsFromText,
  epubFiles,
  buildEpub,
  streamEpub,
  epubFileName
};
