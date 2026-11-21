/* ipc 与渲染层共用的 host 契约校验器（v1.8.0 WP-32 / 审计 A8；WP17 A2 从 renderer/assert-host.js 上移）。
 *
 * 33 个渲染层模块的 createX(host) 与 4 个 ipc 模块以前各自写一遍同样的样板：
 *   if (!host || typeof host !== 'object') throw new TypeError('createX 需要 host 对象');
 *   for (const key of REQUIRED_HOST) {
 *     if (host[key] === undefined || host[key] === null) throw new TypeError('createX 的 host 缺少 ' + key);
 *   }
 * REQUIRED_HOST 清单仍留在各模块（那是各模块自己的契约），这里只收「怎么校验」这一件事：
 * 两个错误文案逐字保留（单测按 `createX 的 host 缺少 key` / `createX 需要 host 对象` 断言），
 * 缺成员仍然在 create() 时就抛 TypeError（宁可在启动装配时炸，也不要到点开面板才 ReferenceError）。
 *
 * 契约：assertHost(name, host, required, groups?)
 *   name     —— createX 的名字，拼进错误文案（如 'createHistoryUi'）；
 *   host     —— createX 收到的 host；
 *   required —— 该模块的 REQUIRED_HOST（字符串数组，只看顶层成员存在性）；
 *   groups   —— 可选的嵌套分组规格数组 [{ path: 'editor', keys: [...] }]（RPAN-C08 / RSHE-A-05）：
 *               先沿 path 逐段判「缺 / 不是对象」，再逐键判存在性。path 允许用点号下钻
 *               （如 'peers.stats'）。三条文案与各模块原来手写的逐字一致：
 *                 `name 的 host 缺少 <path前缀>`（整组缺失）、
 *                 `name 的 host.<path前缀> 必须是对象`（值是原始类型 / 函数）、
 *                 `name 的 host.<path> 缺少 <key>`（组内缺键）。
 *               嵌套规格只写「分组的成员契约」，顶层成员仍要进 required（保持各模块的
 *               REQUIRED_HOST 清单一字不变，静态闸门按顶层计数）。
 * 通过时原样返回 host；非对象 / 缺成员直接抛 TypeError。
 *
 * 浏览器里挂成全局 CWAssertHost（index.html 排在所有消费者之前），Node 里可以直接 require。
 * 位置在 core/：ipc/*（主进程域）与 renderer/*（页面域）共用同一份实现——渲染层目录不再保留副本或
 * re-export shim，否则「一份实现」又会被拆成两条依赖路径（审计 A2）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWAssertHost = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function requireGroup(name, host, path, keys) {
    let target = host;
    let trail = '';
    for (const part of String(path).split('.')) {
      trail = trail ? trail + '.' + part : part;
      const value = target && typeof target === 'object' ? target[part] : undefined;
      if (value === undefined || value === null) throw new TypeError(name + ' 的 host 缺少 ' + trail);
      if (typeof value !== 'object') throw new TypeError(name + ' 的 host.' + trail + ' 必须是对象');
      target = value;
    }
    for (const key of keys) {
      if (target[key] === undefined || target[key] === null) {
        throw new TypeError(name + ' 的 host.' + path + ' 缺少 ' + key);
      }
    }
  }

  function assertHost(name, host, required, groups) {
    if (!host || typeof host !== 'object') throw new TypeError(name + ' 需要 host 对象');
    for (const key of required) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError(name + ' 的 host 缺少 ' + key);
      }
    }
    if (Array.isArray(groups)) {
      for (const group of groups) requireGroup(name, host, group.path, group.keys);
    }
    return host;
  }

  return { assertHost };
});
