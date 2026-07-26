import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { exists, waitUntil } from './util.js'
import { spawnSpec } from './platform.js'

/** 编译成功/失败的输出特征（uni-app 用的是 vue-cli，Taro 用 webpack，特征通用） */
const DONE_RE = /Build complete|Compiled successfully|编译成功|build finished/i
const FAIL_RE = /Failed to compile|Build failed|ERROR\s+in\s/i

/**
 * 编译层。不同工程形态差异极大，所以做成可插拔 provider：
 *   native            原生小程序，不需要编译
 *   uni-cli           uni-app CLI（含被 wxctl init 补过的 HBuilderX 工程）
 *   npm-script        直接跑 package.json 里的脚本（Taro / 自定义流程）
 */
export function createCompiler (info, opts = {}) {
  switch (info.kind) {
    case 'native':
      return new NoopCompiler(info)
    case 'uniapp-cli':
      return new UniCliCompiler(info, opts)
    case 'uniapp-hbuilderx':
      // 没补 CLI 依赖之前编不了，报错信息要指路
      return new UnavailableCompiler(
        info,
        '这个 uni-app 工程还是 HBuilderX 模式（没有 uni-app CLI 依赖），无法由命令行编译。\n' +
          '跑 `wxctl init` 补上 npm 编译能力（不改动你的目录结构，HBuilderX 仍可继续使用）。'
      )
    case 'taro':
      return new NpmScriptCompiler(info, { script: 'dev:weapp', ...opts })
    default:
      return new UnavailableCompiler(info, '未能识别工程类型，无法编译')
  }
}

class BaseCompiler {
  constructor (info) {
    this.info = info
    /** @type {import('node:child_process').ChildProcess|null} */
    this.proc = null
    this.lastOutput = ''
  }

  get running () {
    return Boolean(this.proc && !this.proc.killed)
  }

  stop () {
    if (this.proc) {
      this.proc.kill('SIGTERM')
      this.proc = null
    }
  }

  /** 产物是否已就绪 */
  get built () {
    return exists(path.join(this.info.distDir, 'app.json'))
  }
}

class NoopCompiler extends BaseCompiler {
  async build () {
    return { ok: true, skipped: true, message: '原生小程序无需编译' }
  }

  async ensureBuilt () {
    return { ok: this.built, skipped: true }
  }
}

class UnavailableCompiler extends BaseCompiler {
  constructor (info, reason) {
    super(info)
    this.reason = reason
  }

  async build () {
    return { ok: false, message: this.reason }
  }

  async ensureBuilt () {
    // 已经有产物就还能用（比如 HBuilderX 之前编过），只是不能由我们触发重编
    if (this.built) return { ok: true, stale: true, message: '用已有产物（无法由命令行重新编译）' }
    return { ok: false, message: this.reason }
  }
}

/**
 * uni-app CLI 编译。
 *
 * 必须显式注入这几个环境变量，原因见 wxctl init 的配方说明：
 * - UNI_CLI_CONTEXT  uni-app 自己的 env.js 存在初始化顺序 bug，第 90 行就用了第 194 行才赋值的这个变量
 * - UNI_INPUT_DIR    指向源码目录；指到工程根就能让源码留在原地，不必挪进 src/
 * - UNI_OUTPUT_DIR   指向产物目录；跟 HBuilderX 保持同一个位置，两套工具可以互不干扰地共存
 */
class UniCliCompiler extends BaseCompiler {
  constructor (info, { platform = 'mp-weixin', mode = 'development' } = {}) {
    super(info)
    this.platform = platform
    this.mode = mode
  }

  env () {
    return {
      ...process.env,
      NODE_ENV: this.mode,
      UNI_PLATFORM: this.platform,
      UNI_CLI_CONTEXT: this.info.root,
      UNI_INPUT_DIR: this.info.srcDir,
      UNI_OUTPUT_DIR: this.info.distDir
    }
  }

  /**
   * @param {{watch?:boolean, timeout?:number, onOutput?:Function}} opts
   */
  async build ({ watch = false, timeout = 300000, onOutput = null } = {}) {
    if (!exists(path.join(this.info.root, 'node_modules'))) {
      return {
        ok: false,
        message: `${this.info.root} 下没有 node_modules，先在该目录跑 npm install（或 wxctl init）`
      }
    }

    const args = ['vue-cli-service', 'uni-build']
    if (watch) args.push('--watch')

    return this._spawn('npx', args, { watch, timeout, onOutput })
  }

  _spawn (cmd, args, { watch, timeout, onOutput }) {
    return new Promise((resolve) => {
      // 关键：不能直接 spawn('npx', ...)。Windows 上那是 npx.cmd，
      // Node 修掉 CVE-2024-27980 之后不带 shell 跑批处理文件会抛 EINVAL。
      // spawnSpec 会把它翻译成「当前 node 直接跑本地 vue-cli-service 入口」——
      // 跨平台之外还少一层进程。
      let spec
      try {
        spec = spawnSpec(cmd, args, { root: this.info.root })
      } catch (err) {
        return resolve({ ok: false, message: String(err.message), output: '' })
      }
      const proc = spawn(spec.file, spec.args, {
        cwd: this.info.root,
        env: this.env(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...spec.opts
      })
      this.proc = proc

      let buf = ''
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.lastOutput = buf
        if (!watch) this.proc = null
        resolve(result)
      }

      const timer = setTimeout(() => {
        finish({ ok: false, message: `编译超时（${timeout}ms）`, output: tail(buf) })
      }, timeout)

      // watch 模式下进程不会退出，只能靠输出特征判定；
      // 但"Failed to compile"这行是先于详细错误打印的，立刻结束会只拿到一句"17 errors"，
      // 所以匹配到之后再宽限一段时间把错误正文收完。
      let settleTimer = null
      const settleSoon = (build) => {
        clearTimeout(settleTimer)
        settleTimer = setTimeout(() => finish(build()), 1200)
      }

      const onChunk = (chunk) => {
        const s = chunk.toString()
        buf += s
        if (onOutput) onOutput(s)
        if (!watch) return // 非 watch 模式一律等进程退出，退出码比输出特征可靠

        if (FAIL_RE.test(s)) {
          settleSoon(() => ({ ok: false, message: '编译失败', errors: extractErrors(buf), output: tail(buf) }))
        } else if (DONE_RE.test(s)) {
          settleSoon(() => ({ ok: true, watching: true, output: tail(buf) }))
        }
      }

      proc.stdout.on('data', onChunk)
      proc.stderr.on('data', onChunk)

      proc.on('error', (err) => finish({ ok: false, message: String(err.message), output: tail(buf) }))
      proc.on('exit', (code) => {
        if (code === 0) finish({ ok: true, output: tail(buf) })
        else finish({ ok: false, message: `编译进程退出码 ${code}`, errors: extractErrors(buf), output: tail(buf) })
      })
    })
  }

