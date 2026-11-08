// 自绘标题栏（1.3.0 T6 / 规范 I-07）的唯一事实源。
//
// 为什么要单独一个文件：窗口配置在 main.js（主进程），主题色在 renderer/styles.css（渲染层），
// 两边以前只有 backgroundColor 一个写死的 #f6f4ef 兜着。1.3.0 起窗口用
// titleBarStyle:'hidden' + titleBarOverlay，系统的最小化 / 最大化 / 关闭按钮由 Windows 画在
// 网页内容上面，它们的底色（color）和字形色（symbolColor）必须跟着 6 套纸色走——这份表就是
// 「主题 → 窗口控件色」的唯一一份。tests/window-chrome.test.js 用 styles.css 里的主题值逐条钉住
// （纸色 = --paper、字形 = --ink-soft、失焦字形 = --ink-faint、失焦纸色 = 纸色 ×0.98），
// 改一边不改另一边立即红。
//
// 边界：纯数据 + 纯函数，不 require electron、不读文件、不碰书库 / 配置；main.js 只拿它算颜色、
// 判断「这次右键是不是落在标题栏拖拽区」、拼窗口菜单模板。
//
// 红线：不发版 / 不打包 / 不升版本号；只改窗口外观（titleBarStyle / 标题栏配色 / 右键菜单），
// 不改 IPC 语义、不改数据格式、不改保存语义、不引入 Mica / 亚克力（半透明破坏纸感）。

// 标题栏高度（像素）。规范 I-07 给的是「34–58px 区」；取 40 = 书架顶栏 62px / 写作页顶栏 58px
// 里的一条，不新增横栏、不重排内容。Electron 的 titleBarOverlay.height 也用它，
// 这样系统按钮区和网页里留出来的 env(titlebar-area-height) 是同一个数。
const TITLEBAR_HEIGHT = 40;

// 拖拽区高度：与标题栏同高。网页里 -webkit-app-region: drag 铺在现有顶栏上，
// 这里只用于「右键落在标题栏 → 出窗口菜单」的命中判断（顶栏上沿这一条）。
const DRAG_ZONE_HEIGHT = TITLEBAR_HEIGHT;

// 6 套背景主题（与 renderer/styles.css 的 body.theme-* 一一对应；paper 是默认，没有 body 类）。
//   paper            = 顶栏 / 窗口底色（--paper）
//   paperInactive    = 窗口失焦时纸色 -2%（= 每个通道 ×0.98 四舍五入；夜间因 8 位色阶几乎不变）
//   symbol           = 系统按钮字形色（--ink-soft，纸色上 ≥6:1，过界面图形 3:1 有余）
//   symbolInactive   = 失焦时字形色（--ink-faint，纸色上 ≥4.4:1）
const THEMES = Object.freeze({
  paper: Object.freeze({ paper: '#f4f1ea', paperInactive: '#efece5', symbol: '#575146', symbolInactive: '#6d6659' }),
  cream: Object.freeze({ paper: '#f6efe0', paperInactive: '#f1eadc', symbol: '#575146', symbolInactive: '#6d6659' }),
  green: Object.freeze({ paper: '#edf0e7', paperInactive: '#e8ebe2', symbol: '#4f5747', symbolInactive: '#666e5b' }),
  kraft: Object.freeze({ paper: '#e7d9c1', paperInactive: '#e2d5bd', symbol: '#54462f', symbolInactive: '#6b5c42' }),
  grid: Object.freeze({ paper: '#f1f1ec', paperInactive: '#ecece7', symbol: '#54564e', symbolInactive: '#6b6d63' }),
  night: Object.freeze({ paper: '#17181a', paperInactive: '#171819', symbol: '#c2bcaf', symbolInactive: '#9a9486' })
});

const THEME_NAMES = Object.freeze(Object.keys(THEMES));
const DEFAULT_THEME = 'paper';

// 主题名不认识（旧配置写坏 / 以后加主题但这里没跟上）一律回落默认纸色，不抛错。
function themeOf(name) {
  const key = typeof name === 'string' ? name.trim() : '';
  return Object.prototype.hasOwnProperty.call(THEMES, key) ? THEMES[key] : THEMES[DEFAULT_THEME];
}

function themeNameOf(name) {
  const key = typeof name === 'string' ? name.trim() : '';
  return Object.prototype.hasOwnProperty.call(THEMES, key) ? key : DEFAULT_THEME;
}

// 窗口控件区配色（Electron BrowserWindow 的 titleBarOverlay / win.setTitleBarOverlay 入参）。
// 失焦态只是纸色暗 2% + 字形淡一档：不做 Mica / 亚克力，也不用半透明。
function overlayFor(name, options) {
  const theme = themeOf(name);
  const inactive = Boolean(options && options.inactive);
  return {
    color: inactive ? theme.paperInactive : theme.paper,
    symbolColor: inactive ? theme.symbolInactive : theme.symbol,
    height: TITLEBAR_HEIGHT
  };
}

// 窗口底色（BrowserWindow 的 backgroundColor）：主题纸色，避免夜间主题启动时先闪一下浅色。
function backgroundFor(name) {
  return themeOf(name).paper;
}

// 主进程 webContents 的 'context-menu' 事件里，判断这次右键是不是落在标题栏拖拽区。
// 只看坐标与「是不是可编辑 / 有没有选中文字」——Chromium 的 context-menu 参数不带 DOM 元素，
// 拿不到「这一下点的是哪个元素」，所以顶栏按钮上的右键也会出窗口菜单（原生标题栏时代那里
// 本来就没有菜单，多一个窗口菜单是无害的；输入框仍走文字菜单，优先判断）。
function isTitleBarHit(params) {
  if (!params || typeof params !== 'object') return false;
  if (params.isEditable === true) return false;
  if (typeof params.selectionText === 'string' && params.selectionText.trim()) return false;
  const y = Number(params.y);
  const x = Number(params.x);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= 0 && y >= 0 && y <= DRAG_ZONE_HEIGHT;
}

// 标题栏右键菜单模板（纯数据 + 外部传进来的动作，方便单测）。
// 原生标题栏的系统菜单里还有「移动 / 大小」（要走 Windows 的模态循环，Electron 没暴露），
// 这两项继续用 Windows 自带的 Alt+Space 系统菜单；这里给最常用的四项。
function menuTemplate(actions) {
  const a = actions && typeof actions === 'object' ? actions : {};
  const maximized = a.maximized === true;
  const can = (fn) => typeof fn === 'function';
  return [
    { label: '还原', enabled: maximized && can(a.restore), click: a.restore },
    { label: '最小化', enabled: can(a.minimize), click: a.minimize },
    { label: '最大化', enabled: !maximized && can(a.maximize), click: a.maximize },
    { type: 'separator' },
    { label: '关闭', enabled: can(a.close), click: a.close }
  ];
}

module.exports = {
  TITLEBAR_HEIGHT,
  DRAG_ZONE_HEIGHT,
  THEMES,
  THEME_NAMES,
  DEFAULT_THEME,
  themeNameOf,
  overlayFor,
  backgroundFor,
  isTitleBarHit,
  menuTemplate
};
