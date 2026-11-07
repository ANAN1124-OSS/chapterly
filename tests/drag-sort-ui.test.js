const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const dragSort = require('../renderer/drag-sort-ui');
const { loadSourceGate, restoreGlobalsAfter } = require('./ui-test-preambles');

// v0.9 B-5 第五刀：「章节拖拽排序」一段（原 renderer.js 1539–1745 行，207 行）
// 搬到 renderer/drag-sort-ui.js。搬之前这段只有 E2E 的黑盒覆盖
// （moveChapterByDrag 的「第 3 章移到最前」+ 测试钩子 dragChapterTo 走 moveChapterByDrop），
// 拖拽阈值 / 落点计算（前半插前、后半插后、丢到卷标题、指针在末尾之后、自动滚动）/
// 原地不动不写盘的短路 / suppressChapterClick / 两条 IPC 参数在 Node 里一步都测不到。
// 搬出来以后用「假 host + 假 DOM + 假 window」逐条钉住，再用静态闸门保证渲染层不长回第二份。
//
// 拖拽过程（updateChapterDrag / endChapterDrag）**不额外导出**：仍和搬运前一样只由
// setupChapterDrag 注册的 window 监听驱动，测试也按这条真实路径打（fire pointermove / pointerup）。

// 模块运行时会摸 document / window：真身由共享前导存下，test.after 放回。
restoreGlobalsAfter(test, ['document', 'window']);

const { rendererCode, indexSrc, moduleSrc, moduleCode } = loadSourceGate('drag-sort-ui.js');

const HOST_KEYS = [
  '$', 'api', 'call', 'chapterVolumeId', 'renderChapterList', 'renderEditorHeader',
  'state', 'toast', 'updateStatus', 'volumeDisplayName'
];

// ---------- 假 DOM：只实现本模块真正用到的几样 ----------
function makeEl(opts = {}) {
  const classes = new Set(opts.classes || []);
  const el = {
    dataset: opts.dataset || {},
    children: opts.children || [],
    scrollTop: opts.scrollTop || 0,
    rect: opts.rect || { top: 0, height: 40 },
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n)
    },
    getBoundingClientRect() {
      return { top: el.rect.top, height: el.rect.height, bottom: el.rect.top + el.rect.height };
    },
    // 选择器只用逗号分组 + .a.b 形式；子节点递归算进去（本模块只查章节条目）
    querySelectorAll(selector) {
      const groups = selector.split(',').map((s) => s.trim());
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (groups.some((g) => g.split('.').filter(Boolean).every((c) => child.classList.contains(c)))) out.push(child);
          walk(child);
        }
      };
      walk(el);
      return out;
    }
  };
  return el;
}

function chapterEl(index, top) {
  return makeEl({ classes: ['chapter-item'], dataset: { index: String(index) }, rect: { top, height: 40 } });
}

function volumeEl(volumeId, top) {
  return makeEl({ classes: ['volume-item'], dataset: { volumeId }, rect: { top, height: 32 } });
}

function makeWorld(options = {}) {
  const body = makeEl();
  const list = makeEl({ rect: { top: 100, height: 400 } });
  const chapters = options.chapters || [
    { id: 'c1', name: '一', volumeId: null },
    { id: 'c2', name: '二', volumeId: 'v1' },
    { id: 'c3', name: '三', volumeId: 'v1' }
  ];
  const state = {
    saving: false,
    loading: false,
    bookPath: 'C:\\books\\某书',
    chapters,
    index: 0,
    meta: { chapters, volumes: [{ id: 'v1', name: '第一卷' }], updatedAt: 'T0' },
    suppressChapterClick: 0,
    ...(options.state || {})
  };
  const calls = [];
  const toasts = [];
  const renders = { list: 0, header: 0, status: 0, lastOpen: [] };
  const host = {
    $: (id) => (id === 'chapter-list' ? list : null),
    api: {
      moveChapterTo: 'chapters:move-to',
      moveChapter: 'chapters:move'
    },
    async call(channel, ...args) {
      calls.push({ channel, args });
      if (options.onCall) {
        const handler = options.onCall(channel, ...args);
        if (handler instanceof Error) throw handler;
        if (handler !== undefined) return handler;
      }
      return {};
    },
    chapterVolumeId: (c) => (c && c.volumeId ? c.volumeId : null),
    renderChapterList() { renders.list += 1; },
    renderEditorHeader() { renders.header += 1; },
    state,
    toast(message, kind = 'info') { toasts.push({ message, kind }); },
    updateStatus() { renders.status += 1; },
    volumeDisplayName: (volumeId) => ({ v1: '第一卷' }[volumeId] || '未分卷')
  };
  host.api.setLastOpenChapter = async (...args) => {
    renders.lastOpen.push(args);
  };
  const listeners = new Map();
  globalThis.window = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    }
  };
  globalThis.document = { body };
  const ui = dragSort.create(host);
  ui.setupChapterDrag(); // 真实装配路径：window 上的三个监听由它一次装上
  const fire = (type, ev) => {
    const fns = listeners.get(type) || [];
    const last = fns[fns.length - 1];
    return last ? last(ev) : undefined;
  };
  return { ui, host, state, list, body, calls, toasts, renders, listeners, fire };
}

