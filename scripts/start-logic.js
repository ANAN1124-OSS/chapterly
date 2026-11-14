'use strict';
// 启动链（scripts/start.js）的纯判定逻辑（v1.8.0 WP-38 / 审计 X15）。
//
// 单独成模块是为了能在 node:test 里直接断言，不用真起 Electron：
//   · exitCodeFor(code)：子进程正常结束原样透传退出码；被信号杀死（close 的 code 为 null）
//     或拿不到数字退出码时一律 1 —— 以前 `code == null ? 0 : code` 会把「被杀死」当成功，
//     自动化脚本 / 快捷方式都看不出这次启动其实失败了；
//   · missingElectronHint(err)：没装依赖（MODULE_NOT_FOUND）时给一句能照做的提示，
//     而不是甩一段裸栈（X15 的另外半条）。
function exitCodeFor(code) {
  if (typeof code === 'number' && Number.isInteger(code) && code >= 0) return code;
  return 1;
}

function missingElectronHint(err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    return '还没有安装依赖（找不到 electron 模块）。先在项目目录执行 pnpm install（或 npm install），再重新启动。';
  }
  return null;
}

module.exports = { exitCodeFor, missingElectronHint };
