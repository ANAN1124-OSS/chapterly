// 审计 P1 · C4 的 storage 侧闸门：两处「逐字重复」收成各一份实现。
//
// 收编前：
//   · 「按章节 id 找下标，找不到抛 CHAPTER_NOT_FOUND」在 6 个写盘入口里逐字重复 6 遍
//     （移到卷 / 拖到某卷某位置 / 重命名 / 改章节信息 / 删除章节 / 拖拽排序）；
//   · 单文件还原与整组还原各写一遍「书里已有同名文件 → 先复制进 _trash/还原前备份-* →
//     读备份 → 原子写回」。
// 行为由 tests/storage.test.js 的还原 / 删除 / 拖拽用例覆盖；这里只钉「不许再长出第二份」，
// 以及两个容易被顺手改坏的点：错误码 / 文案不变、单文件还原仍然先建好带时间戳的反向备份目录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'core/storage.js'), 'utf8');
const countOf = (needle) => SRC.split(needle).length - 1;

test('chapterIndexOrThrow：6 个写盘入口共用一份「找不到就抛 CHAPTER_NOT_FOUND」', () => {
  assert.equal(countOf('function chapterIndexOrThrow('), 1, '收口函数只该定义一次');
  assert.equal(countOf('chapterIndexOrThrow(meta, chapterId)'), 7, '定义 + 6 处调用');
  // 收口前 chaptersLib.findChapterIndex 在 storage.js 里有 6 处；收口后只该在 helper 里剩 1 处
  assert.equal(countOf('chaptersLib.findChapterIndex('), 1, '找下标的实现只该留在 helper 里');
  assert.equal(countOf("throw new StorageError('CHAPTER_NOT_FOUND'"), 1, 'CHAPTER_NOT_FOUND 只该从 helper 抛');
  // 错误码与文案逐字不变（main / preload 直接把它转成界面提示）
  assert.ok(
    SRC.includes("throw new StorageError('CHAPTER_NOT_FOUND', '章节不存在（可能已被删除）');"),
    'CHAPTER_NOT_FOUND 的提示文案被改了'
  );
});

test('copyHistoryEntryToBook / backupCurrentToRestoreDir：三处还原共用「先反向备份再原子写回」', () => {
  assert.equal(countOf('function copyHistoryEntryToBook('), 1, '收口函数只该定义一次');
  assert.equal(countOf('copyHistoryEntryToBook('), 3, '定义 + 2 处调用（单文件 / 整组）');
  assert.equal(countOf('function backupCurrentToRestoreDir('), 1, '反向备份只该有这一份实现');
  assert.equal(countOf('backupCurrentToRestoreDir('), 3, '定义 + 2 处调用（替换备份还原 / copyHistoryEntryToBook 内）');
  // resolveHistoryPath 只剩 helper 与「删除章放回」那一处（那个流程不覆盖已有文件，不适用本 helper）
  assert.equal(countOf('historyLib.resolveHistoryPath('), 2, '备份路径解析不该再有第三份');
  assert.equal(countOf('fs.copyFile(target, path.join(restoreDir'), 1, '反向备份只该在 backupCurrentToRestoreDir 里做一次');
  assert.ok(
    /await copyHistoryEntryToBook\(bookPath, group, entry, restoreDir\);\s*\n\s*restored \+= 1;/.test(SRC),
    '整组还原的循环应直接复用 helper'
  );
  // 替换备份还原仍然需要记录「到底备份没备份」来拼失败提示
  assert.ok(
    /if \(await backupCurrentToRestoreDir\(bookPath, entry\.name, restoreDir\)\) safetyCopied = true;/.test(SRC),
    '替换备份还原的 safetyCopied 语义被改坏了'
  );
});

test('单文件还原仍先建好带时间戳的反向备份目录（restoreBackupDir 返回值语义不变）', () => {
  assert.ok(
    /const restoreDir = await uniqueTrashDir\(trashDir, RESTORE_BACKUP_PREFIX\);\s*\n\s*await ensureDir\(restoreDir\);\s*\n\s*await copyHistoryEntryToBook\(/.test(
      SRC
    ),
    '单文件还原必须先 ensureDir(restoreDir) 再写回 —— 旧行为会留下这个目录并作为 restoreBackupDir 返回'
  );
});