function event(clientY, extra = {}) {
  return { button: 0, clientY, currentTarget: null, ...extra };
}

// ---------- host 契约 / 装配 ----------

test('host 契约：10 个成员缺任何一个都抛 TypeError，空 host / null 也抛', () => {
  const { host } = makeWorld();
  assert.deepEqual([...dragSort.REQUIRED_HOST], HOST_KEYS);
  assert.throws(() => dragSort.create(null), /createDragSortUi 需要 host 对象/);
  assert.throws(() => dragSort.create('x'), /createDragSortUi 需要 host 对象/);
  for (const key of HOST_KEYS) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(
      () => dragSort.create(broken),
      new RegExp('createDragSortUi 的 host 缺少 ' + key.replace(/\$/g, '\\$'))
    );
  }
  // null 也算缺（不是「用假值兜底」）
  assert.throws(
    () => dragSort.create({ ...host, volumeDisplayName: null }),
    /createDragSortUi 的 host 缺少 volumeDisplayName/
  );
});

test('create() 只接线：没有 document / window 也建得出来，交出 5 个入口', () => {
  const { host } = makeWorld();
  delete globalThis.document;
  delete globalThis.window;
  const ui = dragSort.create(host);
  assert.deepEqual(Object.keys(ui).sort(), [
    'computeDropTarget', 'moveChapterByDrag', 'moveChapterByDrop', 'setupChapterDrag', 'startChapterDrag'
  ]);
  for (const name of Object.keys(ui)) assert.equal(typeof ui[name], 'function', name + ' 应是函数');
});

// ---------- 落点计算 ----------

test('computeDropTarget：命中章节上半 → 插到它前面', () => {
  const { ui, list } = makeWorld();
  const c1 = chapterEl(0, 100);
  list.children = [c1];
  const target = ui.computeDropTarget(event(110));
  assert.equal(target.mode, 'before');
  assert.equal(target.volumeId, null);
  assert.equal(target.beforeChapterId, 'c1');
  assert.equal(target.el, c1);
});

test('computeDropTarget：命中章节下半 → 插到它后面（下一章同卷才算落点）', () => {
  const { ui, list } = makeWorld();
  const hood = volumeEl('v1', 380);
  const c1 = chapterEl(0, 100);
  const c2 = makeEl({ classes: ['chapter-item'], dataset: { index: '1' }, rect: { top: 140, height: 40 } });
  const c3 = makeEl({ classes: ['chapter-item'], dataset: { index: '2' }, rect: { top: 180, height: 40 } });
  list.children = [c1, c2, c3, hood];
  // c1（未分卷）下半：下一章 c2 属于第一卷，**不同卷** → 落点就是「c1 之后」的末尾，为 null
  const t1 = ui.computeDropTarget(event(130));
  assert.deepEqual([t1.mode, t1.beforeChapterId], ['after', null]);
  // c2 下半：下一章 c3 也是 v1 → c3.id
  const t2 = ui.computeDropTarget(event(170));
  assert.deepEqual([t2.mode, t2.volumeId, t2.beforeChapterId], ['after', 'v1', 'c3']);
  // 最后一条章（后面没有同卷章）：beforeChapterId 为 null
  const t3 = ui.computeDropTarget(event(210));
  assert.deepEqual([t3.mode, t3.beforeChapterId, t3.el.dataset.index], ['after', null, '2']);
});

