import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 运行时状态目录（控制 socket、daemon 日志、截图产物）。
 *
 * **不要用 `os.tmpdir()`**：那在 Linux 上是全局可写的 `/tmp`。放在那里意味着
 *   - 任何本地用户都能连上我们的控制 socket，而 daemon 会执行任意命令
 *     （包括在小程序里 eval 代码、往任意路径写截图）；
 *   - 攻击者可以预置同名 symlink 劫持日志/产物的写入目标。
 * macOS 的 tmpdir 恰好是 0700 的私有目录，但不能依赖这个平台差异。
 *
 * 用 `WX_AGENT_HOME` 可以覆盖（比如放到项目内或自定义位置）。
 */
export function stateDir (...parts) {
  const base = process.env.WX_AGENT_HOME || path.join(os.homedir(), '.wx-agent')
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  // recursive 创建时 mode 会被 umask 削弱，且目录可能是早先建的，显式收紧一次
  try {
    fs.chmodSync(base, 0o700)
  } catch {
    /* 别人的目录改不动就算了，至少不该因此崩掉 */
  }
  if (!parts.length) return base

  const dir = path.join(base, ...parts)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * 以「拒绝跟随符号链接」的方式打开文件写入。
 *
 * 直接 `fs.openSync(p, 'a')` 时，如果 p 是攻击者预置的 symlink，
 * 内容会被写进它指向的文件（比如 ~/.ssh/authorized_keys）。
 * O_NOFOLLOW 让这种情况直接报错而不是照写。
 */
export function openAppendNoFollow (file) {
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW
  return fs.openSync(file, flags, 0o600)
}

/**
 * 把用户/模型给的名字变成安全的文件名。
 * 不做这一步的话，`label: "../../../etc/x"` 这类值会拼出目录穿越。
 */
export function safeFileName (name, fallback = 'shot') {
  const cleaned = String(name ?? '')
    .replace(/[/\\]/g, '-') // 干掉路径分隔符
    .replace(/\.{2,}/g, '.') // 干掉 ..
    .replace(/[^\w.\-一-龥]/g, '_') // 只留字母数字下划线点横线和中文
    .replace(/^[.\-]+/, '') // 不以点或横线开头（隐藏文件 / 参数注入）
    .slice(0, 80)
  return cleaned || fallback
}

/**
 * 确认 target 落在 baseDir 之内。
 * 用于把「相对路径」限制在产物目录里，`../../` 穿不出去。
 * @returns {boolean}
 */
export function isInside (baseDir, target) {
  const base = path.resolve(baseDir)
  const resolved = path.resolve(target)
  return resolved === base || resolved.startsWith(base + path.sep)
}
