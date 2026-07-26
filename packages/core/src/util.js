import fs from 'node:fs'
import path from 'node:path'

/** 文件/目录是否存在 */
export function exists (p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * 去掉 JSON 中的注释与尾逗号。
 * 小程序生态里 manifest.json / project.config.json 常带 `//` 和 `/* *\/` 注释
 * （HBuilderX 生成的 manifest.json 一定有），直接 JSON.parse 会炸。
 * 字符串字面量内部的 `//` 不能误删，所以要跟踪引号状态。
 */
export function stripJsonComments (input) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const next = input[i + 1]

    if (inLine) {
      if (ch === '\n') {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\') {
        // 转义序列整体带过，避免把 \" 误判为字符串结束
        out += next ?? ''
        i++
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += ch
  }

  // 去掉对象/数组里的尾逗号
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** 读取可能带注释的 JSON；读不到或解析失败返回 fallback */
export function readJsonLoose (file, fallback = null) {
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')))
  } catch {
    return fallback
  }
}

/** 写 JSON（2 空格缩进，末尾换行） */
export function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/** 从当前目录向上找到含有任一标志文件的目录 */
export function findUp (startDir, markers) {
  let dir = path.resolve(startDir)
  for (;;) {
    if (markers.some((m) => exists(path.join(dir, m)))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** sleep */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 轮询直到 fn 返回真值或超时。
 * @returns fn 的返回值；超时抛错
 */
export async function waitUntil (fn, { timeout = 30000, interval = 300, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`等待超时（${timeout}ms）：${label}`)
    await sleep(interval)
  }
}