test('computeDropTarget：命中卷标题 → 丢进这一卷（落点 = 卷内第一章）', () => {
  const { ui, list } = makeWorld();
  const hood1 = volumeEl('v1', 100);
  const c2 = chapterEl(1, 140);
  const hood2 = volumeEl('v2', 180);
  list.children = [hood1, c2, hood2];
  const t = ui.computeDropTarget(event(110));
  assert.deepEqual([t.mode, t.volumeId, t.beforeChapterId, t.el], ['header', 'v1', 'c2', hood1]);
  // 空卷（后面直接是另一个卷标题）：落点是 null
  const t2 = ui.computeDropTarget(event(190));
  assert.deepEqual([t2.mode, t2.volumeId, t2.beforeChapterId], ['header', 'v2', null]);
});

test('computeDropTarget：指针在列表末尾之后 → 落到最后一组的末尾', () => {
  const { ui, list } = makeWorld();
  const c1 = chapterEl(0, 100);
  const c2 = chapterEl(1, 140);
  list.children = [c1, c2];
  const t = ui.computeDropTarget(event(999));
  assert.deepEqual([t.mode, t.beforeChapterId, t.el], ['after', null, c2]);
  // 最后一个条是卷标题：丢进那一卷
  const hood = volumeEl('v1', 180);
  list.children = [c1, c2, hood];
  const t2 = ui.computeDropTarget(event(999));
  assert.deepEqual([t2.mode, t2.volumeId, t2.el], ['header', 'v1', hood]);
  // 空列表 / 命中非章节非卷的元素：都是 null
  list.children = [];
  assert.equal(ui.computeDropTarget(event(120)), null);
  list.children = [makeEl({ classes: ['list-empty'], rect: { top: 100, height: 40 } })];
  assert.equal(ui.computeDropTarget(event(120)), null);
});

// ---------- 键盘上下移动（Phase D / D1） ----------

test('stepMoveTarget：同卷相邻一格才给目标；跨卷交给 core 的 crossVolumeTarget（这里只算卷内），到头 / 坏参数一律 null', () => {
  const chapters = [
    { id: 'a', volumeId: null },
    { id: 'b', volumeId: null },
    { id: 'c', volumeId: 'v1' },
    { id: 'd', volumeId: 'v1' }
  ];
  const volumeOf = (chapter) => (chapter && chapter.volumeId) || null;
  assert.deepEqual(dragSort.stepMoveTarget(chapters, 0, 1, volumeOf), { kind: 'index', toIndex: 1 });
  assert.deepEqual(dragSort.stepMoveTarget(chapters, 3, -1, volumeOf), { kind: 'index', toIndex: 2 });
  assert.deepEqual(dragSort.stepMoveTarget(chapters, 1, -1, volumeOf), { kind: 'index', toIndex: 0 });
  assert.equal(dragSort.stepMoveTarget(chapters, 1, 1, volumeOf), null, '未分卷最后一条往下：换卷交给跨卷逻辑');
  assert.equal(dragSort.stepMoveTarget(chapters, 2, -1, volumeOf), null, '卷首往上：换卷交给跨卷逻辑');
  assert.equal(dragSort.stepMoveTarget(chapters, 0, -1, volumeOf), null, '全书第一条往上：到头');
  assert.equal(dragSort.stepMoveTarget(chapters, 3, 1, volumeOf), null, '全书最后一条往下：到头');
  assert.equal(dragSort.stepMoveTarget(chapters, 1, 0, volumeOf), null, 'direction 0 不动');
  assert.equal(dragSort.stepMoveTarget(chapters, 9, 1, volumeOf), null, '下标越界');
  assert.equal(dragSort.stepMoveTarget(null, 0, 1, volumeOf), null, '没有章节');
  assert.equal(dragSort.stepMoveTarget(chapters, NaN, 1, volumeOf), null, '坏下标');
  assert.deepEqual(
    dragSort.stepMoveTarget(chapters, 0, 1),
    { kind: 'index', toIndex: 1 },
    '调用方没给 volumeOf 时按同一卷处理（能走就走，不炸）'
  );
});

// ---------- 起手 / 跟手 ----------