  /** 产物不在或过期就编一次 */
  async ensureBuilt (opts = {}) {
    if (this.built && !(await this.isStale())) return { ok: true, cached: true }
    return this.build(opts)
  }

  /** 源码比产物新 = 产物过期 */
  async isStale () {
    if (!this.built) return true
    const distMtime = fs.statSync(path.join(this.info.distDir, 'app.json')).mtimeMs
    const newest = newestSourceMtime(this.info.srcDir, this.info.distDir)
    return newest > distMtime
  }

  /** watch 模式下等一次重新编译落盘 */
  async waitForRebuild ({ timeout = 60000 } = {}) {
    const appJson = path.join(this.info.distDir, 'app.json')
    const before = exists(appJson) ? fs.statSync(appJson).mtimeMs : 0
    return waitUntil(
      () => exists(appJson) && fs.statSync(appJson).mtimeMs > before,
      { timeout, interval: 400, label: '产物重新编译' }
    )
  }
}

class NpmScriptCompiler extends BaseCompiler {
  constructor (info, { script = 'build:weapp' } = {}) {
    super(info)
    this.script = script
  }

  async build ({ timeout = 600000, onOutput = null } = {}) {
    return new Promise((resolve) => {
      // 同上：Windows 上 `npm` 是 npm.cmd，spawnSpec 会改走 npm 的 JS 入口
      const spec = spawnSpec('npm', ['run', this.script], { root: this.info.root })
      const proc = spawn(spec.file, spec.args, {
        cwd: this.info.root,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...spec.opts
      })
      this.proc = proc
      let buf = ''
      const timer = setTimeout(() => {
        proc.kill('SIGTERM')
        resolve({ ok: false, message: `编译超时（${timeout}ms）`, output: tail(buf) })
      }, timeout)

      const onChunk = (c) => {
        buf += c.toString()
        if (onOutput) onOutput(c.toString())
      }
      proc.stdout.on('data', onChunk)
      proc.stderr.on('data', onChunk)
      proc.on('exit', (code) => {
        clearTimeout(timer)
        this.proc = null
        this.lastOutput = buf
        resolve(
          code === 0
            ? { ok: true, output: tail(buf) }
            : { ok: false, message: `npm run ${this.script} 退出码 ${code}`, errors: extractErrors(buf), output: tail(buf) }
        )
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        resolve({ ok: false, message: String(err.message) })
      })
    })
  }

  async ensureBuilt (opts) {
    if (this.built) return { ok: true, cached: true }
    return this.build(opts)
  }
}

/** 源码目录里最新的修改时间（跳过产物与依赖） */
function newestSourceMtime (srcDir, distDir) {
  const skip = new Set(['node_modules', 'unpackage', 'dist', '.git'])
  let newest = 0
  const walk = (dir, depth = 0) => {
    if (depth > 8) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (p === distDir) continue
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/\.(vue|js|ts|json|scss|css|wxml|wxss)$/.test(e.name)) {
        try {
          const m = fs.statSync(p).mtimeMs
          if (m > newest) newest = m
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  walk(srcDir)
  return newest
}

/**
 * 从编译输出里抠出结构化的错误。
 *
 * webpack 的错误块长这样，`@ ./xxx` 那几行是依赖链噪声，对定位没帮助：
 *   error  in ./App.vue?vue&type=style&index=0&lang=css&
 *
 *   Syntax Error: TypeError: definePropertyModule.f is not a function
 *
 *   @ ./App.vue?vue... 1:0-640
 *
 * 而且同一个根因常常在几十个文件上各报一次，所以按错误信息去重 —— 17 条里往往只有 1 个真问题。
 */
function extractErrors (output) {
  const lines = String(output).split('\n')
  const found = []

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:ERROR|error)\s+in\s+(.+)$/)
    if (!m) continue
    const file = m[1].split('?')[0].trim()
    const body = []
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const l = lines[j].trim()
      if (!l) continue
      if (l.startsWith('@ ./')) break
      if (/^(ERROR|error)\s+in\s/.test(l)) break
      body.push(l)
    }
    found.push({ file, message: body.join('\n') })
  }

  // 同一根因去重，但把受影响的文件都列出来
  const byMessage = new Map()
  for (const e of found) {
    if (!byMessage.has(e.message)) byMessage.set(e.message, [])
    byMessage.get(e.message).push(e.file)
  }

  return [...byMessage.entries()].slice(0, 5).map(([message, files]) => ({
    message,
    files: files.slice(0, 5),
    affected: files.length
  }))
}

function tail (s, n = 4000) {
  return String(s).slice(-n)
}
