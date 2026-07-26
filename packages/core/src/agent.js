import path from 'node:path'
import { detectProject, summarize } from './project.js'
import { DevTools } from './devtools.js'
import { createCompiler } from './compile.js'
import { Session } from './session.js'
import { UI } from './ui.js'
import { Capture } from './capture.js'
import { SourceMapper } from './sourcemap.js'
import { LogCollector } from './logs.js'
import { Perf } from './perf.js'
import { analyzeSize } from './size.js'
import { ARTIFACT_ROOT, DEFAULT_MAX_BYTES, stats as artifactStats, sweep as sweepArtifacts } from './artifacts.js'

/**
 * 高层门面：把"探测工程 → 编译 → 在开发者工具里打开 → 连上去 → 驱动/观察"串成一条线。
 * CLI 和 MCP 都只跟它打交道。
 */
export class WxAgent {
  constructor (info, { port = 9420, cliPath = null, outDir = null, maxArtifactBytes = DEFAULT_MAX_BYTES } = {}) {
    this.info = info
    this.port = port
    this.maxArtifactBytes = maxArtifactBytes
    this.devtools = new DevTools(cliPath ? { cliPath } : {})
    this.compiler = createCompiler(info)
    this.logs = new LogCollector()
    this.mapper = new SourceMapper(info.sourcemapDir, info.root)
    this.outDir = outDir
    /** @type {Session|null} */
    this.session = null
    /** @type {UI|null} */
    this.ui = null
    /** @type {Capture|null} */
    this.capture = null
  }

  /** @param {string} dir 任意路径，内部会向下找到真正的小程序工程 */
  static create (dir, opts = {}) {
    return new WxAgent(detectProject(dir), opts)
  }

  get summary () {
    return summarize(this.info)
  }

  /**
   * 一步到位：编译 → 打开 → 连接。
   * @param {{rebuild?:boolean, watch?:boolean, open?:boolean, onOutput?:Function}} opts
   */
  /**
   * 一步到位：编译 → 打开 → 连接。**幂等** —— 反复调用不会重复开窗口。
   *
   * 已经开着目标项目时什么都不做，直接复用现有窗口和连接。只有在
   * 「端口不通」或「开着的是别的小程序」时才真正去动开发者工具。
   *
   * @param {{rebuild?:boolean, watch?:boolean, open?:boolean, forceOpen?:boolean, onOutput?:Function}} opts
   */
  async run ({ rebuild = false, watch = false, open = true, forceOpen = false, onOutput = null } = {}) {
    const steps = []

    // 1) 编译
    const build = rebuild
      ? await this.compiler.build({ watch, onOutput })
      : await this.compiler.ensureBuilt({ watch, onOutput })
    steps.push({ step: 'compile', ...build })
    if (!build.ok) return { ok: false, steps, message: build.message }

    // 2) 在开发者工具里打开产物目录，并开自动化端口
    if (open) {
      let opened = await this.devtools.openWithAutomation(this.info.distDir, this.port, {
        forceRestart: forceOpen
      })
      await this.connect()

      // 复用的窗口未必开着本工程，连上去比对一下；不是才真正切换
      if (opened.reused && !forceOpen && !(await this.isTargetProject())) {
        await this.close({ stopCompiler: false })
        opened = await this.devtools.openWithAutomation(this.info.distDir, this.port, {
          reuseIfLive: false
        })
        opened.switched = true
      }
      steps.push({
        step: 'open',
        ok: true,
        port: opened.port,
        project: this.info.distDir,
        reused: Boolean(opened.reused && !opened.switched),
        switched: Boolean(opened.switched)
      })
    }

    // 3) 连上去（上面可能已经连过，connect 自身幂等）
    await this.connect()
    steps.push({ step: 'connect', ok: true, port: this.port })

    const page = await this.session.page()
    return { ok: true, steps, page: page.path, project: this.info.distDir }
  }

  /** 当前开发者工具里跑着的小程序 appid；拿不到返回 null */
  async currentAppId () {
    try {
      return await this.ui.evaluate(
        "return (typeof wx !== 'undefined' && wx.getAccountInfoSync) ? wx.getAccountInfoSync().miniProgram.appId : null"
      )
    } catch {
      return null
    }
  }

  /**
   * 开发者工具里开着的是不是本工程。
   * 判断不了时一律返回 true —— 宁可复用一个可能不对的窗口，也不要贸然关掉用户正开着的东西。
   */
  async isTargetProject () {
    if (!this.info.appid || this.info.appid === 'touristappid') return true
    const appid = await this.currentAppId()
    if (!appid) return true
    return appid === this.info.appid
  }