test('startChapterDrag：只认左键，保存 / 加载 / 没开书 / 章节不足 2 章都不起手', () => {
  for (const [name, patch, btn] of [
    ['右键', {}, 2],
    ['保存中', { saving: true }, 0],
    ['加载中', { loading: true }, 0],
    ['没开书', { bookPath: '' }, 0],
    ['只有一章', { chapters: [{ id: 'c1', name: '一', volumeId: null }] }, 0]
  ]) {
    const { ui, fire, state, list, body } = makeWorld();
    Object.assign(state, patch);
    if (patch.chapters) state.chapters = patch.chapters;
    const item = chapterEl(0, 100);
    list.children = [item];
    ui.startChapterDrag(event(100, { button: btn, currentTarget: item }), 0);
    fire('pointermove', event(140));
    assert.equal(item.classList.contains('dragging'), false, name + ' 不应进入拖拽态');
    assert.equal(body.classList.contains('chapter-dragging'), false, name + ' 不应给 body 加类');
  }

  // 正常起手：同一组参数换成左键 + 正常状态就会进拖拽态（证明上面的「不动」不是假阴性）
  const { fire, state, list, body, ui } = makeWorld();
  const item = chapterEl(0, 100);
  list.children = [item, chapterEl(1, 140)];
  ui.startChapterDrag(event(100, { currentTarget: item }), 0);
  fire('pointermove', event(140));
  assert.equal(item.classList.contains('dragging'), true);
  assert.equal(body.classList.contains('chapter-dragging'), true);
  assert.equal(state.saving, false);
});

// 上面的循环里要「起手但不该生效」，直接调模块的 startChapterDrag；下面这条正例
// 证明同一套参数在正常状态下会进拖拽态（不是假阴性）。

test('updateChapterDrag：位移不到 5px 不动，过了阈值加 dragging / body 类并换落点标记', () => {
  const { ui, state, list, body, fire } = makeWorld();
  const c1 = chapterEl(0, 100);
  const c2 = chapterEl(1, 140);
  list.children = [c1, c2];
  state.chapters = [
    { id: 'c1', name: '一', volumeId: null },
    { id: 'c2', name: '二', volumeId: null }
  ];
  ui.startChapterDrag(event(100, { currentTarget: c2 }), 1);
  fire('pointermove', event(104)); // 4px：原地不动
  assert.equal(c2.classList.contains('dragging'), false);
  assert.equal(body.classList.contains('chapter-dragging'), false);
  // 旧落点标记（模拟上一帧落在 c2 前）先被清掉：这一帧的落点是 c1 前
  c2.classList.add('drop-before');
  fire('pointermove', event(110));
  assert.equal(c2.classList.contains('dragging'), true);
  assert.equal(body.classList.contains('chapter-dragging'), true);
  assert.equal(c2.classList.contains('drop-before'), false, '旧落点标记要被清掉');
  assert.equal(c1.classList.contains('drop-before'), true, '新落点标记要打上');
});

test('updateChapterDrag：卷标题落点打 drop-into；靠近顶 / 底部自动滚动', () => {
  const { ui, list, fire } = makeWorld();
  const hood = volumeEl('v1', 100);
  const c2 = chapterEl(1, 140);
  const c3 = chapterEl(2, 180);
  list.children = [hood, c2, c3];
  list.scrollTop = 50;
  ui.startChapterDrag(event(190, { currentTarget: c3 }), 1);
  fire('pointermove', event(110)); // 卷标题上
  assert.equal(hood.classList.contains('drop-into'), true);
  assert.equal(c2.classList.contains('drop-before'), false);
  // 顶部 28px 内：向上滚
  const before = list.scrollTop;
  fire('pointermove', event(105));
  assert.equal(list.scrollTop, before - 12);
  // 底部 28px 内：向下滚
  fire('pointermove', event(495));
  assert.equal(list.scrollTop, before);
});

// ---------- 收手 ----------

test('endChapterDrag：没起手 / 只是点击（未过阈值）都不发 IPC、不屏蔽点击', async () => {
  const w = makeWorld();
  await w.fire('pointerup');
  assert.equal(w.calls.length, 0);

  const w2 = makeWorld();
  const item = chapterEl(0, 100);
  w2.list.children = [item, chapterEl(1, 140)];
  w2.ui.startChapterDrag(event(100, { currentTarget: item }), 0);
  w2.fire('pointermove', event(101));
  await w2.fire('pointerup');
  assert.equal(w2.calls.length, 0);
  assert.equal(w2.state.suppressChapterClick, 0);
});

