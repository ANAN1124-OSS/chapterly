// E2E 第 0 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组只做「界面版本号取自 package.json」与「IPC 只接受书架目录下的书」；不依赖当前书 / 会话状态。
// 唯一适配：原来就地取 package.json 的 version，组文件只许 require node 内建，
// 改成用场景交进来的 appVersion（同一个值，断言条件与文案都没动）。

module.exports = async function group0VersionAndIpcGuard(t) {
  const { appVersion, exec, check } = t;

  // 0. 界面版本号跟着 package.json 走（发版只改一处，避免界面还显示旧版本）
  check(
    '界面版本号取自 package.json',
    (await exec('window.__cwTest.versionText()')) === `v${appVersion}`
  );

  // 0b. IPC 只接受书架目录下的书：越界路径必须被拒（不给渲染层任意读盘的能力）
  const badOpen = await exec("window.api.openBook('C:\\\\Windows')");
  check(
    '打开书架以外的路径被拒绝',
    Boolean(badOpen && badOpen.ok === false && badOpen.code === 'BAD_PATH'),
    badOpen
  );
  const badLoad = await exec("window.api.loadChapter('C:\\\\Windows', 'win.ini')");
  check(
    '读取书架以外的章节被拒绝',
    Boolean(badLoad && badLoad.ok === false && badLoad.code === 'BAD_PATH'),
    badLoad
  );
};
