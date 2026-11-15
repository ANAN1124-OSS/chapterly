/* 书域 mutation 取值表（v1.8.0 审计修复 #38 / ▲V306）。
 *
 * handleBook(channel, fn, { mutation }) 的第三个参数同时决定三件事：
 *   ① 跨窗口拦截：mutation 非空时 storage.assertBookNotBusy() 会拒绝「别的窗口正开着这本书」的写；
 *   ② 书架广播：成功之后 notifyShelfChanged() 让其它停在书架的窗口刷新（book:set-last 是唯一例外）；
 *   ③ 语义标注：只读频道必须明确不写，不能靠「忘传参数」碰巧只读。
 * 以前书域 45 个 handleBook 调用点里只有 26 处显式带 mutation，其余是只读或漏标 ——
 * O6（chapter:save 不广播 shelf:changed，跨窗口书架字数滞后）就是漏标的产物。
 *
 * 现在书域模块对每条频道显式二选一：MUTATION.X 或 READ_ONLY；tests/book-data-ipc.test.js
 * 会解析 ipc/book.js 与 ipc/book-data.js 的注册语句逐条核对（新增频道不选就红）。
 */
const MUTATION = Object.freeze({
  SAVE: 'save',
  WRITE: 'write',
  RENAME: 'rename',
  DELETE: 'delete',
  REPLACE: 'replace',
  FORMAT: 'format'
});

// 只读频道：显式声明「不写书、不广播」。值仍是 null（handleBook 的默认语义不变），
// 但书域模块里必须写出来，不能再靠省略第三个参数表达只读。
const READ_ONLY = Object.freeze({ mutation: null });

const MUTATION_VALUES = Object.freeze(Object.values(MUTATION));

module.exports = { MUTATION, MUTATION_VALUES, READ_ONLY };