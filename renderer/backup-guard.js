/* 撤销前的「备份还是不是那一份」核对（1.5.0 P0-5 / 1.4.0 审计 V-2）。
 *
 * 事实：整本替换备份还原 / 历史还原 / 整本整理这三条「撤销」，都是拿 `_trash` 里的一个备份目录
 * 再还原一次。登记撤销时只知道目录名；10 秒里如果那个目录被别的窗口 / 资源管理器改过
 * （补了文件、删了文件、内容被替换），撤销就会用一份已经不是「还原前」的备份去覆盖现在的正文。
 *
 * 做法：登记撤销时用现有只读清单接口（api.listHistory）读一次这个目录的
 *   目录名 + 文件数 + 文件里最大的 mtimeMs
 * 作为指纹；撤销前再读一次，三项都对得上才继续，对不上就报「备份已变化，撤销取消」并早退。
 * 只读、不改备份目录格式、不新增 IPC 通道。
 *
 * 指纹只用清单里已有的字段（fileCount / files[].mtimeMs），不额外 stat：
 *   - 文件数变了 = 备份被增删；
 *   - 最大 mtime 变了 = 有文件被改写（restore 只往外 copy，不会改备份目录本身）。
 * 登记时清单读不到（目录刚被移走等）就返回 null，撤销时不拦 —— 宁可少一道核对，
 * 也不让一个正常的撤销变砖；撤销时清单读不到则**取消**（这时没法证明备份没变）。
 *
 * 契约：
 *   MESSAGE / fingerprintOf(groups, dirName) / verify(groups, expected)  ← 纯函数
 *   create({ call, api }) → {
 *     fingerprint(bookPath, dirName)      → 指纹 | null（读不到就 null，不抛）
 *     assertUnchanged(bookPath, expected) → true；备份变了抛 Error(MESSAGE)
 *     fingerprintOf / verify（转发纯函数，方便宿主复用）
 *   }
 *
 * 浏览器里挂成全局 CWBackupGuard（index.html 排在 history-ui.js / renderer.js 之前），Node 里可直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWBackupGuard = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MESSAGE = '备份已变化，撤销取消';
  const LIST_FAILED_MESSAGE = '备份清单读取失败，撤销取消';

  function groupsOf(list) {
    if (Array.isArray(list)) return list;
    if (list && typeof list === 'object' && Array.isArray(list.groups)) return list.groups;
    return [];
  }

  function fingerprintOf(groups, dirName) {
    const name = typeof dirName === 'string' ? dirName : '';
    if (!name) return null;
    const group = groupsOf(groups).find(
      (item) => item && typeof item === 'object' && (item.dirName === name || item.id === `dir:${name}`)
    );
    if (!group) return null;
    const files = Array.isArray(group.files) ? group.files : [];
    let mtimeMs = 0;
    for (const file of files) {
      const value = Number(file && file.mtimeMs);
      if (Number.isFinite(value) && value > mtimeMs) mtimeMs = value;
    }
    const rawCount = Number(group.fileCount);
    return {
      dirName: typeof group.dirName === 'string' && group.dirName ? group.dirName : name,
      fileCount: Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : files.length,
      mtimeMs: Math.round(mtimeMs)
    };
  }

  function verify(groups, expected) {
    // 没有指纹（登记时清单就读不到）或指纹残破到没有目录名：不拦 —— 与「没记到」同一口径。
    if (!expected || typeof expected !== 'object' || typeof expected.dirName !== 'string' || !expected.dirName) {
      return { ok: true, unchecked: true };
    }
    const now = fingerprintOf(groups, expected.dirName);
    if (!now) return { ok: false, reason: 'missing', message: MESSAGE };
    if (now.fileCount !== expected.fileCount || now.mtimeMs !== expected.mtimeMs) {
      return { ok: false, reason: 'changed', message: MESSAGE };
    }
    return { ok: true, fingerprint: now };
  }

  function create(host) {
    const source = host && typeof host === 'object' ? host : {};
    const call = source.call;
    const api = source.api;
    if (typeof call !== 'function') throw new TypeError('createBackupGuard 的 host.call 必须是函数');
    if (!api || typeof api !== 'object' || typeof api.listHistory !== 'function') {
      throw new TypeError('createBackupGuard 的 host.api 必须带 listHistory');
    }

    // 登记撤销时用：读不到就当没有指纹（撤销不拦），绝不因为一次读失败把动作卡死。
    async function fingerprint(bookPath, dirName) {
      if (!bookPath || !dirName) return null;
      try {
        return fingerprintOf(await call(api.listHistory, bookPath), dirName);
      } catch {
        return null;
      }
    }

    // 撤销执行前用：清单读不到也取消 —— 这一步是「证明备份没变」，证明不了就不覆盖正文。
    async function assertUnchanged(bookPath, expected) {
      if (!expected) return true;
      let list;
      try {
        list = await call(api.listHistory, bookPath);
      } catch {
        throw new Error(LIST_FAILED_MESSAGE);
      }
      const check = verify(list, expected);
      if (!check.ok) throw new Error(check.message);
      return true;
    }

    return { fingerprint, assertUnchanged, fingerprintOf, verify };
  }

  return { MESSAGE, LIST_FAILED_MESSAGE, fingerprintOf, verify, create };
});