// E2E 第 47 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：回书架；造 _碎片 与「v0.4.1 旧书」（fragLegacyBookPath）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group47Fragments(t) {
  const { exec, check, waitFor, storage, booksRoot, fileExists, fragmentsLib, state } = t;

  // 47. 灵感箱（v0.7-3，提案 3.4）：碎片是书架 _碎片 里的普通 txt；插入只改编辑区、不写盘
  const fragDir = path.join(booksRoot, '_碎片');
  const fragStamp = fragmentsLib.formatDateStamp();
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const fragBookCountBefore = (await exec('window.__cwTest.shelfTitles()')).length;
  check(
    '灵感箱：书架有「＋ 碎片」按钮',
    (await exec("document.getElementById('btn-add-fragment').textContent")).includes('碎片') &&
      (await exec("Boolean(document.getElementById('btn-add-fragment'))")) === true
  );

  // 47a. 书架「＋ 碎片」：纯文本框 → 原子写到 _碎片\YYYY-MM-DD-1.txt，UTF-8 无 BOM + CRLF
  await exec('window.__cwTest.openFragmentDialog()');
  check(
    '灵感箱：点「＋ 碎片」弹出记录框，标记为未保存的写盘动作',
    (await exec('window.__cwTest.fragmentDialogOpen()')) === true &&
      (await exec('window.__cwTest.fragmentCounterText()')) === '0 字'
  );
  await exec(`window.__cwTest.setFragmentText(${JSON.stringify('第一段\n第二段')})`);
  check(
    '灵感箱：记录框实时数字数（不含空白）',
    (await exec('window.__cwTest.fragmentCounterText()')) === '6 字'
  );
  const fragFirstSave = await exec('window.__cwTest.saveFragment()');
  check(
    '灵感箱：保存第一条碎片，文件名按当天日期编号',
    fragFirstSave &&
      fragFirstSave.ok === true &&
      fragFirstSave.name === `${fragStamp}-1.txt` &&
      fragFirstSave.chars === 6,
    fragFirstSave
  );
  const fragFirstPath = path.join(fragDir, `${fragStamp}-1.txt`);
  const fragFirstBytes = await fs.readFile(fragFirstPath);
  check(
    '灵感箱：碎片是普通 txt（UTF-8 无 BOM、CRLF），落在书架 _碎片 文件夹',
    fragFirstBytes[0] !== 0xef &&
      fragFirstBytes.toString('utf8') === '第一段\r\n第二段' &&
      !(await fileExists(path.join(booksRoot, '书目.json'))),
    { head: fragFirstBytes.subarray(0, 6).toString('hex') }
  );
  check(
    '灵感箱：保存后弹层自动关闭，书架上没有多出「_碎片」这本书',
    (await exec('window.__cwTest.fragmentDialogOpen()')) === false &&
      (await exec('window.__cwTest.shelfTitles()')).length === fragBookCountBefore &&
      !(await exec('window.__cwTest.shelfTitles()')).includes('_碎片') &&
      !(await exec('window.__cwTest.shelfTitles()')).includes(fragDir)
  );

  // 47b. 第二条：Ctrl+Enter 保存；空内容不写盘
  await exec('window.__cwTest.openFragmentDialog()');
  await exec("window.__cwTest.setFragmentText('第三条')");
  await exec(
    "document.getElementById('fragment-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))"
  );
  await waitFor('window.__cwTest.fragmentDialogOpen() === false');
  check(
    '灵感箱：Ctrl+Enter 保存第二条，当天序号递增为 -2',
    (await fileExists(path.join(fragDir, `${fragStamp}-2.txt`))) === true &&
      (await fs.readFile(path.join(fragDir, `${fragStamp}-2.txt`), 'utf8')) === '第三条'
  );
  await exec('window.__cwTest.openFragmentDialog()');
  await exec("window.__cwTest.setFragmentText('   \\n\\t  ')");
  const fragEmptySave = await exec('window.__cwTest.saveFragment()');
  const fragDirAfterEmpty = (await fs.readdir(fragDir)).filter((name) => /\.txt$/i.test(name)).sort();
  check(
    '灵感箱：空白内容被拦下，不写空文件',
    fragEmptySave &&
      fragEmptySave.ok === false &&
      fragEmptySave.message.includes('空的') &&
      fragDirAfterEmpty.length === 2 &&
      (await exec('window.__cwTest.fragmentDialogOpen()')) === true
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
  );
  check('灵感箱：Esc 关闭记录框', (await exec('window.__cwTest.fragmentDialogOpen()')) === false);

  // 47c. 写作页「插入碎片…」：列表最新在前、预览只读、按打开面板前的位置插入（不写盘）
  await exec("window.__cwTest.newBook('灵感箱测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const fragBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.setText('开头。结尾。')");
  await exec('window.__cwTest.save()');
  // 再加一章：后面要验证「插入只改编辑区」时，靠切章丢弃未保存内容并从磁盘重新读回来
  await exec("window.__cwTest.newChapter('第二章')");
  await waitFor("window.__cwTest.currentTitle().includes('第二章')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('起风')");
  await exec('window.__cwTest.setCaret(3)');
  const fragMetaBeforeParsed = await storage.readBookMeta(fragBookPath);
  const fragChaptersBefore = JSON.stringify(fragMetaBeforeParsed.chapters);
  const fragDiskBefore = await fs.readFile(
    path.join(fragBookPath, fragMetaBeforeParsed.chapters[0].file),
    'utf8'
  );
  check(
    '灵感箱：写作页顶栏有「插入碎片…」按钮',
    (await exec("document.getElementById('btn-insert-fragment').textContent")) === '插入碎片…'
  );
  await exec('window.__cwTest.openInsertFragmentDialog()');
  await waitFor(
    'window.__cwTest.insertFragmentDialogOpen() && window.__cwTest.fragmentRowCount() === 2 && window.__cwTest.fragmentSelectedName() !== ""'
  );
  check(
    '灵感箱：插入面板列出 _碎片 里的 txt（最新在前）并自动预览第一条',
    (await exec('window.__cwTest.fragmentSummary()')).includes('共 2 条碎片') &&
      (await exec('window.__cwTest.fragmentList()')).map((item) => item.name).join(',') ===
        `${fragStamp}-2.txt,${fragStamp}-1.txt` &&
      (await exec('window.__cwTest.fragmentSelectedName()')) === `${fragStamp}-2.txt` &&
      (await exec('window.__cwTest.fragmentPreviewText()')) === '第三条' &&
      (await exec('window.__cwTest.fragmentInsertDisabled()')) === false
  );
  check(
    '灵感箱：插入面板显示插入位置（打开面板前的光标处）',
    (await exec('window.__cwTest.fragmentHint()')).includes('第 4 字'),
    await exec('window.__cwTest.fragmentHint()')
  );
  await exec('window.__cwTest.clickFragmentRow(1)');
  await waitFor(`window.__cwTest.fragmentSelectedName() === ${JSON.stringify(`${fragStamp}-1.txt`)}`);
  check(
    '灵感箱：点另一条会切换预览，内容只读展示',
    (await exec('window.__cwTest.fragmentPreviewText()')) === '第一段\n第二段' &&
      (await exec('window.__cwTest.fragmentPreviewName()')).includes('6 字')
  );
  const fragInsertResult = await exec('window.__cwTest.insertSelectedFragment()');
  const fragTextAfterInsert = await exec('window.__cwTest.text()');
  const fragDiskAfterInsert = await fs.readFile(
    path.join(fragBookPath, (await storage.readBookMeta(fragBookPath)).chapters[0].file),
    'utf8'
  );
  check(
    '灵感箱：碎片插到打开面板前的光标处（开头。|结尾。），面板关闭',
    fragInsertResult &&
      fragInsertResult.ok === true &&
      fragTextAfterInsert === '开头。第一段\n第二段结尾。' &&
      (await exec('window.__cwTest.insertFragmentDialogOpen()')) === false,
    { result: fragInsertResult, text: fragTextAfterInsert }
  );
  check(
    '灵感箱：插入后仍是未保存，磁盘正文没变，原碎片文件还在',
    (await exec('window.__cwTest.dirty()')) === true &&
      fragDiskAfterInsert === fragDiskBefore &&
      (await fileExists(fragFirstPath)) &&
      (await fs.readFile(fragFirstPath, 'utf8')) === '第一段\r\n第二段' &&
      (await fs.readFile(path.join(fragDir, `${fragStamp}-2.txt`), 'utf8')) === '第三条'
  );
  check(
    '灵感箱：插入后光标落在插入内容的末尾',
    (await exec('window.__cwTest.selection()')).start === 3 + '第一段\n第二段'.length,
    await exec('window.__cwTest.selection()')
  );

  // 47d. 有选区时用碎片替换选区；原碎片仍然保留
  await exec('window.__cwTest.setCaret(0)');
  await exec(
    "const el = document.getElementById('editor'); el.focus(); el.setSelectionRange(0, 3);"
  );
  await exec('window.__cwTest.openInsertFragmentDialog()');
  await waitFor('window.__cwTest.fragmentSelectedName() !== ""');
  await exec('window.__cwTest.clickFragmentRow(0)');
  await waitFor(`window.__cwTest.fragmentSelectedName() === ${JSON.stringify(`${fragStamp}-2.txt`)}`);
  const fragReplaceResult = await exec('window.__cwTest.insertSelectedFragment()');
  check(
    '灵感箱：有选区时用碎片替换选中的文字（只改编辑区）',
    fragReplaceResult &&
      fragReplaceResult.ok === true &&
      (await exec('window.__cwTest.text()')) === '第三条第一段\n第二段结尾。' &&
      (await exec('window.__cwTest.dirty()')) === true &&
      (await fs.readFile(path.join(fragDir, `${fragStamp}-2.txt`), 'utf8')) === '第三条'
  );
  // 插入不写盘：切到第 2 章再切回来，未保存的插入内容被丢弃，正文 / 书目 chapters 与插入前一致
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('起风')");
  const fragMetaAfterParsed = await storage.readBookMeta(fragBookPath);
  check(
    '灵感箱：插入过程没有写章节 txt / 书目.json，也没生成 _trash',
    (await exec('window.__cwTest.text()')) === '开头。结尾。' &&
      (await exec('window.__cwTest.dirty()')) === false &&
      (await fs.readFile(
        path.join(fragBookPath, fragMetaAfterParsed.chapters[0].file),
        'utf8'
      )) === fragDiskBefore &&
      JSON.stringify(fragMetaAfterParsed.chapters) === fragChaptersBefore &&
      !(await fileExists(path.join(fragBookPath, '_trash')))
  );

  // 47d-2. 拖拽插入（1.5.0 功能-3）：碎片行可拖、dataTransfer 只带名字、落点跟着指针、全程不写盘
  await exec('window.__cwTest.setCaret(3)');
  // 列表最新在前：第 2 行 = -1.txt（「第一段\n第二段」）
  const fragDragIndex = 1;
  const fragDragName = `${fragStamp}-1.txt`;
  const fragDragText = '第一段\n第二段';
  const fragDragTxtPath = path.join(
    fragBookPath,
    (await storage.readBookMeta(fragBookPath)).chapters[0].file
  );
  const fragDragStatBefore = await fs.stat(fragDragTxtPath);
  const fragDragBytesBefore = await fs.readFile(fragDragTxtPath);
  const fragDragSrcBytesBefore = await fs.readFile(path.join(fragDir, fragDragName));
  await exec('window.__cwTest.openInsertFragmentDialog()');
  await waitFor('window.__cwTest.insertFragmentDialogOpen() && window.__cwTest.fragmentRowCount() === 2');
  const fragDragStart = await exec(`(() => {
    const row = document.querySelectorAll('#fragments-list .fragment-item')[${fragDragIndex}];
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const backdrop = document.getElementById('fragments-backdrop');
    const editor = document.getElementById('editor');
    const r = editor.getBoundingClientRect();
    const under = document.elementFromPoint(
      r.left + Math.min(60, r.width / 2),
      r.top + Math.min(24, r.height / 2)
    );
    return {
      name: row.dataset.name,
      draggable: row.draggable === true,
      types: Array.from(dt.types).sort(),
      custom: dt.getData('application/x-cw-fragment'),
      plain: dt.getData('text/plain'),
      ghost: backdrop.classList.contains('drag-ghost'),
      underId: under ? under.id : ''
    };
  })()`);
  check(
    '灵感箱拖拽：碎片行可拖，dataTransfer 只带碎片名（自定义 MIME + text/plain，没有全文）',
    fragDragStart.name === fragDragName &&
      fragDragStart.draggable === true &&
      fragDragStart.types.join(',') === 'application/x-cw-fragment,text/plain' &&
      fragDragStart.custom === fragDragName &&
      fragDragStart.plain === fragDragName,
    fragDragStart
  );
  check(
    '灵感箱拖拽：拖拽期间面板让路（透明 + 不拦指针），编辑区能被指针命中',
    fragDragStart.ghost === true && fragDragStart.underId === 'editor',
    { ghost: fragDragStart.ghost, underId: fragDragStart.underId }
  );

  // 松手没落在正文（只有 dragend、没有 drop）：面板恢复可点，正文一个字不动
  await exec(`(() => {
    const row = document.querySelectorAll('#fragments-list .fragment-item')[${fragDragIndex}];
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));
  })()`);
  check(
    '灵感箱拖拽：没落在正文就松手 → ghost 摘掉、面板还开着，正文不动',
    (await exec("document.getElementById('fragments-backdrop').classList.contains('drag-ghost')")) === false &&
      (await exec('window.__cwTest.insertFragmentDialogOpen()')) === true &&
      (await exec('window.__cwTest.text()')) === '开头。结尾。'
  );

  // 拖到正文左侧：落点在第 0 字（打开面板前光标是 3，落下后必须按指针位置，不是旧光标）
  const fragDropLeft = await exec(`(() => {
    const ta = document.getElementById('editor');
    const row = document.querySelectorAll('#fragments-list .fragment-item')[${fragDragIndex}];
    const r = ta.getBoundingClientRect();
    const name = ${JSON.stringify(fragDragName)};
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', {
      dataTransfer: dt, bubbles: true, cancelable: true
    }));
    const x = r.left + 10;
    const y = r.top + 14;
    const over = new DragEvent('dragover', {
      dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true
    });
    ta.dispatchEvent(over);
    const drop = new DragEvent('drop', {
      dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true
    });
    ta.dispatchEvent(drop);
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));
    return {
      overPrevented: over.defaultPrevented,
      dropPrevented: drop.defaultPrevented,
      transferred: dt.getData('application/x-cw-fragment'),
      x,
      y
    };
  })()`);
  const fragDragExpectedLeft = fragDragText + '开头。结尾。';
  await waitFor(`window.__cwTest.text() === ${JSON.stringify(fragDragExpectedLeft)}`);
  const fragDragStatAfter = await fs.stat(fragDragTxtPath);
  const fragDragBytesAfter = await fs.readFile(fragDragTxtPath);
  check(
    '灵感箱拖拽：dragover / drop 都被 preventDefault，碎片按落点插到正文最前（不是旧光标 3）',
    // 合成事件里 dropEffect / effectAllowed 读回来恒为 none（Chromium 只在真实拖拽里维护）：
      // 这里只核对同一个 DataTransfer 带着碎片名、且 dragover / drop 都被 preventDefault
      fragDropLeft.overPrevented === true &&
      fragDropLeft.dropPrevented === true &&
      fragDropLeft.transferred === fragDragName &&
      (await exec('window.__cwTest.text()')) === fragDragExpectedLeft,
    { drop: fragDropLeft, text: await exec('window.__cwTest.text()') }
  );
  check(
    '灵感箱拖拽：插入后仍未保存、面板关闭，章节 txt（内容 + mtime）/ 书目 / 原碎片一个字节没动',
    (await exec('window.__cwTest.dirty()')) === true &&
      (await exec('window.__cwTest.statusText()')).includes('未保存') &&
      (await exec('window.__cwTest.insertFragmentDialogOpen()')) === false &&
      (await exec("document.getElementById('fragments-backdrop').classList.contains('drag-ghost')")) === false &&
      fragDragBytesAfter.equals(fragDragBytesBefore) &&
      fragDragStatAfter.mtimeMs === fragDragStatBefore.mtimeMs &&
      (await fs.readFile(path.join(fragDir, fragDragName))).equals(fragDragSrcBytesBefore) &&
      (await exec('window.__cwTest.fragmentList()')).length === 2,
    {
      text: await exec('window.__cwTest.text()'),
      dirty: await exec('window.__cwTest.dirty()'),
      mtimeBefore: fragDragStatBefore.mtimeMs,
      mtimeAfter: fragDragStatAfter.mtimeMs
    }
  );

  // 原生 Ctrl+Z（execCommand undo）撤掉这次拖入：正文回到插入前，未保存状态清掉
  const fragDragUndo = await exec('window.__cwTest.undoEditor()');
  check(
    '灵感箱拖拽：可 Ctrl+Z 撤销（原生撤销链）→ 正文回到插入前，未保存状态清掉',
    fragDragUndo &&
      fragDragUndo.ok === true &&
      fragDragUndo.text === '开头。结尾。' &&
      fragDragUndo.dirty === false &&
      (await exec('window.__cwTest.text()')) === '开头。结尾。' &&
      (await exec('window.__cwTest.dirty()')) === false,
    fragDragUndo
  );

  // 同一个碎片拖到右侧：插到末尾（证明落点跟着指针走，不是固定位置）
  await exec('window.__cwTest.setCaret(0)');
  await exec('window.__cwTest.openInsertFragmentDialog()');
  await waitFor('window.__cwTest.insertFragmentDialogOpen() && window.__cwTest.fragmentRowCount() === 2');
  await exec(`(() => {
    const ta = document.getElementById('editor');
    const row = document.querySelectorAll('#fragments-list .fragment-item')[${fragDragIndex}];
    const r = ta.getBoundingClientRect();
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', {
      dataTransfer: dt, bubbles: true, cancelable: true
    }));
    const x = r.right - 14;
    const y = r.top + 14;
    ta.dispatchEvent(new DragEvent('dragover', {
      dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true
    }));
    ta.dispatchEvent(new DragEvent('drop', {
      dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true
    }));
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));
  })()`);
  const fragDragExpectedRight = '开头。结尾。' + fragDragText;
  await waitFor(`window.__cwTest.text() === ${JSON.stringify(fragDragExpectedRight)}`);
  check(
    '灵感箱拖拽：同一个碎片拖到正文右侧 → 插到末尾（落点随指针变化）',
    (await exec('window.__cwTest.text()')) === fragDragExpectedRight &&
      (await exec('window.__cwTest.dirty()')) === true
  );
  // 撤销回 '开头。结尾。'，后面 47e 仍按这个正文口径继续
  await exec('window.__cwTest.undoEditor()');
  await waitFor("window.__cwTest.text() === '开头。结尾。' && window.__cwTest.dirty() === false");

  // 47e. 自己放进 _碎片 的普通 txt 也能插入；刷新只读
  await fs.writeFile(path.join(fragDir, '手工碎片.txt'), '手工放进来的灵感', 'utf8');
  await exec('window.__cwTest.openInsertFragmentDialog()');
  await waitFor('window.__cwTest.fragmentRowCount() === 3');
  const fragManual = await exec('window.__cwTest.refreshFragments()');
  check(
    '灵感箱：直接放进 _碎片 的 txt 也会列出来（不需要应用生成）',
    fragManual &&
      fragManual.ok === true &&
      fragManual.total === 3 &&
      (await exec('window.__cwTest.fragmentRowTexts()')).some((text) => text.includes('手工碎片.txt'))
  );
  // 拍板 #9：列表按文件名日期分组。分组跟随列表顺序（排序先按 mtime 倒序，最后写的
  // 手工 txt 在最前 → 第一组就是「更早」），所以这里不写死组顺序：按时间顺序把
  // 「.fragment-day + 其后的 .fragment-item」切成组，再逐组核对。
  const fragStructure = await exec(`(() => {
    const list = document.getElementById('fragments-list');
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    const now = new Date();
    const todayKey = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    const groups = [];
    const loose = [];
    let current = null;
    for (const el of list.children) {
      if (el.classList.contains('fragment-day')) {
        current = { day: el.textContent, tag: el.tagName, isRow: el.classList.contains('fragment-item'), keys: [] };
        groups.push(current);
      } else if (el.classList.contains('fragment-item')) {
        const m = /^(\\d{4}-\\d{2}-\\d{2})/.exec(el.dataset.name || '');
        const key = m ? m[1] : '';
        if (current) current.keys.push(key);
        else loose.push(key); // 分组标题之前不该有行
      }
    }
    return {
      groups: groups.map((g) => ({
        day: g.day,
        tag: g.tag,
        isRow: g.isRow,
        keys: g.keys,
        allSameKey: g.keys.every((k) => k === g.keys[0]),
        allToday: g.keys.every((k) => k === todayKey),
        allUndated: g.keys.every((k) => k === '')
      })),
      loose
    };
  })()`);
  check(
    '灵感箱：列表按日期分组（今天 / 更早），标题是纯文本分隔、不被算成碎片行',
    fragStructure.loose.length === 0 &&
      fragStructure.groups.length === 2 &&
      fragStructure.groups.map((g) => g.day).join(',') === '更早,今天' &&
      fragStructure.groups.every((g) => g.tag === 'DIV' && g.isRow === false && g.keys.length >= 1 && g.allSameKey === true) &&
      fragStructure.groups[0].allUndated === true &&
      fragStructure.groups[1].allToday === true &&
      fragStructure.groups.reduce((n, g) => n + g.keys.length, 0) === 3 &&
      (await exec('window.__cwTest.fragmentRowCount()')) === 3,
    fragStructure
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
  );
  check(
    '灵感箱：Esc 关闭插入面板，正文与磁盘都不变',
    (await exec('window.__cwTest.insertFragmentDialogOpen()')) === false &&
      (await exec('window.__cwTest.text()')) === '开头。结尾。'
  );

  // 47f. 旧数据兼容：v0.4.1 形状的书照常打开 / 插入碎片，书目不被补字段
  await exec("window.__cwTest.newBook('灵感箱旧书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const fragLegacyBookPath = await exec('window.__cwTest.bookPathValue()');
  const fragLegacyMetaPath = path.join(fragLegacyBookPath, '书目.json');
  state.fragLegacyBookPath = fragLegacyBookPath; // 第 48 / 49 / 50 / 51 组的「旧书兼容」都用这本 v0.4.1 旧书
  state.fragLegacyMetaPath = fragLegacyMetaPath;
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.setText('旧书正文。')");
  await exec('window.__cwTest.save()');
  const fragLegacyRaw = JSON.parse(await fs.readFile(fragLegacyMetaPath, 'utf8'));
  delete fragLegacyRaw.schemaVersion;
  for (const chapter of fragLegacyRaw.chapters) {
    delete chapter.status;
    delete chapter.note;
  }
  await fs.writeFile(fragLegacyMetaPath, JSON.stringify(fragLegacyRaw, null, 2), 'utf8');
  const fragLegacyBefore = await fs.readFile(fragLegacyMetaPath, 'utf8');
  await exec('window.__cwTest.backToShelf()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fragLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.setCaret(0)');
  await exec('window.__cwTest.openInsertFragmentDialog()');
  await waitFor('window.__cwTest.fragmentRowCount() === 3 && window.__cwTest.fragmentSelectedName() !== ""');
  // 这时最新的是手工放进去的 txt，用名字明确选当天第 2 条，别依赖列表下标
  await exec(`window.__cwTest.selectFragmentByName(${JSON.stringify(`${fragStamp}-2.txt`)})`);
  await waitFor(`window.__cwTest.fragmentSelectedName() === ${JSON.stringify(`${fragStamp}-2.txt`)}`);
  const fragLegacyInsert = await exec('window.__cwTest.insertSelectedFragment()');
  const fragLegacyAfter = await fs.readFile(fragLegacyMetaPath, 'utf8');
  check(
    '灵感箱：没有 schemaVersion 的旧书照常打开、插入碎片，书目不被补字段',
    (await exec('window.__cwTest.currentTitle()')).includes('起风') &&
      fragLegacyInsert &&
      fragLegacyInsert.ok === true &&
      (await exec('window.__cwTest.text()')) === '第三条旧书正文。' &&
      fragLegacyAfter === fragLegacyBefore &&
      fragLegacyAfter.includes('"schemaVersion"') === false,
    { text: await exec('window.__cwTest.text()') }
  );
  // 回到磁盘内容（single chapter 没法靠切章丢弃，直接把编辑区恢复成 baseText，仍是未保存状态清零）
  await exec("window.__cwTest.setText('旧书正文。')");
  await exec('window.__cwTest.refreshShelf()');
  // _碎片 全程只有 3 个 txt，没有临时文件残留；书架书目数量 / 书卡都没被碎片影响
  const fragFinalNames = (await fs.readdir(fragDir)).filter((name) => /\.txt$/i.test(name)).sort();
  check(
    '灵感箱：_碎片 里只有 3 条 txt，没有原子写临时文件残留，书架书目数量不变',
    fragFinalNames.length === 3 &&
      (await fs.readdir(fragDir)).every((name) => !name.startsWith('.')) &&
      (await exec('window.__cwTest.shelfTitles()')).length === fragBookCountBefore + 2,
    { names: fragFinalNames, books: await exec('window.__cwTest.shelfTitles()') }
  );
};