test('endChapterDrag：原地不动 / 落在自己身上都不写盘，动了才发 move-to', async () => {
  // 落回原位：第 0 章拖到自己后半 → 落点 = 下一章（等价原位）→ 不写盘
  const w = makeWorld();
  const c1 = chapterEl(0, 100);
  const c2 = chapterEl(1, 140);
  w.list.children = [c1, c2];
  w.state.chapters = [
    { id: 'c1', name: '一', volumeId: null },
    { id: 'c2', name: '二', volumeId: null }
  ];
  w.ui.startChapterDrag(event(100, { currentTarget: c1 }), 0);
  w.fire('pointermove', event(130));
  await w.fire('pointerup');
  assert.deepEqual(w.calls, []);
  assert.equal(w.state.suppressChapterClick > Date.now() - 1000, true);

  // 落在自己身上（beforeChapterId = 自己的 id）也不写盘
  const w2 = makeWorld();
  const d1 = chapterEl(0, 100);
  w2.list.children = [d1, chapterEl(1, 140)];
  w2.ui.startChapterDrag(event(100, { currentTarget: d1 }), 0);
  w2.fire('pointermove', event(105)); // 上半 → before = 自己
  await w2.fire('pointerup');
  assert.deepEqual(w2.calls, []);

  // 真的换了位置：发 IPC + 刷新 + toast
  const moved = [
    { id: 'c2', name: '二', volumeId: 'v1' },
    { id: 'c1', name: '一', volumeId: null },
    { id: 'c3', name: '三', volumeId: 'v1' }
  ];
  const w3 = makeWorld({
    onCall: (channel) => (channel === 'chapters:move-to' ? { meta: { chapters: moved, volumes: [], updatedAt: 'T1' } } : undefined)
  });
  const e1 = chapterEl(0, 100);
  const hood = volumeEl('v1', 380);
  w3.list.children = [e1, chapterEl(1, 140), hood];
  w3.state.chapters = [
    { id: 'c1', name: '一', volumeId: null },
    { id: 'c2', name: '二', volumeId: null },
    { id: 'c3', name: '三', volumeId: null }
  ];
  w3.ui.startChapterDrag(event(100, { currentTarget: e1 }), 0);
  w3.fire('pointermove', event(400)); // 落到卷标题 v1 上
  await w3.fire('pointerup');
  assert.deepEqual(w3.calls, [{ channel: 'chapters:move-to', args: ['C:\\books\\某书', 'c1', 'v1', null] }]);
  assert.deepEqual(w3.state.chapters, moved);
  assert.equal(w3.toasts[0].message, '已移动章节（第一卷）');
  assert.deepEqual([w3.renders.list, w3.renders.header, w3.renders.status], [1, 1, 1]);
});

test('moveChapterByDrop：IPC 参数、state 刷新、三条渲染、toast 文案、记住上次打开的章', async () => {
  const moved = [
    { id: 'c2', name: '二', volumeId: null },
    { id: 'c1', name: '一', volumeId: null },
    { id: 'c3', name: '三', volumeId: 'v1' }
  ];
  const w = makeWorld({
    onCall: (channel) => (channel === 'chapters:move-to' ? { meta: { chapters: moved, volumes: [], updatedAt: 'T1' } } : undefined)
  });
  w.state.index = 1; // 当前章 c2，移走后应跟到第 0 位
  const res = await w.ui.moveChapterByDrop(
    { id: 'c2', name: '二', volumeId: null },
    { volumeId: 'v1', beforeChapterId: 'c3' }
  );
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(w.calls, [
    { channel: 'chapters:move-to', args: ['C:\\books\\某书', 'c2', 'v1', 'c3'] }
  ]);
  assert.deepEqual(w.state.chapters, moved);
  assert.equal(w.state.meta.updatedAt, 'T1');
  assert.equal(w.state.index, 0);
  assert.deepEqual([w.renders.list, w.renders.header, w.renders.status], [1, 1, 1]);
  assert.deepEqual(w.toasts, [{ message: '已移动章节（第一卷）', kind: 'info' }]);
  assert.deepEqual(w.renders.lastOpen, [['C:\\books\\某书', 'c2', { title: undefined, chapterIndex: 0, chapterName: '二' }]]);
});

