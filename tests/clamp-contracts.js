/* 跨文件的「夹紧口径」契约（T8 / 三审 4.3）。
 *
 * 背景：`longParagraphThreshold`（超长段落提示阈值）的夹紧规则在三个测试文件里各写了一遍同一张表
 * （core 配置层、编辑器标记层、设置面板回填），改一个数字要同步改三处、漏改即假红。
 * 这里只留**一份**用例表，三处都从它派生；各层断言「谁」的写法仍留在原文件
 * （配置层看数值、标记层看文案、设置面板看输入框字符串）。
 *
 * 两份表分开的理由（别把它们合并）：
 *   · LONG_PARAGRAPH_THRESHOLD_CASES：**三层同口径**的部分 —— core/config.js 的 sanitize 与
 *     renderer/editor-logic.js 的 sanitizeThreshold（clampInt）给同一个结果。
 *   · LONG_PARAGRAPH_THRESHOLD_CORE_ONLY_CASES：只有 core 配置层「按类型拒绝」的口径 ——
 *     `null` 与 `[]` 在配置层算坏类型 → 500；而 clampInt 走 Number()（Number(null)=0、
 *     Number([])=0）会夹到 50。这条差异是既有行为（配置层从严），不是要统一的东西：
 *     它只影响手改 config.json 的场景，界面输入框给不出 null / 数组。
 *
 * 表里用 { raw, expected }：expected 是夹紧后的**数值**，需要字符串的层自己 String(expected)。
 * NaN 用 Number.NaN。
 */
const LONG_PARAGRAPH_THRESHOLD_CASES = Object.freeze(
  [
    { raw: 49, expected: 50, note: '低于下限 → 夹到 50' },
    { raw: 50, expected: 50, note: '下限端点原样保留' },
    { raw: 20000, expected: 20000, note: '上限端点原样保留' },
    { raw: 20001, expected: 20000, note: '高于上限 → 夹到 20000' },
    { raw: Number.NaN, expected: 500, note: 'NaN → 默认 500' },
    { raw: 'abc', expected: 500, note: '非数字字符串 → 默认 500' },
    { raw: undefined, expected: 500, note: '缺字段 → 默认 500' },
    { raw: {}, expected: 500, note: '对象 → 默认 500' },
    { raw: Infinity, expected: 500, note: 'Infinity → 默认 500' },
    { raw: -Infinity, expected: 500, note: '-Infinity → 默认 500' }
  ].map(Object.freeze)
);

// 只有 core 配置层如此（见文件头说明）：null / [] 在配置层算坏类型 → 默认 500。
const LONG_PARAGRAPH_THRESHOLD_CORE_ONLY_CASES = Object.freeze(
  [
    { raw: null, expected: 500, note: 'null → 配置层算坏类型，默认 500' },
    { raw: [], expected: 500, note: '数组 → 配置层算坏类型，默认 500' }
  ].map(Object.freeze)
);

module.exports = { LONG_PARAGRAPH_THRESHOLD_CASES, LONG_PARAGRAPH_THRESHOLD_CORE_ONLY_CASES };