  /** 只连接（假设开发者工具已经开着目标项目） */
  async connect () {
    if (this.session) return this.session
    this.session = await Session.connect({ port: this.port, logs: this.logs })
    this.ui = new UI(this.session)
    this.capture = new Capture(this.session, {
      outDir: this.outDir,
      projectRoot: this.info.root,
      maxBytes: this.maxArtifactBytes
    })
    this.perf = new Perf(this.ui)
    return this.session
  }

  /** 包体积分析（不需要连接，只看编译产物） */
  analyzeSize () {
    return analyzeSize(this.info.distDir)
  }

  /** 截图等产物的占用情况（不需要连接） */
  artifactStats () {
    return { ...artifactStats(ARTIFACT_ROOT), maxBytes: this.maxArtifactBytes }
  }

  /** 回收产物；force=true 清空全部（不需要连接） */
  sweepArtifacts ({ force = false } = {}) {
    return sweepArtifacts({ root: ARTIFACT_ROOT, maxBytes: this.maxArtifactBytes, force })
  }

  /**
   * 丢掉当前会话，下次 connect 会重新建立。
   * 开发者工具重启或切换项目后，旧连接会变成死的（"Connection closed"），必须重建。
   * 注意日志缓冲（this.logs）是有意保留的——重连不该让之前收集的日志消失。
   */
  resetSession () {
    this.session = null
    this.ui = null
    this.capture = null
    this.perf = null
  }

  /** 判断一个错误是不是"连接已死"，需要重连后重试 */
  static isConnectionError (err) {
    return /Connection closed|not connected|WebSocket|ECONNRESET|ECONNREFUSED|socket hang up/i.test(
      String(err?.message ?? err)
    )
  }

  assertConnected () {
    if (!this.session) throw new Error('尚未连接小程序。先跑 `wxctl run`，或对已打开的项目跑 `wxctl connect`。')
  }

  async screenshot (opts) {
    this.assertConnected()
    return this.capture.screenshot(opts)
  }

  async snapshot (opts) {
    this.assertConnected()
    return this.ui.snapshot(opts)
  }

  /**
   * 取错误，并把堆栈映射回源码。
   * 这是本工具链相对"自己翻控制台"的核心增量。
   */
  async errors ({ limit = 10, since = null } = {}) {
    const raw = this.logs.errors.filter((e) => (since ? e.ts >= since : true)).slice(-limit)
    const out = []
    for (const e of raw) {
      const mapped = e.stack && this.mapper.available ? await this.mapper.mapStack(e.stack) : null
      out.push({
        ts: e.ts,
        level: e.level,
        source: e.source,
        message: e.text,
        origin: mapped?.best?.mapped
          ? {
              file: mapped.best.mapped.source,
              line: mapped.best.mapped.line,
              column: mapped.best.mapped.column,
              snippet: mapped.best.mapped.snippet
            }
          : null,
        stack: mapped?.text ?? e.stack ?? null
      })
    }
    return out
  }

  /** 渲染错误为给人看的文本 */
  static renderErrors (errors) {
    if (!errors.length) return '（没有错误）'
    return errors
      .map((e, i) => {
        const head = `[${i + 1}] ${e.level} · ${e.message}`
        if (!e.origin) return `${head}\n    （无 sourcemap，无法定位到源码）`
        const loc = `    → ${e.origin.file}:${e.origin.line}:${e.origin.column}`
        return [head, loc, e.origin.snippet ? indent(e.origin.snippet, 4) : null].filter(Boolean).join('\n')
      })
      .join('\n\n')
  }

  /** 改完源码后：等重编译 → 重新注入钩子 → 截图确认 */
  async reload ({ timeout = 60000 } = {}) {
    if (typeof this.compiler.waitForRebuild === 'function') {
      await this.compiler.waitForRebuild({ timeout })
    }
    if (this.session) await this.session.refreshHooks()
    return { ok: true }
  }

  async close ({ stopCompiler = true } = {}) {
    if (this.session) await this.session.disconnect()
    this.resetSession()
    if (stopCompiler) this.compiler.stop()
  }

  /** 运行产物目录（给开发者工具打开的那个） */
  get projectDir () {
    return this.info.distDir
  }

  /** 源码目录 */
  get sourceDir () {
    return this.info.srcDir
  }

  /** 把产物内相对路径转成源码内相对路径的提示（供报错信息里指路） */
  hintSourceFor (distRel) {
    return path.join(path.relative(this.info.root, this.info.srcDir) || '.', distRel)
  }
}

function indent (text, n) {
  const pad = ' '.repeat(n)
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n')
}
