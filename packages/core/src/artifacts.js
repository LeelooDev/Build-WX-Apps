import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stateDir } from './paths.js'

/**
 * 截图 / 帧序列 / GIF 的产物管理。
 *
 * 为什么需要：daemon 和 MCP server 都是常驻进程，每次截图落一个文件却从不回收，
 * 跑一天下来临时目录里能堆几千张图。这里给整个产物根目录设一个容量上限，
 * 超了就自动回收，用户不用操心。
 *
 * 所有项目共用一个根目录（按项目分子目录），这样上限是**全局**的 ——
 * 否则同时开几个项目，每个各占上限，总量照样失控。
 */

/**
 * 产物根目录，落在用户私有的 ~/.wx-agent/ 下（0700）。
 * 早期版本放在 os.tmpdir()，但那在 Linux 上是全局可写的 /tmp —— 别的本地用户
 * 可以预置同名 symlink 劫持写入。旧位置的残留由 sweepLegacyDirs 负责清理。
 */
export const ARTIFACT_ROOT = stateDir('artifacts')

/** 默认容量上限，可用 WX_AGENT_MAX_ARTIFACT_MB 覆盖 */
export const DEFAULT_MAX_BYTES = Number(process.env.WX_AGENT_MAX_ARTIFACT_MB || 100) * 1024 * 1024

/** 触发回收后要降到的水位（占上限的比例）——留出余量，避免每张图都触发一次清理 */
const LOW_WATER_RATIO = 0.5

/** 这段时间内产生的文件不回收：它们的路径很可能刚返回给用户/模型，删了就成死链 */
const KEEP_RECENT_MS = 60 * 1000

/** 超过这个时间没动过的项目子目录，视为上次遗留，直接整个删掉 */
const STALE_DIR_MS = 24 * 60 * 60 * 1000

