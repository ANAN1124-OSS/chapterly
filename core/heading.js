/* 章节标题词表唯一事实源（A1 / V113，v1.8.0 WP-30）。
 *
 * 同一行文本在「导入（core/txt.js）/ 捕获（core/capture.js）/ 显示（core/chapters.js）」
 * 三处原来各有一套标题词表，差异靠人工复制维持：任何一处修订都要镜像三遍，漂移就会让
 * 「第１話 雪夜」导入不算标题、捕获却算。这里把词表与三种严格度收成一份：
 *
 *   · 数字：半角阿拉伯数字 + 汉字数字（0-9零〇一二三四五六七八九十百千万两）
 *   · 单位：章 / 节 / 回 / 卷 / 集 / 篇 / 部 / 话 / 幕（繁体「話」只在捕获场景多认）
 *   · 关键词：楔子 / 序章 / 序言 / 引子 / 前言 / 前传 / 外传 / 尾声 / 后记 /
 *             番外（篇）/ 终章 / 大结局 / 附录 / 开篇（审计修复 #50：import 也认，保证
 *             旧版合成的「开篇」章导出 txt 再导入时往返对称）
 *
 * 三个场景的**已知差异**是有意的（tests/heading.test.js 的跨场景期望表钉住，不许顺手抹平）：
 *   · import  严格：不认繁体「話」、不认全角数字；「Chapter N」在关键词分支；
 *              序号 1–12 位（更长的「第…章」更可能是正文句子）。
 *   · capture 宽松：多认繁体「話」与全角数字（pixiv / 全角版式）；「Chapter N」在关键词分支。
 *   · display 显示：不认「話」与全角数字；「Chapter N」属于「已带号标题」，
 *              序号不设上限（书目里的章名可能很长）。
 * 新增场景 / 修订词表只改这一份，别再往三个消费方各抄一段。
 *
 * 同时被 Node（core/*、单测）和渲染层（core/chapters.js / core/capture.js 经 index.html）
 * 使用，所以写成 UMD：Node 里 require 得到对象，浏览器里挂到 window.CWHeading。
 * index.html 里 core/heading.js 必须排在 chapters.js 与 capture.js 之前。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWHeading = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 词表本身：三个场景共用同一串，场景差异只在「取哪几段」。
  const HALF_NUMERALS = '0-9零〇一二三四五六七八九十百千万两';
  const FULLWIDTH_NUMERALS = '０-９';
  const MARKERS = '章节回卷集篇部话幕';
  const TRADITIONAL_MARKER = '話';
  const KEYWORDS = '楔子|序章|序言|引子|前言|前传|外传|尾声|后记|番外篇?|终章|大结局|附录';
  // 「Chapter N」：三个场景都认，只是挂在不同的交替分支上（见 englishIn）。
  const ENGLISH_SOURCE = 'Chapter\\s+\\d+';

  // 三种严格度。字段含义：
  //   numerals/markers  字符类内容（不含方括号，消费方自己套 []）
  //   keywords          关键词交替源码（不含两侧括号）
  //   numeralRun        序号重复次数（import / capture 限 1–12 位，display 不设上限）
  //   englishIn         「Chapter N」挂在 number 还是 keyword 分支；决定各场景原有正则的形状
  const PROFILES = Object.freeze({
    import: Object.freeze({
      numerals: HALF_NUMERALS,
      markers: MARKERS,
      // 审计修复 #50（E15）：旧版自动分章会把第一个标题之前的内容合成标题「开篇」；
      // 导出成 txt 再按原文章节导入时（splitChaptersRaw 走 import 词表），
      // import 不认「开篇」就会把它并进下一章正文，往返不对称。capture 的锚点词表仍不含它，
      // 但 capture.looksLikeHeading 先走 txt.parseHeading，所以最终同样认（见 tests/heading.test.js）。
      keywords: `${KEYWORDS}|开篇`,
      numeralRun: '{1,12}',
      englishIn: 'keyword'
    }),
    capture: Object.freeze({
      numerals: HALF_NUMERALS + FULLWIDTH_NUMERALS,
      markers: MARKERS + TRADITIONAL_MARKER,
      keywords: KEYWORDS,
      numeralRun: '{1,12}',
      englishIn: 'keyword'
    }),
    display: Object.freeze({
      numerals: HALF_NUMERALS,
      markers: MARKERS,
      keywords: `${KEYWORDS}|开篇`,
      numeralRun: '+',
      englishIn: 'numbered'
    })
  });

  function profile(scene) {
    const found = Object.prototype.hasOwnProperty.call(PROFILES, scene) ? PROFILES[scene] : null;
    if (!found) {
      throw new TypeError(`CWHeading：没有 ${String(scene)} 这个场景（只认 import / capture / display）`);
    }
    return found;
  }

  function numeralClass(scene) {
    return profile(scene).numerals;
  }

  function markerClass(scene) {
    return profile(scene).markers;
  }

  function numeralRun(scene) {
    return profile(scene).numeralRun;
  }

  // 关键词交替源码：import / capture 尾部带「Chapter N」（原来就在 keyword 分支里）；
  // display 不带（它的「Chapter N」属于「已带号标题」，见 numberedSource）。
  function keywordSource(scene) {
    const current = profile(scene);
    return current.englishIn === 'keyword' ? `${current.keywords}|${ENGLISH_SOURCE}` : current.keywords;
  }

  // 「第X章」/「Chapter N」这一分支：display 的「已带号标题」、capture 的锚点首段都取它。
  function numberedSource(scene) {
    const current = profile(scene);
    const numbered = `第\\s*[${current.numerals}]${current.numeralRun}\\s*[${current.markers}]`;
    return current.englishIn === 'numbered' ? `${numbered}|${ENGLISH_SOURCE}` : numbered;
  }

  // 只判开头（原「已带号标题」/「特殊标题」两条正则）
  function numberedRe(scene) {
    return new RegExp(`^(?:${numberedSource(scene)})`, 'i');
  }

  function keywordRe(scene) {
    return new RegExp(`^(?:${keywordSource(scene)})`, 'i');
  }

  // 两个分支的合集：display 的 RAW_TITLE_RE、capture 的存放兜底锚点共用这一形状。
  function anchorRe(scene) {
    return new RegExp(`^(?:${numberedSource(scene)}|${keywordSource(scene)})`, 'i');
  }

  return {
    PROFILES,
    ENGLISH_SOURCE,
    profile,
    numeralClass,
    markerClass,
    numeralRun,
    keywordSource,
    numberedSource,
    numberedRe,
    keywordRe,
    anchorRe
  };
});