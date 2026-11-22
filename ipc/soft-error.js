/* 软错误包络的唯一约定（三审 I7 / 低）。
 *
 * 背景：main.js 的 fail() 只覆盖「抛错」的失败；另有一批频道在**成功回包**里用业务字段表达
 * 「这次没做成」—— handle() 会把返回的 data 包成 { ok:true, data }，作者看到的提示与重试语义
 * 全靠 data 里的形状。收编前同族三种形态并存：
 *   · crash:draft            → { saved:false, code }
 *   · crash:read-draft       → { draft:null, code }
 *   · crash:discard-draft    → { removed:0, code }（早退分支连 ok 都没有）
 *   · proofread:wordlists-*  → { added:false | removed:false, code }
 *   · text/book:sensitive-check → { ok:false, code, message }
 *   · capture:queue-remove   → { removed:false }（坏 id 时连 code 都没有）
 * 渲染层各自按自己的形状消费，新增频道时没有单一约定可循 —— 这正是本批要消除的口径分叉。
 *
 * 现在的约定（软错误包络）：
 *   · **失败一定是 { ok:false, code, message }**（code 与 fail() 同族，界面按 code 分支；
 *     message 必须是中文、绝不含本机绝对路径）；
 *   · 既有判别字段（saved / draft / added / removed / canceled …）作为附加字段保留，成功回包
 *     的形状一个字节都不变 —— 旧调用方与旧渲染层不受影响；
 *   · 新增软错误频道必须写进下面的 SOFT_ERROR_CHANNELS 清单，tests/soft-error-envelope.test.js
 *     会逐条核对「注册点里真的在用 softFailure、旧形态没有回潮」。
 *
 * 纯数据 / 纯函数：不 require electron、不读盘、不抛错。
 */
const SOFT_ERROR_FIELDS = Object.freeze(['ok', 'code', 'message']);

// 软错误频道清单（机器清单）：频道名 → 注册它的文件。新增一个软错误频道就加一行，
// 否则测试里的「注册点必须用 softFailure」不会被覆盖到。
const SOFT_ERROR_CHANNELS = Object.freeze({
  'crash:draft': 'main.js',
  'crash:read-draft': 'main.js',
  'crash:discard-draft': 'main.js',
  'capture:queue-remove': 'main.js',
  'proofread:wordlists-add': 'ipc/proofread.js',
  'proofread:wordlists-remove': 'ipc/proofread.js',
  'text:sensitive-check': 'ipc/proofread.js',
  'book:sensitive-check': 'ipc/proofread.js'
});

// 构造一份软错误：{ ok:false, code, message } + 附加字段（既有判别字段 / 最新词表信息）。
// extra 里同名的 ok / code / message 一律被忽略 —— 包络的三个字段只能由这里给，避免调用方
// 在附加字段里又塞一个形状不同的 ok。
function softFailure(code, message, extra) {
  const payload = { ok: false, code: String(code), message: String(message) };
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const key of Object.keys(extra)) {
      if (SOFT_ERROR_FIELDS.includes(key)) continue;
      payload[key] = extra[key];
    }
  }
  return payload;
}

module.exports = { SOFT_ERROR_FIELDS, SOFT_ERROR_CHANNELS, softFailure };
