'use strict';
// 接线清单（WP16 / 审计 R-N4）：renderer 装配 + preload bridge + IPC 频道的单一核对入口。
//
// 为什么存在：审计 R-N4 指出 tests/ 里 257+ 处 readFileSync 静态闸门「关键字还在就过、等价重构却假红」。
// 接线性事实（谁加载谁、频道谁注册谁调用、api 谁暴露谁使用）是**可以机器判定**的，收到这一处；
// 业务行为仍由各域自己的用例钉住。任何一条接线对不上，Electron 里的表现都是「某个按钮点了没反应」，
// 而且报错点离原因很远——这里在 Node 里一次报全。
//
// 七个契约（violations 里的 id 固定）：
//   renderer-assembly-order   index.html 的 <script> 顺序 = renderer/assembly-manifest.js 的 MODULES；
//   renderer-module-globals   每个模块文件真的挂出了清单声明的 window.CWxxx；
//   renderer-module-refs      renderer.js 的 const 本地名 / 所有 window.CWxxx 引用都在清单内；
//   preload-api-exposed       renderer 用到的每个 api.<键> 都在 preload 暴露；
//   ipc-invoke-registered     preload 的每个 invoke('频道') 都有主进程 handle / handleBook；
//   ipc-send-registered       preload 的每个 ipcRenderer.send('频道') 都有主进程 ipcMain.on；
//   ipc-notify-listened       主进程每个通知发送频道都有 preload 监听；preload 监听不许没有发送方
//                             （历史死监听白名单见 KNOWN_DEAD_LISTENERS，新死监听 / 白名单过期都算违规）。
//   source-missing            任何一个来源文件读不了（ENOENT / EISDIR / EPERM）——不静默通过。
//
// CLI：node scripts/wiring-check.js [--root <目录>] [--json]
//   真实树通过 exit 0；有违规 exit 1；根目录不存在 / 读不了 exit 2。
const fs = require('node:fs');
const path = require('node:path');

const CHECK_IDS = [
  'renderer-assembly-order',
  'renderer-module-globals',
  'renderer-module-refs',
  'preload-api-exposed',
  'ipc-invoke-registered',
  'ipc-send-registered',
  'ipc-notify-listened',
  'source-missing'
];

// 已知「只有监听、没有发送方」的历史遗留。WP16 只登记、不顺手改产品代码；
// 修掉它时要把这条白名单一起删（白名单过期同样会红，避免越留越多）。
const KNOWN_DEAD_LISTENERS = ['app:force-close'];

const SELF_GLOBALS = new Set(['CWTestHooks', 'CWRendererAssembly']);

