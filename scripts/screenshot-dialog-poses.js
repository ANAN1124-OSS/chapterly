'use strict';
// CI-F8（2026-11-24 复核补审）：--dialog 截图摆姿表（原 scripts/screenshot-driver.js 里 500+ 行的
// if / else-if 链）。只服务开发截图（--screenshot=… --dialog=…），不参与产品路径；run() 现在只留驱动
// 主干（窗口 / 等待 / 捕获 / E2E 分流），加一种摆姿 = 在 DIALOG_POSES 里加一条。
//
// 每条 pose 是 async (env) => {}，env = { exec, sleep, argValue, win, waitForRenderer, screenshotBook,
// dialog }。行为与此前逐字一致（只把标识符改成 env.*），等待时长 / 顺序 / 文案都不动。
const DIALOG_POSES = Object.freeze({
  "command": async (env) => {
        // 1.4.0 P0-3：命令面板打开的样子（空查询 = 最近使用 + 命令 / 章节 / 书三组）
        await env.exec('void window.__cwTest.openCommandPalette()', true);
        await env.sleep(500);
  },
  "command-search": async (env) => {
        // 1.4.0 P0-3：命令面板里输入「保存」过滤后的样子
        await env.exec('void window.__cwTest.openCommandPalette()', true);
        await env.sleep(350);
        await env.exec(
          `(() => { const input = document.getElementById('command-input'); input.value = '保存'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
          true
        );
        await env.sleep(300);
  },
  "shortcuts": async (env) => {
        // 1.5.0 功能-4：`?` 快捷键一览打开的样子（先把焦点移出编辑区：编辑区里 ? 是普通字符）
        await env.exec(
          "(() => { const el = document.getElementById('editor'); if (el) el.blur(); document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true })); })()",
          true
        );
        await env.sleep(450);
  },
  "undo": async (env) => {
        // 1.4.0 P0-2：撤销条（删除章节后 10 秒内的样子）—— 删掉第 2 章，条子出现在左下角。
        await env.exec(
          `void window.__cwTest.deleteChapterAt(1)`,
          true
        );
        await env.sleep(600);
  },
  "settings-book": async (env) => {
        // 按书设置（章号编号方式 2026-11-10）：打开当前书的设置并滚到「章号」
        await env.exec('void window.__cwTest.openSettings()', true);
        await env.sleep(700);
        await env.exec(
          `(() => { const el = document.getElementById('settings-numbering-field'); if (el) el.scrollIntoView({ block: 'center' }); })()`,
          true
        );
        await env.sleep(400);
  },
  "jump-volume": async (env) => {
        // 按卷编号时 Ctrl+G 输入 1：两卷的第 1 章都列出来
        await env.exec('void window.__cwTest.openJumpDialog()', true);
        await env.sleep(450);
        await env.exec("void window.__cwTest.setJumpQuery('1')", true);
        await env.sleep(600);
  },
  "chapter-filter": async (env) => {
        // 2026-11-10 卷章目录重设计：筛选框输入后的样子（默认筛「渡」，可用 --filter= 覆盖）
        const filterQuery = env.argValue('filter') || '渡';
        await env.exec(
          `window.__cwTest.setChapterFilter(${JSON.stringify(filterQuery)})`,
          true
        );
        await env.sleep(350);
  },
  "chapter-filter-focus": async (env) => {
        // 筛选框的焦点环（Tab 进去的样子）
        await env.exec(
          `(() => { const input = document.getElementById('chapter-filter'); input.focus(); return input === document.activeElement; })()`,
          true
        );
        await env.sleep(300);
  },
  "chapter-scroll": async (env) => {
        // 目录滚动到第二卷：卷头吸顶 + 当前章仍高亮
        await env.exec(
          `(() => { const list = document.getElementById('chapter-list'); list.scrollTop = 430; return list.scrollTop; })()`,
          true
        );
        await env.sleep(380);
  },
  "chapter-hover": async (env) => {
        // 悬停一行看行尾「⋯」更多按钮（真鼠标事件，CSS :hover 才成立）
        const point = await env.exec(
          `(() => { const el = document.querySelector('#chapter-list .chapter-item[data-index="3"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width - 40), y: Math.round(r.top + r.height / 2) }; })()`,
          true
        );
        if (point) {
          env.win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
          await env.sleep(350);
        }
  },
  "chapter-pill": async (env) => {
        // 当前章滚出目录：先切到最后一章，再把列表滚到顶，底部「回到第 N 章」浮标出现
        const lastIndex = Number(
          await env.exec('window.__cwTest.state.chapters.length - 1', true)
        );
        await env.exec(
          `void window.__cwTest.switchTo(${lastIndex}, 'discard')`,
          true
        );
        await env.sleep(320);
        await env.exec(
          `document.getElementById('chapter-list').scrollTop = 0;`,
          true
        );
        await env.sleep(420);
  },
  "chapter-collapsed": async (env) => {
        // 全部折叠（当前章在折叠卷里时，浮标仍给一条回去的路）
        await env.exec(
          `document.getElementById('btn-toggle-volumes').click()`,
          true
        );
        await env.sleep(350);
  },
  "unsaved": async (env) => {
        await env.exec(
          `window.__cwTest.setText('（这是一段还没有保存的正文，演示关窗拦截）'); void window.__cwTest.handleCloseRequest();`,
          true
        );
        await env.sleep(500);
  },
  "settings": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "settings-snapshot": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "settings-stats": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "settings-calendar": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "settings-template": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "settings-sensitive": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "settings-proofread": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "settings-export": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "settings-caret": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "settings-logs": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "settings-update": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "settings-ia-search": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "settings-ia-empty": async (env) => {
    const dialog = env.dialog;
        await env.exec(
          `document.getElementById('btn-settings').click();`,
          true
        );
        // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，下面那些「滚到某组」的开发截图要先切到
        // 该组所在的分区，否则元素在 hidden 分区里、scrollIntoView 什么也不做（截图会拍到别的分区）。
        const SETTINGS_DIALOG_TABS = {
          'settings-snapshot': 'data',
          'settings-stats': 'writing',
          'settings-calendar': 'writing',
          'settings-template': 'content',
          'settings-sensitive': 'content',
          'settings-proofread': 'content',
          'settings-export': 'data',
          'settings-logs': 'about',
          'settings-update': 'about'
        };
        const dialogTab = SETTINGS_DIALOG_TABS[dialog];
        if (dialogTab) {
          await env.sleep(350);
          await env.exec(
            `(() => { const btn = document.getElementById('settings-tab-' + ${JSON.stringify(dialogTab)}); if (btn) btn.click(); })()`,
            true
          );
          await env.sleep(250);
        }
        // 1.4.0 P0-1：新增两个信息架构截图状态 —— 顶部搜索命中（跨分区）/ 搜索空结果
        if (dialog === 'settings-ia-search') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '快照';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        } else if (dialog === 'settings-ia-empty') {
          await env.sleep(350);
          await env.exec(
            `(() => {
               const input = document.getElementById('settings-search');
               input.value = '不存在的设置项';
               input.dispatchEvent(new Event('input', { bubbles: true }));
             })()`,
            true
          );
          await env.sleep(300);
        }
        if (dialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await env.sleep(300);
          await env.exec(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (dialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await env.sleep(600);
          await env.exec(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await env.sleep(700);
          await env.exec(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (dialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await env.sleep(500);
          await env.exec(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapterly/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await env.exec('window.__cwTest.checkUpdateNow()', true);
          await env.waitForRenderer(env.win, `window.__cwTest.updateStatus().status === 'update'`);
          await env.exec(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await env.sleep(500);
  },
  "bookmenu": async (env) => {
        await env.exec(
          `const more = document.querySelector('.book-card-more'); if (more) more.click();`,
          true
        );
        await env.sleep(500);
  },
  "bookinfo": async (env) => {
        // 开发截图用：打开第一本书的「书籍信息」并填示例值（只改界面，不保存）
        await env.exec(
          `(() => {
             const book = (window.__cwTest.state.books || []).find((item) => item.status !== 'corrupt');
             if (!book) return false;
             window.__cwTest.openBookInfoForPath(book.path);
             window.__cwTest.setBookInfoField('author', '示例作者');
             window.__cwTest.setBookInfoField('group', '玄幻');
             window.__cwTest.setBookInfoField('tags', '爽文、升级流');
             window.__cwTest.setBookInfoField('brief', '一句话简介：一个关于旧车站与未寄出的信的故事。');
             return true;
           })()`,
          true
        );
        await env.sleep(500);
  },
  "exportmenu": async (env) => {
        // 开发截图用：展开写作页「导出 ▾」菜单，展示 TXT / EPUB / 本书历史入口
        await env.exec(
          `document.getElementById('btn-export').click();`,
          true
        );
        await env.sleep(500);
  },
  "export": async (env) => {
        // 开发截图用：打开「导出 TXT」对话框，展示范围与简繁转换提示（只读，不导出）
        await env.exec(
          `document.getElementById('btn-export').click(); document.querySelector('#export-menu button[data-action="txt"]').click();`,
          true
        );
        await env.sleep(900);
  },
  "export-epub": async (env) => {
        // 开发截图用：打开「导出 EPUB」范围对话框并选中「按卷导出」，展示 EPUB 也能按卷 / 按范围
        // （只读，不导出、不写盘）
        await env.exec(
          `document.getElementById('btn-export').click(); document.querySelector('#export-menu button[data-action="epub"]').click();`,
          true
        );
        await env.sleep(700);
        await env.exec(env.SCREENSHOT_PICK_VOLUME_JS, true);
        await env.sleep(900);
  },
  "export-docx": async (env) => {
        // 开发截图用：打开「导出 DOCX」范围对话框并选中「按卷导出」（只读，不导出、不写盘）
        await env.exec(
          `document.getElementById('btn-export').click(); document.querySelector('#export-menu button[data-action="docx"]').click();`,
          true
        );
        await env.sleep(700);
        await env.exec(env.SCREENSHOT_PICK_VOLUME_JS, true);
        await env.sleep(900);
  },
  "fragment": async (env) => {
        // 开发截图用：书架「＋ 碎片」弹层 + 示例内容（只是界面演示，不会写盘）
        await env.exec(
          `window.__cwTest.openFragmentDialog(); window.__cwTest.setFragmentText('雨还在下。旧车站的钟停在 3:17，像在等一个不会再回来的人。');`,
          true
        );
        await env.sleep(400);
  },
  "fragments": async (env) => {
        // 开发截图用：写作页「插入碎片…」弹层，等列表读出来再选第一条
        await env.exec(`window.__cwTest.openInsertFragmentDialog();`, true);
        try {
          await env.waitForRenderer(env.win, 'window.__cwTest.fragmentRowCount() > 0', 8000);
          await env.exec(`window.__cwTest.clickFragmentRow(0);`, true);
        } catch {
          console.log('[screenshot] 没有可展示的碎片（可在 _碎片 里先放一条）');
        }
        await env.sleep(600);
  },
  "capture": async (env) => {
        // 开发截图用：剪贴板捕获确认面板（假文本走真实的分析 / 三态标签，不写盘）
        const captureSample = [
          '在空教室逗留然后遇到幽灵还搞百合什么的怎么想都不会发生吧 #1',
          '#原创 百合 #百合 yuri #GL',
          '3,191字 7分钟',
          '第1章 撞见了幽灵',
          '',
          '直到她真的死去，我也没能认清我到底爱她多，还是恨她多。',
          '',
          '甚至，我还需要再多分辨一点，才能确认这份感情到底算什么。',
          '',
          '教室的窗开着，风把窗帘吹得很高，像某种迟到很久的回答。'
        ].join('\n');
        await env.exec(
          `window.__cwTest.openCapture(${JSON.stringify(captureSample)});`,
          true
        );
        await env.sleep(700);
  },
  "splitter": async (env) => {
        await env.exec(
          `window.__cwTest.setSidebarWidth(420);`,
          true
        );
        await env.sleep(400);
  },
  "format": async (env) => {
        await env.exec(
          `window.__cwTest.openFormatDialog();`,
          true
        );
        await env.sleep(900);
  },
  "formatmenu": async (env) => {
        // v0.8.5 R1：「整理」不再点开菜单，改成悬浮出「选择卡」——截图走真实的 pointerenter
        await env.exec(
          `document.getElementById('format-dropdown').dispatchEvent(new PointerEvent('pointerenter'));`,
          true
        );
        await env.sleep(400);
  },
  "displaymenu": async (env) => {
        await env.exec(
          `document.getElementById('btn-display').click();`,
          true
        );
        await env.sleep(400);
  },
  "format-click": async (env) => {
        // 点「整理」= 直接用记住的规则整理本章（截图要赶在 toast 消失前）
        await env.exec(
          `document.getElementById('btn-format').click();`,
          true
        );
        await env.sleep(800);
  },
  "find": async (env) => {
        await env.exec(
          `window.__cwTest.openFindPanel(); window.__cwTest.setFindFields({ query: '风', scope: 'book' }); window.__cwTest.findRun();`,
          true
        );
        await env.sleep(900);
  },
  "find-nav": async (env) => {
        // 开发截图用：查找面板里的「当前章定位」一行（上一处 / 下一处 + 第 X / N 处）
        await env.exec(
          `(() => {${env.SCREENSHOT_PICK_CHAR_JS}
             window.__cwTest.openFindPanel();
             window.__cwTest.setFindFields({ query: best || '的', scope: 'current' });
             window.__cwTest.findRun();
           })()`,
          true
        );
        await env.sleep(900);
  },
  "find-highlight": async (env) => {
        // 开发截图用：查找增强（v0.8-11，提案 N11）——当前章全部命中高亮 + 状态栏「查找 1/N」。
        // 先挑本章出现最多的一个汉字当查找词，查完把面板关掉，让正文里的高亮露出来（只读，不写盘）
        await env.exec(
          `(() => {${env.SCREENSHOT_PICK_CHAR_JS}
             window.__cwTest.openFindPanel();
             window.__cwTest.setFindFields({ query: best || '的', scope: 'current' });
             window.__cwTest.findRun();
             window.__cwTest.closeFindPanel();
           })()`,
          true
        );
        await env.sleep(900);
  },
  "find-bookmark": async (env) => {
        // 开发截图用：查找书签（v0.8-11b，提案 N11b）——当前章查一次并存成书签，
        // 面板里的「书签」区列出这一条，正文命中同时高亮（只写临时 userData 的 config，不碰书库）
        await env.exec(
          `(async () => {${env.SCREENSHOT_PICK_CHAR_JS}
             window.__cwTest.openFindPanel();
             window.__cwTest.setFindFields({ query: best || '的', scope: 'current' });
             await window.__cwTest.findRun();
             await window.__cwTest.findBookmarkSave();
           })()`,
          true
        );
        await env.sleep(900);
  },
  "proofread": async (env) => {
        // 开发截图用：打开校对面板，等当前章自动检查完，再切整本跑一遍（只读）
        await env.exec(`window.__cwTest.openProofreadPanel();`, true);
        await env.sleep(800);
        await env.exec(`window.__cwTest.setProofreadScope('book');`, true);
        await env.sleep(120);
        await env.exec(`window.__cwTest.proofreadRun();`, true);
        await env.sleep(800);
  },
  "sensitive": async (env) => {
        // 开发截图用：打开敏感词预检面板（先等当前章自动预检完），再切整本跑一遍（只读）
        await env.exec(`window.__cwTest.openSensitivePanel();`, true);
        await env.sleep(900);
        await env.exec(`window.__cwTest.setSensitiveScope('book');`, true);
        await env.sleep(120);
        await env.exec(`window.__cwTest.sensitiveRun();`, true);
        await env.sleep(900);
  },
  "tts": async (env) => {
        // 开发截图用：假语音引擎 + 朗读小条（真的出声在开发机上也会吵，这里只展示界面状态）
        await env.exec(
          `window.__cwTest.ttsInstallFakeSpeech(); document.getElementById('btn-tts').click();`,
          true
        );
        try {
          await env.waitForRenderer(
            env.win,
            'window.__cwTest.ttsBarOpen() && window.__cwTest.ttsChunks().length > 0',
            8000
          );
          await env.exec('window.__cwTest.ttsFakeFinish();', true);
          await env.sleep(320);
          await env.exec('window.__cwTest.ttsPlay();', true);
        } catch {
          console.log('[screenshot] 朗读条没能准备好');
        }
        await env.sleep(400);
  },
  "marks": async (env) => {
    const dialog = env.dialog;
        // 开发截图用：编辑器小件——不可见字符 ␣ / 行尾空白 / 超长段落左侧黄线（只读显示层，不写盘）
        await env.exec(
          "window.__cwTest.setMarksToggle('invisibles', true); window.__cwTest.setMarksToggle('longParagraphs', true);",
          true
        );
        await env.sleep(450);
        if (dialog === 'marks-menu') {
          await env.exec('window.__cwTest.openFormatMenu();', true);
        } else {
          await env.exec('window.__cwTest.selectRange(0, 42);', true);
        }
        await env.sleep(500);
  },
  "marks-menu": async (env) => {
    const dialog = env.dialog;
        // 开发截图用：编辑器小件——不可见字符 ␣ / 行尾空白 / 超长段落左侧黄线（只读显示层，不写盘）
        await env.exec(
          "window.__cwTest.setMarksToggle('invisibles', true); window.__cwTest.setMarksToggle('longParagraphs', true);",
          true
        );
        await env.sleep(450);
        if (dialog === 'marks-menu') {
          await env.exec('window.__cwTest.openFormatMenu();', true);
        } else {
          await env.exec('window.__cwTest.selectRange(0, 42);', true);
        }
        await env.sleep(500);
  },
  "marks-caret": async (env) => {
        // 开发截图用：当前段落高亮（v0.8-10，提案 N10）——打开开关，把光标放进一段较长的正文里
        // （只读显示层，不写盘、不写配置）
        await env.exec(
          "window.__cwTest.setMarksToggle('caretParagraph', true);",
          true
        );
        await env.sleep(400);
        await env.exec(env.screenshotCaretLongLineScript(), true);
        await env.sleep(500);
  },
  "marks-caret-color": async (env) => {
        // 开发截图用：当前段落高亮按书开 + 自定义颜色（蓝色）+ 打开「排版 ▾」露出色板。
        // 只写临时 userData 的 config.json（截图环境），不碰书库 / 正文。
        await env.exec(
          "window.__cwTest.setCaretParagraphPersist(true); window.__cwTest.setCaretColor('#3f7fbf');",
          true
        );
        await env.sleep(600);
        await env.exec(
          env.screenshotCaretLongLineScript('window.__cwTest.openFormatMenu();'),
          true
        );
        await env.sleep(600);
  },
  "focus": async (env) => {
        // 开发截图用：专注模式 + 打字机模式（隐藏左栏 / 顶栏，只改显示，不写盘、不写配置）
        await env.exec(
          'window.__cwTest.focusToggle(true); window.__cwTest.focusTypewriter(true);',
          true
        );
        await env.sleep(500);
        await env.exec(
          'const len = window.__cwTest.text().length; window.__cwTest.focusSetCaret(Math.floor(len * 0.6)); window.__cwTest.focusAlign();',
          true
        );
        await env.sleep(500);
  },
  "reading": async (env) => {
        // 开发截图用：整本只读通读（字号 / 行距 / 目录 / 上一章 / 下一章；只读，不写盘）
        await env.exec('window.__cwTest.openReading();', true);
        try {
          await env.waitForRenderer(env.win, 'window.__cwTest.readingState().blockCount > 0', 10000);
        } catch {
          console.log('[screenshot] 阅读模式没有读到章节');
        }
        await env.sleep(500);
        if (env.argValue('reading-chapter') != null) {
          await env.exec(
            `window.__cwTest.readingJump(${Number(env.argValue('reading-chapter'))});`,
            true
          );
          await env.sleep(600);
        }
  },
  "shelf-search": async (env) => {
        // 开发截图用：书架搜正文（真实走 userData 里的索引；只读，不碰书库）
        const query = env.argValue('search-query') || '青柠色';
        await env.exec(
          `window.__cwTest.setShelfQuery(${JSON.stringify(query)});`,
          true
        );
        await env.sleep(1800);
  },
  "group-manage": async (env) => {
        // 开发截图用（1.6.0 F5）：书架「分组管理」弹层（改名 / 合并）；只读打开，不改任何书
        await env.exec('window.__cwTest.openGroupManageDialog();', true);
        await env.sleep(500);
  },
  "conflict": async (env) => {
        const folder = await env.exec(
          'window.__cwTest.firstConflictBookFolder()',
          true
        );
        if (folder) {
          await env.exec(
            `window.__cwTest.openConflictDialogFor(${JSON.stringify(folder)})`,
            true
          );
        }
        await env.sleep(500);
  },
  "history": async (env) => {
        const opened = env.screenshotBook
          ? await env.exec(
              `window.__cwTest.openHistoryForPath(${JSON.stringify(env.screenshotBook)})`,
              true
            )
          : await env.exec('window.__cwTest.openHistoryForFirstBook()', true);
        if (!opened) console.log('[screenshot] 没有可打开历史面板的书');
        await env.sleep(900);
  }
});

// 未知 --dialog：返回 false（保持旧行为：什么都不摆，照常截图）。
async function applyDialogPose(dialog, env) {
  const pose = DIALOG_POSES[dialog];
  if (!pose) return false;
  await pose({ ...env, dialog });
  return true;
}

module.exports = {
  DIALOG_POSES,
  DIALOG_POSE_NAMES: Object.freeze(Object.keys(DIALOG_POSES)),
  applyDialogPose
};
