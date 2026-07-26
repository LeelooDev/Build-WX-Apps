import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sleep } from './util.js'
import { isInside, safeFileName } from './paths.js'
import { ARTIFACT_ROOT, DEFAULT_MAX_BYTES, dirFor, stats, sweep } from './artifacts.js'

const execFileAsync = promisify(execFile)

/**
 * 画面捕获：单张截图、连拍帧序列、合成 GIF。
 *
 * 单张截图看不出多步流程和时序问题（点了没反应？动画卡在中间？），
 * 所以提供连拍：按固定间隔连续截图，事后既能合成 GIF 给人回放，
 * 也能把关键帧逐张读给模型看。
 *
 * **产物会自动回收**：daemon / MCP server 是常驻的，不回收的话截图会无限堆积。
 * 累计写入到一定量就触发一次容量检查，超上限则从最旧的开始删。
 */
export class Capture {
  /**
   * @param {import('./session.js').Session} session
   * @param {{outDir?:string, projectRoot?:string, maxBytes?:number}} opts
   */
  constructor (session, { outDir = null, projectRoot = null, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.session = session
    this.maxBytes = maxBytes
    this.outDir = outDir ?? (projectRoot ? dirFor(projectRoot) : dirFor(process.cwd()))
    fs.mkdirSync(this.outDir, { recursive: true })
    // 攒够这么多新增字节才做一次全盘检查 —— 每张图都扫一遍目录太浪费。
    // 必须显著小于上限，否则上限设得小时会「攒不够就永远不检查」。
    this._sweepThreshold = Math.max(Math.min(maxBytes * 0.1, 8 * 1024 * 1024), 256 * 1024)
    this._writtenSinceSweep = 0
  }

  /** 记录新增用量，够量了就检查一次容量 */
  _accrue (bytes) {
    this._writtenSinceSweep += bytes
    if (this._writtenSinceSweep < this._sweepThreshold) return null
    this._writtenSinceSweep = 0
    return sweep({ root: ARTIFACT_ROOT, maxBytes: this.maxBytes })
  }

  /** 当前产物占用 */
  stats () {
    return { ...stats(ARTIFACT_ROOT), maxBytes: this.maxBytes }
  }

  /** 立即回收（force=true 清空所有产物） */
  sweep ({ force = false } = {}) {
    this._writtenSinceSweep = 0
    return sweep({ root: ARTIFACT_ROOT, maxBytes: this.maxBytes, force })
  }

  get mp () {
    return this.session.mp
  }

  /**
   * 解析产物落盘路径。
   *
   * - **绝对路径**：调用方显式要求的"另存为"，按原样使用。这是功能本身
   *   （`wxctl screenshot -o ~/desktop/a.png`），不是漏洞。
   *   面向模型的 MCP 层会另外把它约束在项目/产物目录内。
   * - **相对路径**：一律锁在产物目录内，`../../` 穿不出去。
   */
  _path (name) {
    if (path.isAbsolute(name)) return name
    const target = path.resolve(this.outDir, name)
    if (!isInside(this.outDir, target)) {
      throw new Error(`产物路径越界：${name} 解析后落在 ${this.outDir} 之外`)
    }
    return target
  }

  /**
   * 截一张图。
   * @param {{path?:string, label?:string}} opts
   * @returns {Promise<{path:string, bytes:number}>}
   */
  async screenshot ({ path: target = null, label = 'shot' } = {}) {
    // label 会拼进文件名，必须消毒 —— 否则 "../../x" 这样的值能拼出目录穿越
    const file = this._path(target ?? `${safeFileName(label)}-${Date.now()}.png`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    await this.mp.screenshot({ path: file })
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0
    if (!bytes) throw new Error(`截图失败（文件为空）：${file}`)
    // 用户显式指定路径的截图是他要的产物，不纳入自动回收
    const swept = target ? null : this._accrue(bytes)
    return { path: file, bytes, swept: swept?.triggered ? swept : undefined }
  }

  /**
   * 连拍。
   * @param {{interval?:number, count?:number, prefix?:string, onFrame?:Function}} opts
   * @returns {Promise<string[]>} 帧文件路径
   */
  async burst ({ interval = 500, count = 10, prefix = 'frame', onFrame = null } = {}) {
    const dir = path.join(this.outDir, `${safeFileName(prefix, 'frames')}-${Date.now()}`)
    fs.mkdirSync(dir, { recursive: true })
    const frames = []
    for (let i = 0; i < count; i++) {
      const file = path.join(dir, `${String(i).padStart(3, '0')}.png`)
      try {
        await this.mp.screenshot({ path: file })
        frames.push(file)
        if (onFrame) await onFrame(file, i)
      } catch {
        /* 某一帧失败不影响整体 */
      }
      if (i < count - 1) await sleep(interval)
    }
    // 连拍是产物大户（几十张图），拍完立刻结算一次
    this._accrue(frames.reduce((s, f) => s + safeSize(f), 0))
    return frames
  }

  /**
   * 一边执行动作一边连拍，用于记录多步交互。
   * @param {Function} action 期间要跑的操作
   */
  async recordWhile (action, { interval = 400, maxFrames = 40, prefix = 'rec' } = {}) {
    const dir = path.join(this.outDir, `${safeFileName(prefix, 'frames')}-${Date.now()}`)
    fs.mkdirSync(dir, { recursive: true })
    const frames = []
    let stop = false

    const shooter = (async () => {
      for (let i = 0; i < maxFrames && !stop; i++) {
        const file = path.join(dir, `${String(i).padStart(3, '0')}.png`)
        try {
          await this.mp.screenshot({ path: file })
          frames.push(file)
        } catch {
          /* 忽略单帧失败 */
        }
        await sleep(interval)
      }
    })()

    let result
    try {
      result = await action()
    } finally {
      stop = true
      await shooter
      this._accrue(frames.reduce((s, f) => s + safeSize(f), 0))
    }
    return { frames, result, dir }
  }

  /**
   * 帧序列合成 GIF（需要 ffmpeg）。
   * @returns {Promise<string|null>} 失败返回 null（ffmpeg 没装不该让整个流程崩）
   */
  async toGif (frames, { out = null, fps = 4, width = 320 } = {}) {
    if (!frames?.length) return null
    const dir = path.dirname(frames[0])
    const target = out ?? path.join(this.outDir, `clip-${Date.now()}.gif`)

    // 用 concat demuxer 而不是 `-pattern_type glob`：
    //   1. glob 依赖 POSIX glob()，Windows 上的官方 ffmpeg 构建根本没编进去，直接报错；
    //   2. 连拍时单帧失败会让序号断档（001、003…），`%03d` 模式一遇到缺号就停在那儿；
    //   3. 列表里能顺带写死每帧时长，比靠 -framerate 猜更准。
    const list = path.join(dir, 'frames.txt')
    const dur = (1 / fps).toFixed(4)
    // concat demuxer 会忽略最后一条 file 的 duration，末帧重复一次才能保住它的显示时长
    const lines = frames
      .map((f) => `file '${ffconcatEscape(path.basename(f))}'\nduration ${dur}`)
      .concat(`file '${ffconcatEscape(path.basename(frames[frames.length - 1]))}'`)

    try {
      fs.writeFileSync(list, lines.join('\n') + '\n')
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'concat',
        // 列表里用的是相对文件名（配合 -i 所在目录），不涉及跨目录引用
        '-safe', '0',
        '-i', list,
        '-vf', `scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
        target
      ], { timeout: 120000, cwd: dir, windowsHide: true })
      if (!fs.existsSync(target)) return null
      this._accrue(safeSize(target))
      return target
    } catch {
      return null
    } finally {
      try {
        fs.rmSync(list, { force: true })
      } catch {
        /* 清单文件残留无所谓，会被产物回收带走 */
      }
    }
  }

  /** 清理本项目的产物目录 */
  cleanup () {
    try {
      fs.rmSync(this.outDir, { recursive: true, force: true })
    } catch {
      /* 清不掉就算了 */
    }
  }
}

/**
 * ffconcat 清单里 file 行的转义。文件名已经过 safeFileName，不会有引号，
 * 但帧目录名来自 prefix，还是按规矩转一道：反斜杠转义单引号。
 */
function ffconcatEscape (name) {
  return String(name).replace(/'/g, "'\\''")
}

function safeSize (file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}