function stripJsComments(source) {
  // 手写扫描而不是正则：// 行注释里出现 "ipc/*.js" 这种字样时，正则式的 /* */ 会把后面整段代码吃掉
  // （main.js 就踩过：line comment 里的 /* 让注册段被误删 15 KB）。字符串里的注释符同样必须跳过。
  let out = '';
  let quote = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next || '';
        i += 1;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      if (i < source.length) out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      let sawNewline = false;
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') sawNewline = true;
        i += 1;
      }
      i += 1;
      if (sawNewline) out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function parseScriptSrcs(html) {
  const out = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*(?:["']([^"']+)["']|([^\s"'>]+))[^>]*>/gi;
  for (const match of stripHtmlComments(html).matchAll(re)) out.push(match[1] || match[2]);
  return out;
}

function parsePreloadApiKeys(source) {
  const code = stripJsComments(source);
  const keys = new Set();
  const start = code.indexOf('const api = {');
  if (start >= 0) {
    const end = code.indexOf('\n};', start);
    const block = end >= 0 ? code.slice(start, end) : code.slice(start);
    for (const match of block.matchAll(/^\s{2,}([A-Za-z_$][\w$]*):/gm)) keys.add(match[1]);
  }
  for (const match of code.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\s*=/g)) keys.add(match[1]);
  return keys;
}

function parseInvokeChannels(source) {
  const code = stripJsComments(source);
  return new Set([...code.matchAll(/\binvoke\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
}

function parseSendChannels(source) {
  const code = stripJsComments(source);
  return new Set([...code.matchAll(/ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
}

function parseListenChannels(source) {
  const code = stripJsComments(source);
  const out = new Set([...code.matchAll(/\bon\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
  for (const match of code.matchAll(/ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g)) out.add(match[1]);
  return out;
}

function parseHandlerChannels(source) {
  const code = stripJsComments(source);
  return new Set(
    [...code.matchAll(/\b(?:handleBook|handle|ipcMain\.handle)\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
  );
}

function parseIpcMainOnChannels(source) {
  const code = stripJsComments(source);
  return new Set([...code.matchAll(/ipcMain\.on(?:ce)?\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
}

function parseNotifyChannels(source) {
  const code = stripJsComments(source);
  const out = new Set();
  for (const match of code.matchAll(/webContents\.send\(\s*['"]([^'"]+)['"]/g)) out.add(match[1]);
  for (const match of code.matchAll(/\bbroadcast\(\s*['"]([^'"]+)['"]/g)) out.add(match[1]);
  for (const match of code.matchAll(/\bsendToFlow\(\s*['"]([^'"]+)['"]/g)) out.add(match[1]);
  for (const match of code.matchAll(/sendToSession\(\s*[^,]+,\s*['"]([^'"]+)['"]/g)) out.add(match[1]);
  return out;
}

function parseRendererApiUsage(file, source) {
  const code = stripJsComments(source);
  return [...code.matchAll(/\bapi\.([A-Za-z_$][\w$]*)/g)].map((match) => ({ key: match[1], file }));
}

function auditWiring(root) {
  const base = path.resolve(root || path.join(__dirname, '..'));
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw new Error(`根目录不存在：${base}`);
  }
  const violations = [];
  const warnings = [];
  const cache = new Map();
  const read = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    let text = null;
    try {
      text = fs.readFileSync(path.join(base, rel), 'utf8');
    } catch (err) {
      violations.push({ id: 'source-missing', detail: `${rel} 读不了：${err.code || err.message}` });
    }
    cache.set(rel, text);
    return text;
  };

  // ---- renderer 装配 ----
  let manifest = null;
  const manifestPath = path.join(base, 'renderer', 'assembly-manifest.js');
  const manifestSource = read('renderer/assembly-manifest.js');
  if (manifestSource !== null) {
    try {
      manifest = require(manifestPath);
    } catch (err) {
      violations.push({ id: 'source-missing', detail: `assembly-manifest.js 不能 require：${err.message}` });
    }
  }
  const modules = manifest && Array.isArray(manifest.MODULES) ? manifest.MODULES : [];
  const duplicateFiles = new Set();
  const duplicateGlobals = new Set();
  const duplicateLocals = new Set();
  const seenFiles = new Set();
  const seenGlobals = new Set();
  const seenLocals = new Set();
  for (const [file, global, local] of modules) {
    if (seenFiles.has(file)) duplicateFiles.add(file);
    if (seenGlobals.has(global)) duplicateGlobals.add(global);
    if (local && seenLocals.has(local)) duplicateLocals.add(local);
    seenFiles.add(file);
    seenGlobals.add(global);
    if (local) seenLocals.add(local);
  }
  if (duplicateFiles.size || duplicateGlobals.size || duplicateLocals.size) {
    violations.push({
      id: 'renderer-assembly-order',
      detail:
        '装配清单有重复项：' +
        `文件 ${[...duplicateFiles].join(',') || '无'}；全局名 ${[...duplicateGlobals].join(',') || '无'}；` +
        `本地名 ${[...duplicateLocals].join(',') || '无'}`
    });
  }
  const indexHtml = read('renderer/index.html');
  const scripts = indexHtml === null ? [] : parseScriptSrcs(indexHtml);
  if (indexHtml !== null) {
    const last = scripts[scripts.length - 1];
    const secondLast = scripts[scripts.length - 2];
    if (last !== 'renderer.js' || secondLast !== 'assembly-manifest.js') {
      violations.push({
        id: 'renderer-assembly-order',
        detail: `index.html 末尾两个 <script> 必须是 assembly-manifest.js → renderer.js（实际：${secondLast} → ${last}）`
      });
    }
    if (modules.length) {
      const expected = modules.map((entry) => entry[0]);
      const actual = scripts.filter((file) => file !== 'renderer.js' && file !== 'assembly-manifest.js');
      const missing = expected.filter((file) => !actual.includes(file));
      const extra = actual.filter((file) => !expected.includes(file));
      const orderMismatch = expected.findIndex((file, index) => actual[index] !== file);
      if (missing.length || extra.length || orderMismatch >= 0) {
        const parts = [];
        if (missing.length) parts.push(`缺 ${missing.join(', ')}`);
        if (extra.length) parts.push(`多 ${extra.join(', ')}`);
        if (orderMismatch >= 0) {
          parts.push(`第 ${orderMismatch + 1} 项应为 ${expected[orderMismatch]}，实际 ${actual[orderMismatch]}`);
        }
        violations.push({
          id: 'renderer-assembly-order',
          detail: `index.html 的模块顺序与装配清单不一致：${parts.join('；')}`
        });
      }
    }
    for (const [file, global] of modules) {
      const source = read(`renderer/${file}`);
      if (source === null) continue;
      const installed = new RegExp(`(?:root|window)\\.${global}\\s*=`).test(stripJsComments(source));
      if (!installed) {
        violations.push({
          id: 'renderer-module-globals',
          detail: `renderer/${file} 没有挂出清单声明的 window.${global}`
        });
      }
    }
  }

  // ---- renderer 对模块的引用 ----
  const rendererSource = read('renderer/renderer.js');
  if (rendererSource !== null) {
    const code = stripJsComments(rendererSource);
    const byGlobal = new Map(modules.filter((entry) => entry[2]).map((entry) => [entry[1], entry[2]]));
    for (const match of code.matchAll(/^\s*const\s+(\w+)\s*=\s*window\.(CW[A-Za-z0-9]+);/gm)) {
      const [, local, global] = match;
      if (!byGlobal.has(global)) {
        violations.push({
          id: 'renderer-module-refs',
          detail: `renderer.js 引用了装配清单外模块：window.${global}（const ${local}）`
        });
      } else if (byGlobal.get(global) !== local) {
        violations.push({
          id: 'renderer-module-refs',
          detail: `window.${global} 在清单里的本地名是 ${byGlobal.get(global)}，renderer.js 写成了 ${local}`
        });
      }
    }
    for (const [, global, local] of modules.filter((entry) => entry[2])) {
      const pattern = new RegExp(`^\\s*const\\s+${local}\\s*=\\s*window\\.${global};`, 'm');
      if (!pattern.test(code)) {
        violations.push({
          id: 'renderer-module-refs',
          detail: `装配清单里的本地名 ${local} = window.${global} 没有出现在 renderer.js`
        });
      }
    }
    const globals = new Set(modules.map((entry) => entry[1]));
    for (const match of code.matchAll(/window\.(CW[A-Za-z0-9]+)/g)) {
      const global = match[1];
      if (SELF_GLOBALS.has(global) || globals.has(global)) continue;
      violations.push({ id: 'renderer-module-refs', detail: `renderer.js 引用了装配清单外模块：window.${global}` });
    }
  }

  // ---- preload bridge ↔ renderer 使用 ----
  const preloadSource = read('preload.js');
  const exposed = preloadSource === null ? new Set() : parsePreloadApiKeys(preloadSource);
  const apiUsage = [];
  for (const rel of fs.existsSync(path.join(base, 'renderer')) ? fs.readdirSync(path.join(base, 'renderer')) : []) {
    if (!rel.endsWith('.js') || rel === 'renderer.js') continue;
    const source = read(`renderer/${rel}`);
    if (source === null) continue;
    apiUsage.push(...parseRendererApiUsage(rel, source));
  }
  if (rendererSource !== null) apiUsage.push(...parseRendererApiUsage('renderer.js', rendererSource));
  const usedOpen = new Map();
  for (const item of apiUsage) if (!usedOpen.has(item.key)) usedOpen.set(item.key, item.file);
  for (const [key, file] of usedOpen) {
    if (!exposed.has(key)) {
      violations.push({
        id: 'preload-api-exposed',
        detail: `renderer/${file} 使用了 preload 未暴露的 api.${key}`
      });
    }
  }

  // ---- IPC：invoke / send / 通知 ----
  const invokeChannels = preloadSource === null ? new Set() : parseInvokeChannels(preloadSource);
  const sendChannels = preloadSource === null ? new Set() : parseSendChannels(preloadSource);
  const listenChannels = preloadSource === null ? new Set() : parseListenChannels(preloadSource);
  const mainFiles = ['main.js'];
  if (fs.existsSync(path.join(base, 'ipc'))) {
    for (const file of fs.readdirSync(path.join(base, 'ipc')).sort()) {
      if (file.endsWith('.js')) mainFiles.push(`ipc/${file}`);
    }
  }
  const handlerChannels = new Set();
  const ipcMainOnChannels = new Set();
  const notifySent = new Set();
  for (const rel of mainFiles) {
    const source = read(rel);
    if (source === null) continue;
    for (const channel of parseHandlerChannels(source)) handlerChannels.add(channel);
    for (const channel of parseIpcMainOnChannels(source)) ipcMainOnChannels.add(channel);
    for (const channel of parseNotifyChannels(source)) notifySent.add(channel);
  }
  for (const channel of invokeChannels) {
    if (!handlerChannels.has(channel)) {
      violations.push({
        id: 'ipc-invoke-registered',
        detail: `preload invoke('${channel}') 在主进程没有 handle / handleBook 注册`
      });
    }
  }
  for (const channel of sendChannels) {
    if (!ipcMainOnChannels.has(channel)) {
      violations.push({
        id: 'ipc-send-registered',
        detail: `preload ipcRenderer.send('${channel}') 在主进程没有 ipcMain.on 注册`
      });
    }
  }
  for (const channel of notifySent) {
    if (!listenChannels.has(channel)) {
      violations.push({
        id: 'ipc-notify-listened',
        detail: `主进程发送通知 '${channel}'，preload 没有对应监听`
      });
    }
  }
  const deadListeners = [...listenChannels].filter((channel) => !notifySent.has(channel)).sort();
  const newDead = deadListeners.filter((channel) => !KNOWN_DEAD_LISTENERS.includes(channel));
  if (newDead.length) {
    violations.push({
      id: 'ipc-notify-listened',
      detail: `preload 监听没有发送方：${newDead.join(', ')}（新死监听不许静默留下）`
    });
  }
  const staleAllowlist = KNOWN_DEAD_LISTENERS.filter((channel) => !deadListeners.includes(channel));
  if (staleAllowlist.length) {
    violations.push({
      id: 'ipc-notify-listened',
      detail: `死监听白名单已过期（这些频道已经有发送方或已删除）：${staleAllowlist.join(', ')}`
    });
  }

  const unusedExposed = [...exposed].filter((key) => !usedOpen.has(key)).sort();
  if (unusedExposed.length) {
    warnings.push(`preload 暴露但 renderer 未使用：api.${unusedExposed.join(', api.')}（清理项，不算违规）`);
  }

  return {
    root: base,
    violations,
    warnings,
    facts: {
      rendererScripts: scripts.length,
      rendererModules: modules.length,
      exposedApi: exposed.size,
      usedApi: usedOpen.size,
      invokeChannels: invokeChannels.size,
      sendChannels: sendChannels.size,
      registeredHandlers: handlerChannels.size,
      registeredListeners: ipcMainOnChannels.size,
      notifySent: notifySent.size,
      notifyListened: listenChannels.size,
      deadListeners
    }
  };
}

function usage() {
  return '用法：node scripts/wiring-check.js [--root <目录>] [--json]';
}

function main(argv) {
  const args = argv.slice(2);
  let rootArg = null;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--root') {
      rootArg = args[i + 1];
      if (!rootArg) {
        console.error(`--root 后面要跟一个目录\n${usage()}`);
        return 2;
      }
      i += 1;
    } else if (args[i] === '--json') {
      json = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(usage());
      return 0;
    } else {
      console.error(`未知参数：${args[i]}\n${usage()}`);
      return 2;
    }
  }
  const root = path.resolve(rootArg || path.join(__dirname, '..'));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`根目录不存在：${root}`);
    return 2;
  }
  let result;
  try {
    result = auditWiring(root);
  } catch (err) {
    console.error(`接线检查失败：${err.message}`);
    return 2;
  }
  if (json) {
    console.log(JSON.stringify(result));
    return result.violations.length ? 1 : 0;
  }
  for (const item of result.violations) console.log(`VIOLATION  ${item.id}  ${item.detail}`);
  if (result.violations.length) {
    console.log(`接线清单未通过：${result.violations.length} 处违规（${CHECK_IDS.length} 项契约）`);
    return 1;
  }
  console.log(
    `接线清单通过：${CHECK_IDS.length} 项契约（renderer ${result.facts.rendererModules} 个模块 / ` +
      `${result.facts.invokeChannels} 个 invoke 频道 / ${result.facts.notifySent} 个通知频道 / ` +
      `${result.facts.exposedApi} 个 bridge api）`
  );
  for (const warning of result.warnings) console.log(`提示：${warning}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { CHECK_IDS, KNOWN_DEAD_LISTENERS, auditWiring };