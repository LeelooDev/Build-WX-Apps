import automator from 'miniprogram-automator'
import { LogCollector } from './logs.js'
import { portListening } from './devtools.js'

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

  /** 当前页面 */
  async page () {
    return this.mp.currentPage()
  }

  /** 页面栈路径列表 */
  async pageStack () {
    const stack = await this.mp.pageStack()
    return stack.map((p) => p.path)
  }

  async systemInfo () {
    return this.mp.systemInfo()
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
