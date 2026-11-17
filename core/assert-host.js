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
 * 契约：assertHost(name, host, required)
 *   name     —— createX 的名字，拼进错误文案（如 'createHistoryUi'）；
 *   host     —— createX 收到的 host；
 *   required —— 该模块的 REQUIRED_HOST（字符串数组）。
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

  function assertHost(name, host, required) {
    if (!host || typeof host !== 'object') throw new TypeError(name + ' 需要 host 对象');
    for (const key of required) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError(name + ' 的 host 缺少 ' + key);
      }
    }
    return host;
  }

  return { assertHost };
});