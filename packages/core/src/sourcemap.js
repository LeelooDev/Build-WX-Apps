import fs from 'node:fs'
import path from 'node:path'
import { SourceMapConsumer } from 'source-map'
import { exists } from './util.js'

/**
 * 把小程序运行时的报错堆栈映射回原始源码（uni-app 的 .vue / Taro 的 .tsx）。
 *
 * 运行时堆栈长这样：
 *   at pi.onTapError (http://127.0.0.1:49392/appservice/pages/tree/index.js:28:11)
 * 其中 `pages/tree/index.js:28:11` 是**编译产物**的位置，对着源码看毫无意义。
 * 这里用编译期产出的 .js.map 反查回 `pages/tree/index.vue:157:6`，并把那几行源码摘出来。
 */

/** 匹配堆栈行里的 "位置"：优先带函数名的括号形式，其次裸地址形式 */
const FRAME_RE = /at\s+(?:(.+?)\s+\()?([^()\s]+?):(\d+):(\d+)\)?/

/** 从 URL 里剥出产物内的相对路径：http://127.0.0.1:PORT/appservice/pages/a/b.js?x=1 → pages/a/b.js */
function toDistRelative (loc) {
  let p = loc
  try {
    if (/^https?:\/\//.test(p)) p = new URL(p).pathname
  } catch {
    /* 不是合法 URL 就按原样处理 */
  }
  p = p.split('?')[0]
  // 小程序把逻辑层代码挂在 /appservice/ 下，渲染层在 /wxml/ 或 /pageframe/
  p = p.replace(/^\/?(appservice|wxml|pageframe)\//, '')
  return p.replace(/^\/+/, '')
}

/** 源码路径规整：uni-app:///pages/a.vue → pages/a.vue；webpack:////abs/path.vue?hash → 绝对路径 */
function normalizeSource (source, projectRoot) {
  if (!source) return null
  let s = source.split('?')[0]
  if (s.startsWith('uni-app:///')) return s.slice('uni-app:///'.length)
  if (s.startsWith('webpack:////')) {
    const abs = '/' + s.slice('webpack:////'.length)
    return projectRoot ? path.relative(projectRoot, abs) : abs
  }
  if (s.startsWith('webpack:///')) return s.slice('webpack:///'.length).replace(/^\.\//, '')
  return s
}

/** 是否是我们真正关心的源码（排除运行时/依赖噪声） */
function isUserSource (rel) {
  if (!rel) return false
  if (rel.includes('node_modules')) return false
  if (rel.startsWith('webpack/')) return false
  if (/^uni-app:/.test(rel)) return false
  return /\.(vue|js|ts|tsx|jsx|nvue)$/.test(rel)
}

export class SourceMapper {
  /**
   * @param {string|null} sourcemapDir 形如 <root>/unpackage/dist/dev/.sourcemap/mp-weixin
   * @param {string|null} projectRoot  用于把绝对路径转成相对路径展示
   */
  constructor (sourcemapDir, projectRoot = null) {
    this.dir = sourcemapDir
    this.root = projectRoot
    /** @type {Map<string, Promise<SourceMapConsumer|null>>} */
    this._cache = new Map()
  }

  get available () {
    return Boolean(this.dir && exists(this.dir))
  }

  /** 懒加载某个产物文件对应的 consumer */
  _consumer (distRel) {
    if (this._cache.has(distRel)) return this._cache.get(distRel)
    const p = (async () => {
      if (!this.available) return null
      const mapFile = path.join(this.dir, distRel + '.map')
      if (!exists(mapFile)) return null
      try {
        const raw = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
        return { consumer: await new SourceMapConsumer(raw), raw }
      } catch {
        return null
      }
    })()
    this._cache.set(distRel, p)
    return p
  }

  /**
   * 映射单个位置。
   *
   * 两个坑：
   * - bias 必须用默认的 GREATEST_LOWER_BOUND（往前找最近的映射点）。用 LEAST_UPPER_BOUND
   *   只在同一产物行内往后找，该行没有 ≥ column 的映射就直接返回 null，绝大多数位置都会失败。
   * - uni-app 的 map 里同一个 .vue 会出现多条 source：`webpack:///./x.vue?19d2` 是 vue-loader
   *   拆出的单个 block（行号恒为 1，没有定位价值），`uni-app:///x.vue` 才是带真实行号的整份源码。
   *   所以标记 exact，供上层优先选取。
   *
   * @returns {Promise<{source:string,line:number,column:number,name:string|null,exact:boolean,snippet:string|null}|null>}
   */
  async mapPosition (distLoc, line, column = 0) {
    const distRel = toDistRelative(distLoc)
    const loaded = await this._consumer(distRel)
    if (!loaded) return null

    const query = { line: Number(line), column: Number(column) }
    let pos = loaded.consumer.originalPositionFor(query)
    if (!pos || !pos.source) {
      pos = loaded.consumer.originalPositionFor({
        ...query,
        bias: SourceMapConsumer.LEAST_UPPER_BOUND
      })
    }
    if (!pos || !pos.source || pos.line == null) return null

    const rel = normalizeSource(pos.source, this.root)
    return {
      source: rel,
      line: pos.line,
      column: pos.column ?? 0,
      name: pos.name ?? null,
      exact: pos.source.startsWith('uni-app:///'),
      snippet: this._snippet(loaded, pos)
    }
  }

  /** 从 sourcesContent 里取报错行前后各 2 行 */
  _snippet (loaded, pos, context = 2) {
    try {
      // 必须用 sourceContentFor：库会规范化 source 路径（webpack:///./a → webpack:///a），
      // 拿 pos.source 去 raw.sources.indexOf 永远匹配不上。
      const content = loaded.consumer.sourceContentFor(pos.source, true)
      if (!content) return null
      const lines = content.split('\n')
      const from = Math.max(0, pos.line - 1 - context)
      const to = Math.min(lines.length, pos.line + context)
      return lines
        .slice(from, to)
        .map((text, i) => {
          const n = from + i + 1
          return `${n === pos.line ? '>' : ' '} ${String(n).padStart(4)} | ${text}`
        })
        .join('\n')
    } catch {
      return null
    }
  }

  /**
   * 映射整个堆栈字符串。
   * @param {string} stack
   * @param {{max?:number, userOnly?:boolean}} opts
   * @returns {Promise<{frames:Array, best:Object|null, text:string}>}
   */
  async mapStack (stack, { max = 8, userOnly = true } = {}) {
    const frames = []
    for (const rawLine of String(stack || '').split('\n')) {
      const m = rawLine.match(FRAME_RE)
      if (!m) continue
      const [, fnName, loc, line, col] = m
      const mapped = await this.mapPosition(loc, line, col)
      frames.push({
        fn: fnName || null,
        dist: `${toDistRelative(loc)}:${line}:${col}`,
        mapped
      })
      if (frames.length >= max) break
    }

    // 挑"最值得给人看的那一帧"：先要能映射且是用户源码，其中优先带真实行号的（exact）
    const usable = frames.filter((f) => f.mapped && (!userOnly || isUserSource(f.mapped.source)))
    const best =
      usable.find((f) => f.mapped.exact) ??
      usable[0] ??
      frames.find((f) => f.mapped) ??
      null

    return { frames, best, text: renderFrames(frames, best) }
  }
}

/** 渲染成给人和 AI 看的紧凑文本 */
function renderFrames (frames, best) {
  const out = []
  if (best?.mapped) {
    out.push(`→ ${best.mapped.source}:${best.mapped.line}:${best.mapped.column}${best.fn ? `  (${best.fn})` : ''}`)
    if (best.mapped.snippet) out.push(best.mapped.snippet)
    out.push('')
  }
  for (const f of frames) {
    out.push(
      f.mapped
        ? `  at ${f.fn ?? '<anonymous>'} — ${f.mapped.source}:${f.mapped.line}:${f.mapped.column}   [产物 ${f.dist}]`
        : `  at ${f.fn ?? '<anonymous>'} — ${f.dist}   [无 sourcemap]`
    )
  }
  return out.join('\n')
}

/** 便捷函数：一次性映射并释放 */
export async function mapStackOnce (stack, sourcemapDir, projectRoot) {
  const mapper = new SourceMapper(sourcemapDir, projectRoot)
  return mapper.mapStack(stack)
}
