/**
 * 超时原语。
 *
 * 为什么单独抽一层：automator 的 page 级 API（`page.data()` / `page.$()` /
 * `page.callMethod()`）在某些环境下会**永不 settle** —— 不 resolve 也不 reject。
 * 实测过一次：同一条连接上 `mp.evaluate` / `mp.screenshot` 全好，但所有 page 级调用
 * 集体卡死。这种失败方式对 AI agent 尤其致命：它会一直等下去，而不是换条路。
 *
 * try/catch 拦不住「不 settle」，只能靠外部计时。所以凡是走 automator 的调用
 * 一律经过这里，宁可报「超时」也不能挂着。
 */

export class OpTimeoutError extends Error {
  constructor (label, ms, hint) {
    super(hint ? `${label} 超时（${ms}ms）。${hint}` : `${label} 超时（${ms}ms）`)
    this.name = 'OpTimeoutError'
    this.label = label
    this.ms = ms
  }
}

/** 默认单步操作超时，可用 WX_AGENT_OP_TIMEOUT（毫秒）调整 */
export function defaultOpTimeout () {
  const raw = Number(process.env.WX_AGENT_OP_TIMEOUT)
  return Number.isFinite(raw) && raw > 0 ? raw : 30000
}

/**
 * 给一个 promise 套上超时。
 * @param {Promise|Function} work promise 或返回 promise 的函数
 * @param {{ms?:number, label?:string, hint?:string}} opts
 */
export function withTimeout (work, { ms = defaultOpTimeout(), label = '操作', hint = null } = {}) {
  const p = typeof work === 'function' ? (async () => work())() : Promise.resolve(work)
  let timer = null
  const guard = new Promise((_, reject) => {
    // 这个定时器**不能** unref：被它守着的 promise 可能永远不 settle，
    // 一旦 unref，事件循环没别的事情时就直接空转结束，超时永远不会触发 ——
    // 那这层保护就等于没有。它在 finally 里必定被 clear，不会拖住进程。
    timer = setTimeout(() => reject(new OpTimeoutError(label, ms, hint)), ms)
  })
  return Promise.race([p, guard]).finally(() => {
    clearTimeout(timer)
    // 输的那个 promise 之后可能才 reject；不接住会变成 unhandledRejection 把进程带崩。
    // daemon 是常驻进程，这一条尤其不能省。
    p.catch(() => {})
  })
}

/** 是否是超时错误（调用方据此决定要不要提示降级通路） */
export function isTimeout (err) {
  return err instanceof OpTimeoutError || err?.name === 'OpTimeoutError'
}
