'use strict';
// 测试临时目录回收（只删本进程在系统临时目录里 mkdtemp 出来的目录）。
//
// 为什么需要：node --test 每个测试文件一个进程，测试里 mkdtemp 出来的书库 / 夹具
// 默认没人删——D:\Temp 曾被单测残留堆到 125 GB（其中 importer 的「超大书.txt」
// 每个测试进程一份 128 MB 实占假文件）。删自己的临时目录是测试的既有惯例
// （logs / stats / storage 等文件本来就是这么做的），这里只是把它收成一处。
//
// 边界（与项目「删除动作不进产品代码 / 自检脚本」的口径一致）：
//   * 只处理 os.tmpdir() 下的路径，不碰真实书库；
//   * 只在进程退出时同步删，尽力而为，删不掉不掩测试结果；
//   * 不导出删除入口，测试只能 track 自己刚建的目录。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dirs = [];
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', () => {
    const tmpRoot = path.resolve(os.tmpdir()) + path.sep;
    for (const dir of dirs.splice(0)) {
      try {
        const resolved = path.resolve(dir);
        if (!resolved.startsWith(tmpRoot)) continue;
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* 退出阶段尽力而为，删不掉不影响测试结果 */
      }
    }
  });
}

function track(dir) {
  install();
  dirs.push(dir);
  return dir;
}

module.exports = { track };