test('moveChapterByDrop：未分卷落点写 null，toast 写「未分卷」；当前章不在列表里时 index 不动', async () => {
  const w = makeWorld({
    onCall: () => ({ meta: { chapters: [{ id: 'c2', name: '二', volumeId: null }], volumes: [], updatedAt: 'T2' } })
  });
  w.state.index = 5;
  const res = await w.ui.moveChapterByDrop({ id: 'c1', name: '一', volumeId: null }, { volumeId: null, beforeChapterId: null });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(w.calls[0].args, ['C:\\books\\某书', 'c1', null, null]);
  assert.equal(w.state.index, 5);
  assert.equal(w.toasts[0].message, '已移动章节（未分卷）');
  // 没记住上次章（currentId 为空）也不报错、不额外 toast
  assert.deepEqual(w.renders.lastOpen, []);
  assert.equal(w.toasts.length, 1);
});

test('moveChapterByDrop：IPC 抛错只报错、不刷新、返回 ok:false', async () => {
  const w = makeWorld({ onCall: () => new Error('磁盘满') });
  const res = await w.ui.moveChapterByDrop({ id: 'c1' }, { volumeId: null, beforeChapterId: null });
  assert.deepEqual(res, { ok: false, message: '磁盘满' });
  assert.deepEqual(w.toasts, [{ message: '移动章节失败：磁盘满', kind: 'error' }]);
  assert.deepEqual([w.renders.list, w.renders.header, w.renders.status], [0, 0, 0]);
});

test('moveChapterByDrag：同下标不写盘；成功时改 state / toast / 记住当前章', async () => {
  const w = makeWorld();
  await w.ui.moveChapterByDrag(0, 0);
  assert.deepEqual(w.calls, []);

  const reordered = [
    { id: 'c3', name: '三', volumeId: 'v1' },
    { id: 'c1', name: '一', volumeId: null },
    { id: 'c2', name: '二', volumeId: 'v1' }
  ];
  const w2 = makeWorld({
    onCall: () => ({ from: 2, to: 0, meta: { chapters: reordered, updatedAt: 'T3' } })
  });
  w2.state.index = 2; // 当前章 c3
  await w2.ui.moveChapterByDrag(2, 0);
  assert.deepEqual(w2.calls, [{ channel: 'chapters:move', args: ['C:\\books\\某书', 'c3', 0] }]);
  assert.deepEqual(w2.state.chapters, reordered);
  assert.equal(w2.state.meta.updatedAt, 'T3');
  assert.equal(w2.state.meta.volumes.length, 1, 'meta 的其它字段要保留');
  assert.equal(w2.state.index, 0);
  assert.deepEqual([w2.renders.list, w2.renders.header, w2.renders.status], [1, 1, 1]);
  assert.equal(w2.toasts[0].message, '已移动章节：第3章 → 第1章（章节文件没有改名）');
  assert.deepEqual(w2.renders.lastOpen, [['C:\\books\\某书', 'c3', { title: undefined, chapterIndex: 0, chapterName: '三' }]]);
});

test('moveChapterByDrag：IPC 抛错只报错，state 不动', async () => {
  const w = makeWorld({ onCall: () => new Error('只读') });
  const before = JSON.stringify(w.state.chapters);
  await w.ui.moveChapterByDrag(2, 0);
  assert.equal(JSON.stringify(w.state.chapters), before);
  assert.deepEqual(w.toasts, [{ message: '移动章节失败：只读', kind: 'error' }]);
  assert.deepEqual([w.renders.list, w.renders.header, w.renders.status], [0, 0, 0]);
});