/** 每个项目一个子目录，名字带上可读前缀方便人肉排查 */
export function dirFor (projectRoot) {
  const hash = crypto.createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 8)
  const name = path.basename(projectRoot).replace(/[^\w.-]/g, '_').slice(0, 24)
  const dir = path.join(ARTIFACT_ROOT, `${name}-${hash}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function walkFiles (dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      walkFiles(abs, out)
    } else {
      try {
        const st = fs.statSync(abs)
        out.push({ path: abs, bytes: st.size, mtime: st.mtimeMs })
      } catch {
        /* 并发下文件可能已经没了 */
      }
    }
  }
  return out
}

/** 当前占用情况 */
export function stats (root = ARTIFACT_ROOT) {
  const files = walkFiles(root)
  return {
    root,
    bytes: files.reduce((s, f) => s + f.bytes, 0),
    fileCount: files.length,
    oldest: files.length ? Math.min(...files.map((f) => f.mtime)) : null,
    newest: files.length ? Math.max(...files.map((f) => f.mtime)) : null
  }
}

/** 删掉空目录（自底向上） */
function pruneEmptyDirs (dir, root) {
  if (dir === root) return
  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir)
      pruneEmptyDirs(path.dirname(dir), root)
    }
  } catch {
    /* 删不掉就算了 */
  }
}

/** 清掉上次运行遗留的陈旧项目目录 */
function sweepStaleDirs (root, now) {
  let freed = 0
  let dirs = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return freed
  }
  for (const d of dirs) {
    const abs = path.join(root, d.name)
    try {
      if (now - fs.statSync(abs).mtimeMs < STALE_DIR_MS) continue
      freed += walkFiles(abs).reduce((s, f) => s + f.bytes, 0)
      fs.rmSync(abs, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
  return freed
}

/**
 * 清掉早期版本遗留在 tmpdir 里的产物目录：
 *   - `wx-agent-<pid>`      最早的实现，每个进程一个目录
 *   - `wx-agent-artifacts`  上一版的产物根目录（后来因安全原因移到 ~/.wx-agent/）
 * 不清的话它们会一直占着磁盘。
 */
export function sweepLegacyDirs (now = Date.now()) {
  const tmp = os.tmpdir()
  let freed = 0
  let removed = 0
  let entries = []
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true })
  } catch {
    return { freed, removed }
  }
  for (const e of entries) {
    const isDir = e.isDirectory()
    // 旧产物目录：wx-agent-<pid>/ 和 wx-agent-artifacts/
    const legacyDir = isDir && (/^wx-agent-\d+$/.test(e.name) || e.name === 'wx-agent-artifacts')
    // 旧的控制 socket 与 daemon 日志：wx-agent-<hash>.sock / .log
    const legacyFile = !isDir && /^wx-agent-[\da-f]+\.(sock|log)$/.test(e.name)
    if (!legacyDir && !legacyFile) continue

    const abs = path.join(tmp, e.name)
    try {
      // 可能还被某个活着的进程用着，隔一小时再动
      if (now - fs.lstatSync(abs).mtimeMs < 60 * 60 * 1000) continue
      if (legacyDir) freed += walkFiles(abs).reduce((s, f) => s + f.bytes, 0)
      else freed += fs.lstatSync(abs).size
      fs.rmSync(abs, { recursive: true, force: true })
      removed++
    } catch {
      /* 忽略 */
    }
  }
  return { freed, removed }
}

/**
 * 回收产物。
 *
 * @param {{root?:string, maxBytes?:number, force?:boolean, keepRecentMs?:number}} opts
 *   force=true 时无视上限和保护期，清空所有产物（对应 `wxctl clean`）
 * @returns {{before:number, after:number, freed:number, removed:number, triggered:boolean}}
 */
export function sweep ({
  root = ARTIFACT_ROOT,
  maxBytes = DEFAULT_MAX_BYTES,
  force = false,
  keepRecentMs = KEEP_RECENT_MS
} = {}) {
  const now = Date.now()
  const legacy = sweepLegacyDirs(now)
  if (!fs.existsSync(root)) {
    return { before: legacy.freed, after: 0, freed: legacy.freed, removed: legacy.removed, triggered: legacy.removed > 0 }
  }

  let freed = sweepStaleDirs(root, now) + legacy.freed
  let files = walkFiles(root)
  const before = files.reduce((s, f) => s + f.bytes, 0) + freed

  if (force) {
    for (const f of files) {
      try {
        fs.rmSync(f.path, { force: true })
        freed += f.bytes
      } catch {
        /* 忽略 */
      }
    }
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    return { before, after: 0, freed, removed: files.length, triggered: true }
  }

  let remaining = before - freed
  if (remaining <= maxBytes) {
    return { before, after: remaining, freed, removed: 0, triggered: false }
  }

  // 从最旧的开始删，直到降到水位线以下；跳过刚产生的（路径可能刚交给调用方）
  const target = maxBytes * LOW_WATER_RATIO
  const cutoff = now - keepRecentMs
  files.sort((a, b) => a.mtime - b.mtime)

  let removed = 0
  for (const f of files) {
    if (remaining <= target) break
    if (f.mtime > cutoff) continue
    try {
      fs.rmSync(f.path, { force: true })
      pruneEmptyDirs(path.dirname(f.path), root)
      remaining -= f.bytes
      freed += f.bytes
      removed++
    } catch {
      /* 忽略 */
    }
  }

  return { before, after: remaining, freed, removed, triggered: true }
}

export function fmtBytes (b) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

/** 渲染成给人看的报告 */
export function renderArtifactStats (s, maxBytes = DEFAULT_MAX_BYTES) {
  const pct = maxBytes ? Math.round((s.bytes / maxBytes) * 100) : 0
  const lines = [
    `产物目录：${s.root}`,
    `占用：${fmtBytes(s.bytes)} / ${fmtBytes(maxBytes)}  (${pct}%)  ${s.fileCount} 个文件`
  ]
  if (s.oldest) lines.push(`最早：${new Date(s.oldest).toLocaleString()}`)
  if (pct >= 100) lines.push('⚠️ 已超上限，下次截图时会自动回收最旧的文件')
  return lines.join('\n')
}
