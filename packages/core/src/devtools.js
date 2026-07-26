import { execFile } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import { promisify } from 'node:util'
import { exists, sleep, waitUntil } from './util.js'

const execFileAsync = promisify(execFile)

const DEFAULT_CLI_PATHS = {
  darwin: ['/Applications/wechatwebdevtools.app/Contents/MacOS/cli'],
  win32: [
    'C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat',
    'C:/Program Files/Tencent/微信web开发者工具/cli.bat'
  ],
  linux: []
}

/** 某个本地端口是否已被监听 */
export function portListening (port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    const done = (v) => {
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(800)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

/**
 * 微信开发者工具的命令行控制。
 *
 * 前置条件（装不上就没法用，doctor 会检查）：
 * 开发者工具 → 设置 → 安全设置 → **服务端口（CLI/HTTP 调用）** 必须打开。
 */
export class DevTools {
  constructor ({ cliPath = DevTools.findCli() } = {}) {
    this.cliPath = cliPath
  }

  /** 找开发者工具 cli 可执行文件 */
  static findCli () {
    const candidates = DEFAULT_CLI_PATHS[os.platform()] ?? []
    return candidates.find((p) => exists(p)) ?? null
  }

  get available () {
    return Boolean(this.cliPath && exists(this.cliPath))
  }

  assertAvailable () {
    if (!this.available) {
      throw new Error(
        '找不到微信开发者工具 cli。macOS 默认在 /Applications/wechatwebdevtools.app/Contents/MacOS/cli；' +
          '若装在别处，用 --cli-path 指定。'
      )
    }
  }

  /** 跑一条 cli 子命令 */
  async run (args, { timeout = 180000 } = {}) {
    this.assertAvailable()
    try {
      const { stdout, stderr } = await execFileAsync(this.cliPath, args, {
        timeout,
        maxBuffer: 16 * 1024 * 1024
      })
      return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' }
    } catch (err) {
      return {
        ok: false,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? String(err.message ?? err),
        error: err
      }
    }
  }

  /** 开发者工具是否已登录（未登录时几乎所有命令都会失败） */
  async isLogin () {
    const r = await this.run(['islogin'], { timeout: 30000 })
    if (/"login"\s*:\s*true/.test(r.stdout)) return true
    if (r.ok && /islogin/.test(r.stdout)) return true
    return false
  }

  /**
   * 打开项目并启用自动化端口。
   *
   * 三个实测出来的坑，顺序不能乱：
   * 1. IDE 进程没在跑时直接 `cli auto`，可能撞上残留的端口记录（"IDE may already started at
   *    port 44425, trying to connect" → 超时失败）。所以先把 GUI 拉起来。
   * 2. `cli auto` 返回成功之后，自动化端口还要几秒才真正 listen。立刻判定"没起来"会误判。
   * 3. IDE 已经开着**别的**项目时，对新项目 auto 确实不会重新绑定端口 —— 这时才需要 quit 重来。
   *
   * @param {string} projectPath 要打开的目录（uni-app 传编译产物目录，不是源码目录）
   * @param {number} port 自动化端口
   */
  async openWithAutomation (projectPath, port = 9420, { forceRestart = false, reuseIfLive = true } = {}) {
    this.assertAvailable()

    // 端口已经活着就直接复用 —— 不要每次都去 `cli auto`，更不要动不动 quit 重开。
    // 用户已经开好的窗口被反复关掉重开是非常糟糕的体验。
    // 「开着的是不是目标项目」由上层（WxAgent.run）连上去比对 appid 后决定。
    if (!forceRestart && reuseIfLive && (await portListening(port))) {
      return { port, reused: true, output: '自动化端口已在监听，复用现有窗口' }
    }

    if (forceRestart && (await this.isRunning())) {
      await this.quit()
      await sleep(3000)
    }
    if (!(await this.isRunning())) {
      await this.launchGui()
    }

    const tryOnce = async () => {
      const r = await this.run(['auto', '--project', projectPath, '--auto-port', String(port)])
      try {
        // 关键：给端口留出真正 listen 的时间，别一探不通就下结论
        await waitUntil(() => portListening(port), {
          timeout: 25000,
          interval: 1000,
          label: `自动化端口 ${port}`
        })
        return { up: true, r }
      } catch {
        return { up: false, r }
      }
    }

    let { up, r } = await tryOnce()

    if (!up) {
      // 走到这儿基本就是坑 3：IDE 开着别的项目，端口绑在那个上面
      await this.quit()
      await sleep(3000)
      await this.launchGui()
      ;({ up, r } = await tryOnce())
    }

    if (!up) {
      throw new Error(
        `自动化端口 ${port} 没起来。请确认：开发者工具 → 设置 → 安全设置 → 服务端口(CLI/HTTP 调用) 已开启。\n` +
          `cli 输出：\n${r.stdout}\n${r.stderr}`
      )
    }
    return { port, output: r.stdout }
  }

  /** 开发者工具应用包路径（从 cli 路径反推） */
  get appPath () {
    if (!this.cliPath) return null
    const m = this.cliPath.match(/^(.*\.app)\//)
    return m ? m[1] : null
  }

  /** 拉起 GUI 并等到进程就绪 */
  async launchGui ({ timeout = 90000 } = {}) {
    if (process.platform === 'darwin' && this.appPath) {
      await execFileAsync('open', ['-a', this.appPath]).catch(() => {})
    } else {
      // 其他平台交给 cli 自己拉起（它在 IDE 没运行时会启动）
      await this.run(['islogin'], { timeout: 30000 }).catch(() => {})
    }
    await waitUntil(() => this.isRunning(), {
      timeout,
      interval: 1500,
      label: '微信开发者工具启动'
    })
    // 进程起来到能接命令还有一小段，别急
    await sleep(3000)
  }

  /** 进程是否在跑（比 islogin 快且不受登录态影响） */
  async isRunning () {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execFileAsync('tasklist', [], { timeout: 10000 })
        return /wechatwebdevtools/i.test(stdout)
      }
      await execFileAsync('pgrep', ['-f', 'wechatwebdevtools'], { timeout: 10000 })
      return true
    } catch {
      return false
    }
  }

  async close (projectPath) {
    return this.run(['close', '--project', projectPath], { timeout: 60000 })
  }

  async quit () {
    return this.run(['quit'], { timeout: 60000 })
  }

  /** 生成预览二维码（真机扫码看效果） */
  async preview (projectPath, { qrOutput = null, compileCondition = null } = {}) {
    const args = ['preview', '--project', projectPath]
    if (qrOutput) args.push('--qr-output', qrOutput, '--qr-format', 'image')
    if (compileCondition) args.push('--compile-condition', JSON.stringify(compileCondition))
    return this.run(args, { timeout: 300000 })
  }

  /** 上传体验版 */
  async upload (projectPath, { version, desc = '' } = {}) {
    if (!version) throw new Error('upload 必须指定 version')
    return this.run(
      ['upload', '--project', projectPath, '--upload-version', version, '--upload-desc', desc],
      { timeout: 600000 }
    )
  }

  /** 构建 npm（小程序里用了 npm 包时需要） */
  async buildNpm (projectPath) {
    return this.run(['build-npm', '--project', projectPath], { timeout: 300000 })
  }
}