test('setupChapterDrag：在 window 上挂 pointermove / pointerup / pointercancel 三个监听', async () => {
  const w = makeWorld();
  assert.deepEqual([...w.listeners.keys()].sort(), ['pointercancel', 'pointermove', 'pointerup']);
  // pointermove 转发给 updateChapterDrag（没有拖拽时是空操作）
  const c1 = chapterEl(0, 100);
  w.list.children = [c1];
  w.fire('pointermove', event(200));
  assert.equal(c1.classList.contains('dragging'), false);
  // 有拖拽时走真实更新路径
  w.ui.startChapterDrag(event(100, { currentTarget: c1 }), 0);
  w.fire('pointermove', event(200));
  assert.equal(c1.classList.contains('dragging'), true);
  // pointercancel 清标记（不写盘）
  w.fire('pointercancel');
  assert.equal(c1.classList.contains('dragging'), false);
  assert.equal(w.body.classList.contains('chapter-dragging'), false);
  await w.fire('pointerup');
  assert.deepEqual(w.calls, []);
});

// ---------- 静态闸门 ----------

test('静态闸门：renderer.js 只剩接线，拖拽实现一份都不许留', () => {
  for (const shape of [
    'let chapterDrag',
    'function startChapterDrag(',
    'function clearDragMarks(',
    'function computeDropTarget(',
    'function nextChapterIdInVolume(',
    'function updateChapterDrag(',
    'function endChapterDrag(',
    'function moveChapterByDrop(',
    'function moveChapterByDrag(',
    'function setupChapterDrag('
  ]) {
    assert.equal(rendererCode.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(/chapterDrag/.test(rendererCode), false, '拖拽活状态应只在模块里');
  for (const line of [
    'const dragSortUiModule = window.CWDragSortUi;',
    'const dragSortUi = dragSortUiModule.create({',
    '    $, api, call, chapterVolumeId, renderChapterList, renderEditorHeader,',
    '    state, toast, updateStatus, volumeDisplayName',
    'const setupChapterDrag = dragSortUi.setupChapterDrag;',
    'const startChapterDrag = dragSortUi.startChapterDrag;',
    'const moveChapterByDrag = dragSortUi.moveChapterByDrag;',
    'const moveChapterByDrop = dragSortUi.moveChapterByDrop;'
  ]) {
    assert.equal(rendererCode.includes(line), true, '接线缺少：' + line);
  }
  // 两个调用点一个字没改
  assert.equal(
    rendererCode.split("item.addEventListener('pointerdown', (event) => startChapterDrag(event, index));").length - 1,
    1,
    '章节列表的 pointerdown 绑定只该有一处'
  );
  assert.equal((rendererCode.match(/^\s{4}setupChapterDrag\(\);$/gm) || []).length, 1, '事件绑定的 setupChapterDrag() 只该有一处');
  // 测试钩子的宿主契约里仍然有这三个键
  assert.equal(/^ {6}chapterVolumeId,$/m.test(rendererCode), true, 'testHooksScope 少了 chapterVolumeId');
  assert.equal(/^ {6}moveChapterByDrag,$/m.test(rendererCode), true, 'testHooksScope 少了 moveChapterByDrag');
  assert.equal(/^ {6}moveChapterByDrop,$/m.test(rendererCode), true, 'testHooksScope 少了 moveChapterByDrop');
});

test('静态闸门：index.html 顺序 + 模块不摸 Electron / fs / require + body 只在拖拽过程里摸', () => {
  const importAt = indexSrc.indexOf('<script src="import-ui.js"></script>');
  const dragAt = indexSrc.indexOf('<script src="drag-sort-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.equal(
    importAt >= 0 && dragAt > importAt && rendererAt > dragAt,
    true,
    'drag-sort-ui.js 要排 import-ui.js 之后、renderer.js 之前'
  );
  assert.equal((indexSrc.match(/drag-sort-ui\.js/g) || []).length, 1, 'index.html 只该加载一次');
  for (const banned of ['require(', 'electron', 'process.', 'fs.', 'ipcRenderer']) {
    assert.equal(moduleCode.includes(banned), false, '模块不该出现：' + banned);
  }
  assert.equal(moduleCode.split('document.body').length - 1, 2, '只有 clearDragMarks / updateChapterDrag 两处摸 body');
});

test('UMD 分支：浏览器沙箱里挂成 window.CWDragSortUi（含 create / REQUIRED_HOST）', () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(moduleSrc, sandbox);
  assert.equal(typeof sandbox.CWDragSortUi.create, 'function');
  assert.deepEqual([...sandbox.CWDragSortUi.REQUIRED_HOST], HOST_KEYS);
});
