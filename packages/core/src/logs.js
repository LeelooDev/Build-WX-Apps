/**
 * 运行时日志与异常采集。
 *
 * 小程序的运行时信息散在三个地方，缺一路都会漏：
 *   1. `miniProgram.on('console')`   —— console.log/warn/error
 *   2. `miniProgram.on('exception')` —— 同步异常（注意：必须等事件回传，立刻 disconnect 会丢）
 *   3. 注入 `wx.onError` / `wx.onUnhandledRejection` —— 前两路拿不到的完整堆栈和异步 Promise 异常
 *
 * 第 3 路是关键：只有它能拿到带产物文件名+行号的完整堆栈，
 * 那正是 sourcemap 反查回 .vue 源码所需要的输入。
 */

const ERROR_LEVELS = new Set(['error', 'exception', 'unhandledRejection'])

export class LogCollector {
  /** @param {{capacity?: number}} opts 环形缓冲容量，超出丢最旧的 */
  constructor ({ capacity = 3000 } = {}) {
    this.capacity = capacity
    /** @type {Array<Object>} */
    this.entries = []
    this.seq = 0
    this._attached = null
  }

  push (entry) {
    const e = { seq: ++this.seq, ts: Date.now(), ...entry }
    this.entries.push(e)
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity)
    }
    return e
  }

  /**
   * 挂到一个 miniProgram 实例上。
   * @param {import('miniprogram-automator').MiniProgram} mp
   */
  async attach (mp) {
    if (this._attached === mp) return
    this._attached = mp

    mp.on('console', (msg) => {
      this.push({
        level: normalizeLevel(msg.type),
        source: 'console',
        text: formatArgs(msg.args),
        args: msg.args
      })
    })

    mp.on('exception', (err) => {
      this.push({
        level: 'exception',
        source: 'automator',
        text: err?.message ?? String(err),
        stack: err?.stack ?? null
      })
    })

    await this.inject(mp)
  }

  /**
   * 注入 wx.onError / wx.onUnhandledRejection 主动上报。
   * 小程序重新编译刷新后注入会失效，需要再调一次。
   */
  async inject (mp) {
    try {
      await mp.exposeFunction('__wxAgentReport', (payload) => {
        try {
          const p = JSON.parse(payload)
          this.push({
            level: p.kind === 'unhandledRejection' ? 'unhandledRejection' : 'error',
            source: 'wx.onError',
            text: p.message,
            stack: p.stack ?? null
          })
        } catch {
          this.push({ level: 'error', source: 'wx.onError', text: String(payload) })
        }
      })
    } catch (err) {
      // 重复 expose 同名函数会抛错，重连场景下属正常，忽略
      if (!/already|exist/i.test(String(err?.message))) throw err
    }

    await mp.evaluate(() => {
      // 幂等：小程序侧重复注册监听会重复上报
      if (globalThis.__wxAgentHooked) return
      globalThis.__wxAgentHooked = true

      const report = (kind, message, stack) => {
        try {
          // eslint-disable-next-line no-undef
          __wxAgentReport(JSON.stringify({ kind, message, stack }))
        } catch (_) {}
      }

      if (typeof wx !== 'undefined' && wx.onError) {
        wx.onError((err) => {
          const message = typeof err === 'string' ? err : (err && err.message) || String(err)
          const stack = (err && err.stack) || (typeof err === 'string' ? err : '')
          report('onError', message, stack)
        })
      }
      if (typeof wx !== 'undefined' && wx.onUnhandledRejection) {
        wx.onUnhandledRejection((res) => {
          const reason = res && res.reason
          const message = reason && reason.message ? reason.message : String(reason)
          report('unhandledRejection', message, (reason && reason.stack) || '')
        })
      }
    })
  }

  /**
   * 查询日志。
   * @param {{level?:string, since?:number, keyword?:string, limit?:number, errorsOnly?:boolean}} q
   */
  query ({ level, since, keyword, limit = 100, errorsOnly = false } = {}) {
    let out = this.entries
    if (since) out = out.filter((e) => e.ts >= since)
    if (errorsOnly) out = out.filter((e) => ERROR_LEVELS.has(e.level))
    else if (level) out = out.filter((e) => e.level === level)
    if (keyword) {
      const k = keyword.toLowerCase()
      out = out.filter((e) => (e.text ?? '').toLowerCase().includes(k))
    }
    return out.slice(-limit)
  }

  /** 所有带堆栈的错误（sourcemap 映射的输入） */
  get errors () {
    return this.entries.filter((e) => ERROR_LEVELS.has(e.level))
  }

  clear () {
    this.entries = []
  }

  /** 渲染成紧凑文本 */
  render (list = this.query()) {
    if (!list.length) return '（无日志）'
    return list
      .map((e) => {
        const t = new Date(e.ts).toTimeString().slice(0, 8)
        const tag = e.level.toUpperCase().padEnd(5)
        return `${t} ${tag} ${e.text}`
      })
      .join('\n')
  }
}

function normalizeLevel (type) {
  const t = String(type ?? 'log').toLowerCase()
  if (t === 'warning') return 'warn'
  return ['log', 'info', 'warn', 'error', 'debug'].includes(t) ? t : 'log'
}

/** console 的 args 数组拍成一行文本 */
function formatArgs (args) {
  if (!Array.isArray(args)) return String(args ?? '')
  return args
    .map((a) => {
      if (a == null) return String(a)
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}
