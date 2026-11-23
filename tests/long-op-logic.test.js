const test = require('node:test');
const assert = require('node:assert/strict');
const longOpLogic = require('../renderer/long-op-logic');

// 审计 C2（v1.8.0 WP-02）：整本整理 / 还原备份这类长异步操作完成时，回执只能用在「发起时那本书」
// 上；同一本书里作者期间敲的字优先于磁盘重载。真正的异步时序由 E2E 覆盖（组 36 新增 C2 断言），
// 这里把判定表钉死，防止以后有人把「书换了」和「有未保存修改」两条前提改反。

test('长操作收尾：期间换了书 → 回执作废，不重载到另一本', () => {
  assert.equal(
    longOpLogic.decideAfterLongOp({
      expectedBookPath: 'D:\\书库\\整理测试书',
      currentBookPath: 'D:\\书库\\另一本书',
      dirty: false
    }),
    'book-changed'
  );
  // 换书时哪怕编辑区是脏的，也不能按「保留编辑区」处理——那是另一本书的正文
  assert.equal(
    longOpLogic.decideAfterLongOp({
      expectedBookPath: 'D:\\书库\\整理测试书',
      currentBookPath: 'D:\\书库\\另一本书',
      dirty: true
    }),
    'book-changed'
  );
});

test('长操作收尾：同一本书但有未保存修改 → 保留编辑区（正文优先）', () => {
  assert.equal(
    longOpLogic.decideAfterLongOp({
      expectedBookPath: 'D:\\书库\\整理测试书',
      currentBookPath: 'D:\\书库\\整理测试书',
      dirty: true
    }),
    'keep-edits'
  );
});

test('长操作收尾：同一本书且没有未保存修改 → 可以从磁盘重载', () => {
  assert.equal(
    longOpLogic.decideAfterLongOp({
      expectedBookPath: 'D:\\书库\\整理测试书',
      currentBookPath: 'D:\\书库\\整理测试书',
      dirty: false
    }),
    'reload'
  );
  // dirty 省略 / 非 true 都按「干净」处理（只有明确 true 才算会丢字）
  assert.equal(
    longOpLogic.decideAfterLongOp({
      expectedBookPath: 'D:\\书库\\整理测试书',
      currentBookPath: 'D:\\书库\\整理测试书'
    }),
    'reload'
  );
});

test('书路径比较：Windows 大小写不敏感，空值按空串', () => {
  assert.equal(longOpLogic.sameBookPath('D:\\书库\\A', 'd:\\书库\\a'), true);
  assert.equal(longOpLogic.sameBookPath('D:\\书库\\A', 'D:\\书库\\B'), false);
  assert.equal(longOpLogic.sameBookPath(null, ''), true);
  assert.equal(longOpLogic.sameBookPath(undefined, null), true);
  assert.equal(longOpLogic.sameBookPath(null, 'D:\\书库\\A'), false);
});

test('N-02：正反斜杠 / 首尾空白写法不同仍判同一本书（书架增量刷新、长操作收尾共用一份）', () => {
  // 主进程回给渲染层的路径一般已经 resolve，但只要某条通道给了正斜杠形式，
  // 以前只做 toLowerCase 的口径会把同一本书判成两本（重复书卡 / 更新落空）。
  assert.equal(longOpLogic.sameBookPath('D:/书库/甲', 'D:\\书库\\甲'), true);
  assert.equal(longOpLogic.sameBookPath('D:/书库/甲/', 'D:\\书库\\甲\\'), true);
  assert.equal(longOpLogic.sameBookPath('  D:\\书库\\甲  ', 'd:/书库/甲'), true);
  // 归一不吞掉「不同的书」：不同末级目录 / 空值仍不等
  assert.equal(longOpLogic.sameBookPath('D:/书库/甲', 'D:\\书库\\乙'), false);
  assert.equal(longOpLogic.sameBookPath('', 'D:\\书库\\甲'), false);
  // 供书架增量刷新按同一归一结果做世代号 key（不能一处归一、另一处裸 toLowerCase）
  assert.equal(longOpLogic.bookPathKey('D:/书库/甲'), longOpLogic.bookPathKey('d:\\书库\\甲'));
  assert.equal(typeof longOpLogic.bookPathKey, 'function');
});

test('重载闸门：书换了或有未保存修改一律不许从磁盘重载', () => {
  const expectedBookPath = 'D:\\书库\\整理测试书';
  assert.equal(
    longOpLogic.canReloadFromDisk({ expectedBookPath, currentBookPath: 'D:\\书库\\另一本', dirty: false }),
    false
  );
  assert.equal(longOpLogic.canReloadFromDisk({ expectedBookPath, currentBookPath: expectedBookPath, dirty: true }), false);
  assert.equal(
    longOpLogic.canReloadFromDisk({ expectedBookPath, currentBookPath: expectedBookPath, dirty: false }),
    true
  );
  // 路径大小写不同还是同一本书
  assert.equal(
    longOpLogic.canReloadFromDisk({
      expectedBookPath,
      currentBookPath: expectedBookPath.toLowerCase(),
      dirty: false
    }),
    true
  );
});

test('判定是纯函数：不依赖 DOM / 全局状态，重复调用结果稳定', () => {
  const options = { expectedBookPath: 'D:\\书库\\A', currentBookPath: 'D:\\书库\\A', dirty: false };
  assert.equal(longOpLogic.decideAfterLongOp(options), longOpLogic.decideAfterLongOp(options));
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof longOpLogic.decideAfterLongOp, 'function');
  assert.equal(typeof longOpLogic.canReloadFromDisk, 'function');
});