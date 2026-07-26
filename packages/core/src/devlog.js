import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IS_WIN } from './paths.js'

/**
 * 读微信开发者工具**自己的**运行日志。
 *
 * 为什么要读：开发者工具启动失败时，wx-agent 这边能观察到的只有「端口连上了但调用全挂」。
 * 真正的原因只写在它自己的日志里，比如实测遇到过的这三行：
 *
 *   [ERROR] loadConfig error Error: Client network socket disconnected before secure TLS ...
 *   [ERROR] simulator launch catch error timeout      ← 模拟器压根没启动
 *   [ERROR] start cli server error: [object Object]   ← IDE server 也没起来
 *
 * 这三行一贴出来，排查从「二十分钟」变成「二十秒」。路径是确定的，没有理由让用户自己去翻。
 */

/** 开发者工具的用户数据根目录（各平台不同，可用 WX_DEVTOOLS_USER_DIR 覆盖） */
export function devtoolsUserDir () {
  const override = process.env.WX_DEVTOOLS_USER_DIR
  if (override) return override
  if (IS_WIN) {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(base, '微信开发者工具')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', '微信开发者工具')
  }
  // Linux 上是社区移植版，位置不固定，只能靠环境变量指
  return null
}

function listDirs (dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

/**
 * 找最近写入的那个会话日志。
 *
 * 目录形如 `<userDir>/<32位hash>/WeappLog/logs/<时间戳>-<sessionId>.log`。
 * hash 目录可能有多个（工具升级会换），一律按 mtime 取最新的那个文件。
 */
export function latestSessionLog () {
  const root = devtoolsUserDir()
  if (!root) return null
  let best = null
  for (const hashDir of listDirs(root)) {
    const logsDir = path.join(hashDir, 'WeappLog', 'logs')
    let entries
    try {
      entries = fs.readdirSync(logsDir)
    } catch {
      continue
    }
    for (const name of entries) {
      const file = path.join(logsDir, name)
      try {
        const st = fs.statSync(file)
        if (!st.isFile()) continue
        if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs }
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
  return best?.file ?? null
}

/** 明确指向「工具自身启动失败」的错误特征，命中就优先展示 */
const FATAL_PATTERNS = [
  /simulator launch .*(error|timeout)/i,
  /start cli server error/i,
  /loadConfig error/i,
  /fetchDevelopLibInfo/i,
  /publib.*(fail|error)/i,
  /Failed to fetch/i,
  /secure TLS connection/i
]

/**
 * 摘出最近的 [ERROR] 行。
 *
 * @param {{limit?:number, sinceMs?:number, maxBytes?:number}} opts
 *   sinceMs：只要这个时刻之后的行（避免把上次运行的历史错误算进来）
 * @returns {{file:string, lines:string[], fatal:string[]}|null}
 */
export function recentErrors ({ limit = 12, sinceMs = null, maxBytes = 512 * 1024 } = {}) {
  const file = latestSessionLog()
  if (!file) return null
  let text
  try {
    const st = fs.statSync(file)
    const start = Math.max(0, st.size - maxBytes)
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(st.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }

  const all = text.split('\n').filter((l) => l.includes('[ERROR]'))
  const fresh = sinceMs ? all.filter((l) => lineTime(l) === null || lineTime(l) >= sinceMs) : all
  const picked = (fresh.length ? fresh : all).slice(-limit).map(compact)
  const fatal = picked.filter((l) => FATAL_PATTERNS.some((re) => re.test(l)))
  return { file, lines: picked, fatal }
}

/** 日志行首的 `[2026-07-25 23:57:17.579]` → 毫秒时间戳；解析不了返回 null */
function lineTime (line) {
  const m = line.match(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/)
  if (!m) return null
  const [, y, mo, d, h, mi, s, ms] = m.map(Number)
  return new Date(y, mo - 1, d, h, mi, s, ms).getTime()
}

/** 去掉日志行里那段没信息量的 `/core.wxvpkg/<hash>.js` 来源标记 */
function compact (line) {
  return line
    .replace(/\[unknow\]/g, '')
    .replace(/\[\/core\.wxvpkg\/[a-f0-9]+\.js\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 400)
}

/**
 * 拼成能直接贴进报错信息的一段文本。
 *
 * 命中 FATAL_PATTERNS 的行才敢说「这多半是真因」。开发者工具平时就会刷一堆
 * `[ideplugin] get manifest.json ... not installed` 之类的无关噪声，
 * 把它们当结论抛给用户（或 AI）只会制造新的误判 —— 所以要明确标注「未必相关」。
 */
export function renderDevtoolsErrors (found) {
  if (!found || !found.lines.length) return null
  if (found.fatal.length) {
    const body = found.fatal.map((l) => `  ${l}`).join('\n')
    return `开发者工具日志里的关键错误（这多半才是真因）：\n${body}\n  日志文件：${found.file}`
  }
  const body = found.lines.map((l) => `  ${l}`).join('\n')
  return (
    `开发者工具日志里最近的错误（没有命中已知的致命特征，未必与本次失败相关）：\n${body}\n` +
    `  日志文件：${found.file}`
  )
}
