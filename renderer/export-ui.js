/* 导出 / 复制（v0.9 B-5 第一刀：从 renderer.js 按分区整段搬出来）。
 *
 * 为什么搬这一块：renderer.js 已到 9600 行闸门（搬前 9259 行），而「导出 / 复制」这一域的
 * 输入输出最清楚——整块只碰 10 个渲染层成员（api / $ / editorEl / s2tLib / call / state /
 * toast / volumeList / chapterVolumeId / hideExportMenu）+ 1 个活绑定（当前导出格式），
 * 不碰 IPC 白名单、不碰存储、不碰 Esc 优先级；外部只有 10 个入口被别处按名字取
 * （事件绑定 8 处、Esc 注册表的 closeExportDialog、测试钩子 3 处）。
 *
 * 契约：createExportUi(host) 由渲染层调用一次，host 提供：
 *   host = {
 *     api, $, editorEl, s2tLib, call, state, toast, volumeList, chapterVolumeId, hideExportMenu,
 *     get exportFormat() / set exportFormat(value)   // 活绑定：'txt' | 'epub' | 'docx'
 *   }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到点「导出」时才 ReferenceError）。
 * 「当前导出格式」这个模块级 let 故意**留在 renderer.js**（testHooksScope 的
 * get exportFormat() / E2E 的 __cwTest.exportFormat() 口径一字未变），模块只通过
 * host 的 get / set 读写它——这是本刀唯一的变量交接。
 *
 * 搬过来的东西（行为一字未改，文案 / class / 按钮文字 / 提示语都照旧）：
 *   - 导出范围对话框：全书 / 某一卷 / 第 X–Y 章三种范围，字数与默认文件名由主进程算
 *     （book:export-plan 只读），连续改范围时的旧计划作废令牌；
 *   - TXT / EPUB / DOCX 三种导出流程（都带上当前章未保存的内容，只参与这次导出、不写盘）；
 *   - 复制整本 / 复制本章（平台格式：只复制正文，套段首缩进 + 段间空行）；
 *   - 成功提示的公共措辞（章数 / 字数 / 卷数 / 简繁转换标记）。
 *
 * 红线不变：只读磁盘 + 只写剪贴板 / 另存文件，**不改编辑区文字、不写盘、不切章、不改 dirty**。
 * 浏览器里挂成全局 CWExportUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWExportUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['api', '$', 'editorEl', 's2tLib', 'call', 'state', 'toast', 'volumeList', 'chapterVolumeId', 'hideExportMenu', 'formatCount'];

  function createExportUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createExportUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createExportUi 的 host 缺少 ' + key);
      }
    }
    if (typeof host.exportFormat !== 'string') {
      throw new TypeError('createExportUi 的 host 缺少 exportFormat（当前导出格式的活绑定）');
    }
    const { api, $, editorEl, s2tLib, call, state, toast, volumeList, chapterVolumeId, hideExportMenu, formatCount } = host;

  // ---------- 导出 / 复制 ----------
  // 导出 / 复制以磁盘内容为准，但当前章如果还没保存，就把编辑区里的最新内容一起带上
  // （只参与这一次拼接，绝不写盘），这样「导出 = 你眼睛看到的」，保存仍然完全手动。
  function currentChapterOverride() {
    if (!state.dirty) return null;
    const chapter = state.chapters[state.index];
    if (!chapter) return null;
    return { chapterId: chapter.id, text: editorEl.value };
  }

  function outputSummary(data) {
    const parts = [];
    // 范围导出时先说是哪一段（全书不用重复说）
    if (data.rangeLabel && data.rangeLabel !== '全书') parts.push(data.rangeLabel);
    parts.push(`${data.chapterCount} 章`, `${formatCount(Number(data.chars) || 0)} 字`);
    if (data.includedUnsaved) parts.push('含当前章未保存内容');
    return `（${parts.join(' · ')}）`;
  }

  // EPUB / DOCX 导出成功提示的公共部分：和 TXT 同一套措辞，只多一个「几卷」（有卷才写）。
  function archiveSummaryParts(data) {
    const parts = [];
    if (data.rangeLabel && data.rangeLabel !== '全书') parts.push(data.rangeLabel);
    parts.push(`${data.chapterCount} 章`);
    if (data.volumeCount) parts.push(`${data.volumeCount} 卷`);
    parts.push(`${formatCount(Number(data.chars) || 0)} 字`);
    if (data.includedUnsaved) parts.push('含当前章未保存内容');
    return parts;
  }

  // ---------- 导出范围对话框 ----------
  // 默认「全书」和以前完全一样；也可以只导某一卷 / 第 X–Y 章。
  // 章数、字数、默认文件名都由主进程算（book:export-plan 只读），避免界面和导出两套规则。
  // v0.8 P0 N8：TXT / EPUB 共用这个范围对话框，exportFormat 记住这次是哪种格式。
  // v0.8 P0 N9：DOCX 也走同一个对话框。
  const EXPORT_UNVOLUMED = '__none__';
  const EXPORT_MESSAGES = {
    txt: '选择导出范围。格式和以前一样（标题行 + 空行 + 正文，UTF-8 带 BOM，CRLF）；当前章没保存的内容也会一起导出，但不会写盘。',
    epub:
      '选择导出范围。导出成 EPUB 3 电子书（分卷做目录级、一章一个 XHTML、段首缩进 + 段间空行）；当前章没保存的内容也会一起导出，但不会写盘。',
    docx:
      '选择导出范围。导出成 Word 文档（.docx：标题页 + 卷 / 章标题、段首缩进 2 字、1.5 倍行距）；当前章没保存的内容也会一起导出，但不会写盘。'
  };
  const EXPORT_TITLES = { txt: '导出 TXT', epub: '导出 EPUB', docx: '导出 DOCX' };
  let exportPlanTimer = null;
  let exportPlanToken = 0;
  let lastExportPlan = null;

  function readExportRange() {
    const checked = document.querySelector('input[name="export-scope"]:checked');
    const mode = checked ? checked.value : 'all';
    if (mode === 'volume') {
      const value = $('export-volume').value;
      return { mode: 'volume', volumeId: value === EXPORT_UNVOLUMED ? null : value };
    }
    if (mode === 'range') {
      return {
        mode: 'range',
        from: Number.parseInt($('export-from').value, 10),
        to: Number.parseInt($('export-to').value, 10)
      };
    }
    return { mode: 'all' };
  }

  // 返回空字符串 = 合法；否则是给作者看的中文提示
  function validateExportRange(range) {
    if (range.mode !== 'range') return '';
    const total = state.chapters.length;
    if (!Number.isInteger(range.from) || !Number.isInteger(range.to)) return '请输入起始章和结束章';
    if (range.from < 1 || range.to < 1 || range.from > total || range.to > total) {
      return `章节范围要在第 1–${total} 章之间`;
    }
    if (range.from > range.to) return '起始章不能大于结束章';
    return '';
  }

  function fillExportVolumeOptions() {
    const row = $('export-volume-row');
    const select = $('export-volume');
    const volumes = volumeList();
    row.classList.toggle('hidden', volumes.length === 0);
    select.innerHTML = '';
    const addOption = (value, label) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    };
    const unvolumed = state.chapters.filter((chapter) => !chapterVolumeId(chapter)).length;
    if (unvolumed > 0) addOption(EXPORT_UNVOLUMED, `未分卷（${unvolumed} 章）`);
    volumes.forEach((volume) => {
      const count = state.chapters.filter((chapter) => chapterVolumeId(chapter) === volume.id).length;
      addOption(volume.id, `${String(volume.name || '未命名卷')}（${count} 章）`);
    });
    if (!select.options.length) addOption(EXPORT_UNVOLUMED, '未分卷（0 章）');
  }

  // 单选了哪种范围，就把另外两个范围的输入框灰掉，避免误以为能同时选
  function syncExportScopeInputs() {
    const range = readExportRange();
    $('export-volume').disabled = range.mode !== 'volume';
    $('export-from').disabled = range.mode !== 'range';
    $('export-to').disabled = range.mode !== 'range';
  }

  async function refreshExportSummary() {
    syncExportScopeInputs();
    const summaryEl = $('export-summary');
    const confirmBtn = $('btn-export-confirm');
    const range = readExportRange();
    const error = validateExportRange(range);
    if (error) {
      lastExportPlan = null;
      summaryEl.textContent = error;
      summaryEl.classList.add('warn');
      confirmBtn.disabled = true;
      return;
    }
    const token = ++exportPlanToken;
    let res;
    try {
      res = await call(api.exportPlan, state.bookPath, currentChapterOverride(), range);
    } catch (err) {
      if (token !== exportPlanToken) return;
      lastExportPlan = null;
      summaryEl.textContent = `无法读取导出信息：${err.message}`;
      summaryEl.classList.add('warn');
      confirmBtn.disabled = true;
      return;
    }
    if (token !== exportPlanToken) return;
    if (!res || res.empty) {
      lastExportPlan = null;
      summaryEl.textContent = '所选范围里没有章节，换个范围试试';
      summaryEl.classList.add('warn');
      confirmBtn.disabled = true;
      return;
    }
    lastExportPlan = res;
    const bits = [`将导出 ${res.chapterCount} 章`, `${formatCount(res.chars)} 字`];
    if (res.includedUnsaved) bits.push('含当前章未保存内容');
    // EPUB / DOCX 与 TXT 的范围规则一样，只是默认文件名后缀不同（主进程统一算好）
    const fileName =
      host.exportFormat === 'epub'
        ? res.epubFileName
        : host.exportFormat === 'docx'
          ? res.docxFileName
          : res.fileName;
    summaryEl.textContent = `${bits.join(' · ')}；默认文件名：${fileName}`;
    summaryEl.classList.remove('warn');
    confirmBtn.disabled = false;
  }

  function scheduleExportSummary(delay = 0) {
    if (exportPlanTimer) clearTimeout(exportPlanTimer);
    exportPlanTimer = setTimeout(() => {
      exportPlanTimer = null;
      refreshExportSummary();
    }, delay);
  }

  // format = 'txt'（默认）| 'epub' | 'docx'：三个入口共用同一套范围选择，标题 / 说明跟着换。
  // preset（1.5.0 功能-1，可选）：{ from, to } 1-based 全书章节位置 —— 章节多选「导出选中章」用它
  // 预选「第 X–Y 章」范围（多选只支持连续范围，非连续由调用方先提示，不静默扩大）。
  function openExportDialog(format = 'txt', preset = null) {
    hideExportMenu();
    if (!state.bookPath) return;
    if (!state.chapters.length) {
      toast('这本书里还没有章节，没有可导出的内容', 'warn');
      return;
    }
    host.exportFormat = format === 'epub' || format === 'docx' ? format : 'txt';
    const total = state.chapters.length;
    $('export-title').textContent = EXPORT_TITLES[host.exportFormat] || EXPORT_TITLES.txt;
    $('export-message').textContent = EXPORT_MESSAGES[host.exportFormat];
    fillExportVolumeOptions();
    const allRadio = document.querySelector('input[name="export-scope"][value="all"]');
    if (allRadio) allRadio.checked = true;
    $('export-all-count').textContent = `（${total} 章）`;
    // 按卷编号：范围还是按全书顺序（输入的是第几个章节），导出标题才用卷内章号
    const numberingHint = $('export-numbering-hint');
    if (numberingHint) {
      const byVolume = Boolean(state.meta && state.meta.chapterNumbering === 'volume');
      numberingHint.classList.toggle('hidden', !byVolume);
      // 功能-5（2026-11-11）：只把已知差异写清——范围输入按全书顺序，和写作页的卷内号不同；
      // 导出文件里的章标题才按各卷自己的章号。不改任何范围计算 / 导出语义。
      numberingHint.textContent = byVolume
        ? '这本书按卷编号：「第 X 章到第 Y 章」按全书章节顺序计算（填的是全书第几章，不是写作页目录里的卷内号）；导出文件里的章标题用各卷自己的章号。'
        : '';
    }
    $('export-from').value = '1';
    $('export-to').value = String(total);
    $('export-from').max = String(total);
    $('export-to').max = String(total);
    $('export-from').min = '1';
    $('export-to').min = '1';
    // 1.5.0 功能-1：批量「导出选中章」预选范围（from/to 是 1-based 全书位置；越界由
    // validateExportRange 在这里当场提示，不会静默改成别的范围）
    if (preset && Number.isInteger(preset.from) && Number.isInteger(preset.to)) {
      const rangeRadio = document.querySelector('input[name="export-scope"][value="range"]');
      if (rangeRadio) rangeRadio.checked = true;
      $('export-from').value = String(preset.from);
      $('export-to').value = String(preset.to);
    }
    // 重新打开时先清掉上一次的摘要 / 计划：否则「上次的 2 章」会先显示出来，
    // 作者手快按「导出…」时计划还没回来，会误报「所选范围里没有章节」。
    lastExportPlan = null;
    exportPlanToken += 1;
    $('export-summary').textContent = '正在读取导出信息…';
    $('export-summary').classList.remove('warn');
    $('btn-export-confirm').disabled = true;
    renderExportConversionNote();
    $('export-backdrop').classList.remove('hidden');
    refreshExportSummary();
  }

  // 导出简繁转换（v0.8 P0 N7）：档位在「设置 → 导出」里选，这里只读地告诉作者这次会怎么导，
  // 免得导完才发现字形被换掉。真正转换在主进程做（只作用于导出副本）。
  function exportConversionMode() {
    return s2tLib.normalizeMode((state.config || {}).exportConversion);
  }

  function renderExportConversionNote() {
    const el = $('export-conversion-note');
    if (!el) return;
    const mode = exportConversionMode();
    el.textContent = mode
      ? `简繁转换：${s2tLib.modeLabel(mode)}（只改导出的文件，原稿和书库不变；要改请去「设置 → 导出」）`
      : '简繁转换：不转换（要转简 / 繁体可在「设置 → 导出」里选；只作用于导出的副本）';
    el.classList.toggle('is-on', Boolean(mode));
  }

  function closeExportDialog() {
    $('export-backdrop').classList.add('hidden');
    exportPlanToken += 1; // 让还没回来的摘要失效
    if (exportPlanTimer) {
      clearTimeout(exportPlanTimer);
      exportPlanTimer = null;
    }
    lastExportPlan = null;
  }

  async function confirmExportDialog() {
    const range = readExportRange();
    const error = validateExportRange(range);
    if (error) {
      toast(error, 'warn');
      return;
    }
    if (!lastExportPlan || lastExportPlan.empty) {
      toast('所选范围里没有章节，换个范围试试', 'warn');
      return;
    }
    const format = host.exportFormat;
    closeExportDialog();
    if (format === 'epub') await exportEpubFlow(range);
    else if (format === 'docx') await exportDocxFlow(range);
    else await exportBookFlow(range);
  }

  async function copyBookFlow() {
    if (!state.bookPath) return;
    try {
      const data = await call(api.copyBook, state.bookPath, currentChapterOverride());
      toast(`已复制整本${outputSummary(data)}`);
    } catch (err) {
      toast(`复制失败：${err.message}`, 'error');
    }
  }

  // 复制本章（平台格式）：只复制正文（不含章名，平台后台的章名是单独一栏）。
  // 正文套「段首缩进 + 空一行（含缩进）」后进剪贴板，不写盘；
  // 当前章有未保存修改时，编辑区里的最新内容优先（和导出/复制整本一个惯例）。
  async function copyChapterPlatformFlow(index) {
    if (!state.bookPath) return null;
    const chapter = state.chapters[index];
    if (!chapter) return null;
    const ref = { chapterId: chapter.id };
    if (index === state.index && state.dirty) ref.text = editorEl.value;
    try {
      const data = await call(api.copyChapterPlatform, state.bookPath, ref);
      if (data.empty) {
        toast('本章还没有正文，没有可复制的内容（剪贴板没动）', 'warn');
        return data;
      }
      const parts = [`${data.paragraphs} 段`, `${formatCount(data.chars)} 字`];
      if (data.includedUnsaved) parts.push('含未保存内容');
      toast(`已复制「${data.title}」正文（段首缩进 + 段间空行：${parts.join(' · ')}）`);
      return data;
    } catch (err) {
      toast(`复制本章失败：${err.message}`, 'error');
      return null;
    }
  }

  // range 不传 = 全书；传 { mode:'volume'|'range' } 只导出选中的部分
  async function exportBookFlow(range) {
    if (!state.bookPath) return;
    try {
      const data = await call(api.exportBook, state.bookPath, currentChapterOverride(), range);
      if (data.canceled) return;
      toast(`已导出：${data.filePath}${outputSummary(data)}${conversionTag(data.conversion)}`);
    } catch (err) {
      toast(`导出失败：${err.message}`, 'error');
    }
  }

  // 导出时的简繁转换提示：只有真的转了才在提示里说一声（原稿没动）
  function conversionTag(mode) {
    const m = s2tLib.normalizeMode(mode);
    return m ? `（已${s2tLib.modeLabel(m)}）` : '';
  }

  // 导出 EPUB：整本或选中的卷 / 章节一本电子书（分卷 → 目录级、一章一个 XHTML、纯文字封面页）。
  // 和 TXT 导出一样带上当前章未保存的内容（只参与这次导出，不写盘）；range 不传 = 全书。
  async function exportEpubFlow(range) {
    if (!state.bookPath) return;
    try {
      const data = await call(api.exportEpub, state.bookPath, currentChapterOverride(), range);
      if (data.canceled) return;
      toast(
        `已导出 EPUB：${data.filePath}（${archiveSummaryParts(data).join(' · ')}）${conversionTag(data.conversion)}`
      );
    } catch (err) {
      toast(`导出 EPUB 失败：${err.message}`, 'error');
    }
  }

  // 导出 DOCX：整本或选中的卷 / 章节一份 Word 文档（标题页 + 卷 / 章标题 + 段首缩进）。
  // 和 TXT / EPUB 导出一样带上当前章未保存的内容（只参与这次导出，不写盘）；range 不传 = 全书。
  async function exportDocxFlow(range) {
    if (!state.bookPath) return;
    try {
      const data = await call(api.exportDocx, state.bookPath, currentChapterOverride(), range);
      if (data.canceled) return;
      toast(
        `已导出 DOCX：${data.filePath}（${archiveSummaryParts(data).join(' · ')}）${conversionTag(data.conversion)}`
      );
    } catch (err) {
      toast(`导出 DOCX 失败：${err.message}`, 'error');
    }
  }

  async function openBookFolderFlow() {
    if (!state.bookPath) return;
    try {
      await call(api.openBookFolder, state.bookPath);
    } catch (err) {
      toast(`打开文件夹失败：${err.message}`, 'error');
    }
  }

    return {
      readExportRange,
      validateExportRange,
      refreshExportSummary,
      scheduleExportSummary,
      openExportDialog,
      exportConversionMode,
      closeExportDialog,
      confirmExportDialog,
      copyBookFlow,
      copyChapterPlatformFlow,
      openBookFolderFlow,
      currentChapterOverride,
      outputSummary,
      archiveSummaryParts,
      conversionTag
    };
  }

  return { create: createExportUi, REQUIRED_HOST };
});
