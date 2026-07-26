import automator from 'miniprogram-automator'
import { LogCollector } from './logs.js'
import { portListening } from './devtools.js'
import { withTimeout } from './timeout.js'

/**
 * 与运行中的小程序的一次会话。
 *
 * 一律用 connect 而不是 launch：connect 是连**你已经开着的那个**开发者工具实例，
 * 所以你手点、AI 点，操作的是同一个窗口、同一份状态，人机可以共存。
 * launch 会另起一个实例，人看到的和 AI 操作的就不是一个东西了。
 */
export class Session {
  constructor (mp, { port, logs }) {
    this.mp = mp
    this.port = port
    this.logs = logs
    this.connectedAt = Date.now()
  }

  /**
   * @param {{port?:number, capacity?:number, logs?:LogCollector}} opts
   * @returns {Promise<Session>}
   */
  static async connect ({ port = 9420, capacity = 3000, logs = null } = {}) {
    if (!(await portListening(port))) {
      throw new Error(
        `自动化端口 ${port} 没有监听。先跑 \`wxctl run\`（或 \`wxctl open\`）把项目在开发者工具里打开，` +
          '并确认 设置 → 安全设置 → 服务端口(CLI/HTTP 调用) 已开启。'
      )
    }
    const mp = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${port}` })
    const collector = logs ?? new LogCollector({ capacity })
    await collector.attach(mp)
    return new Session(mp, { port, logs: collector })
  }

  /**
   * 运行时是否真的活着。
   *
   * 为什么需要单独探这一下：**自动化端口能连上，不代表小程序在跑**。
   * 开发者工具冷启动时会出现「IDE server 没起来 → 模拟器启动超时」，
   * 而端口照常 listen —— `automator.connect()` 几毫秒就成功，
   * 但之后每一个调用都无限挂起。不探活的话，这种状态只会表现为
   * 「daemon 响应超时」，把人引向完全错误的方向（以为是 daemon 的问题）。
   *
   * 用 `evaluate` 而不是 `currentPage()`：evaluate 直达 appservice，
   * 是最短、最不依赖渲染层的一条链路。
   *
   * 注意 automator 的 evaluate 取参数的 `.toString()` 当**函数声明**发过去，
   * 传裸的 `'return 1'` 会在小程序侧构造函数失败 —— 那是「探针自己坏了」，
   * 不是「运行时死了」，两者必须区分开，否则这层保护会到处误报。
   *
   * @returns {Promise<{alive:boolean, ms:number, value?:any, error?:string}>}
   */
  async probeRuntime ({ timeout = 10000 } = {}) {
    const t0 = Date.now()
    try {
      const value = await withTimeout(() => this.mp.evaluate(() => 1), {
        ms: timeout,
        label: '运行时探活'
      })
      return { alive: true, ms: Date.now() - t0, value }
    } catch (err) {
      return { alive: false, ms: Date.now() - t0, error: err?.message ?? String(err) }
    }
  }

  /** 当前页面 */
  async page () {
    return withTimeout(() => this.mp.currentPage(), { label: 'currentPage()' })
  }

  /** 页面栈路径列表 */
  async pageStack () {
    const stack = await withTimeout(() => this.mp.pageStack(), { label: 'pageStack()' })
    return stack.map((p) => p.path)
  }

  async systemInfo () {
    return withTimeout(() => this.mp.systemInfo(), { label: 'systemInfo()' })
  }

  /**
   * 小程序重新编译刷新后，之前注入的 wx.onError 钩子会丢，
   * 重新注入一次（幂等）。
   */
  async refreshHooks () {
    await this.logs.inject(this.mp)
  }

  async disconnect () {
    try {
      await this.mp.disconnect()
    } catch {
      /* 已断开就算了 */
    }
  }
}
