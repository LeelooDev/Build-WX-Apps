import fs from 'node:fs'
import path from 'node:path'
import { exists, readJsonLoose } from './util.js'

/**
 * 小程序包体积分析。
 *
 * 体积限制是小程序最常见的硬卡点，而开发者工具只在真正上传时才告诉你超了。
 * 这里直接算编译产物，随时可查，并按分包归属拆开 —— 因为"主包超了"和"某个分包超了"
 * 解法完全不同（前者要把功能挪进分包，后者要拆得更细或做资源外链）。
 */

/** 官方限制（字节） */
export const LIMITS = {
  mainPackage: 2 * 1024 * 1024, // 主包 2MB
  singlePackage: 2 * 1024 * 1024, // 单个分包 2MB
  total: 20 * 1024 * 1024 // 全部分包合计 20MB
}

/** 打包时会被忽略、不计入体积的东西 */
const IGNORED = [
  /\.map$/, // sourcemap
  /^\.sourcemap\//,
  /^node_modules\//,
  /^project\.config\.json$/,
  /^project\.private\.config\.json$/,
  /^\.eslintrc/,
  /^\.DS_Store$/
]

function isIgnored (rel) {
  return IGNORED.some((re) => re.test(rel))
}

function walk (dir, base = dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      walk(abs, base, out)
    } else {
      const rel = path.relative(base, abs)
      if (isIgnored(rel)) continue
      try {
        out.push({ path: rel, bytes: fs.statSync(abs).size })
      } catch {
        /* 忽略读不到的 */
      }
    }
  }
  return out
}

/**
 * 分析产物体积。
 * @param {string} distDir 编译产物目录（含 app.json 的那个）
 */
export function analyzeSize (distDir) {
  if (!exists(path.join(distDir, 'app.json'))) {
    return { ok: false, message: `${distDir} 下没有 app.json —— 还没编译过？先跑 wxctl compile` }
  }

  const appJson = readJsonLoose(path.join(distDir, 'app.json'), {})
  const subRoots = (appJson.subPackages ?? appJson.subpackages ?? [])
    .map((s) => String(s.root ?? '').replace(/^\/|\/$/g, ''))
    .filter(Boolean)

  const files = walk(distDir)
  const buckets = new Map([['__main__', []]])
  for (const r of subRoots) buckets.set(r, [])

  for (const f of files) {
    const owner = subRoots.find((r) => f.path === r || f.path.startsWith(r + path.sep))
    buckets.get(owner ?? '__main__').push(f)
  }

  const pack = (name, list, limit) => {
    const bytes = list.reduce((s, f) => s + f.bytes, 0)
    return {
      name,
      bytes,
      limit,
      overLimit: bytes > limit,
      usage: limit ? bytes / limit : 0,
      fileCount: list.length,
      largest: [...list].sort((a, b) => b.bytes - a.bytes).slice(0, 10)
    }
  }

  const main = pack('主包', buckets.get('__main__'), LIMITS.mainPackage)
  const subs = subRoots.map((r) => pack(r, buckets.get(r), LIMITS.singlePackage))
  const total = main.bytes + subs.reduce((s, p) => s + p.bytes, 0)

  return {
    ok: true,
    distDir,
    main,
    subPackages: subs,
    total: { bytes: total, limit: LIMITS.total, overLimit: total > LIMITS.total },
    // 按类型汇总，一眼看出是代码大还是图片大
    byExtension: summarizeByExt(files)
  }
}

function summarizeByExt (files) {
  const m = new Map()
  for (const f of files) {
    const ext = path.extname(f.path).toLowerCase() || '(无扩展名)'
    const cur = m.get(ext) ?? { ext, bytes: 0, count: 0 }
    cur.bytes += f.bytes
    cur.count++
    m.set(ext, cur)
  }
  return [...m.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8)
}

export function fmtBytes (b) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(2)} MB`
}

/** 渲染成给人和 AI 看的报告 */
export function renderSizeReport (r) {
  if (!r.ok) return `❌ ${r.message}`
  const lines = []

  const packLine = (p) => {
    const mark = p.overLimit ? '❌ 超限' : p.usage > 0.8 ? '⚠️ 接近上限' : '✅'
    return `${mark} ${p.name.padEnd(16)} ${fmtBytes(p.bytes).padStart(10)} / ${fmtBytes(p.limit)}  (${Math.round(p.usage * 100)}%, ${p.fileCount} 个文件)`
  }

  lines.push(packLine(r.main))
  for (const s of r.subPackages) lines.push(packLine(s))
  lines.push(
    `${r.total.overLimit ? '❌' : '✅'} ${'合计'.padEnd(16)} ${fmtBytes(r.total.bytes).padStart(10)} / ${fmtBytes(r.total.limit)}`
  )

  lines.push('', '按类型：')
  for (const e of r.byExtension) {
    lines.push(`  ${e.ext.padEnd(8)} ${fmtBytes(e.bytes).padStart(10)}  (${e.count} 个)`)
  }

  const hot = r.main.overLimit || r.main.usage > 0.8 ? r.main : r.subPackages.find((s) => s.overLimit)
  if (hot) {
    lines.push('', `${hot.name} 里最大的文件：`)
    for (const f of hot.largest) lines.push(`  ${fmtBytes(f.bytes).padStart(10)}  ${f.path}`)
  }

  return lines.join('\n')
}
