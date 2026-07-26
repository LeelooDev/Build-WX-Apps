import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 平台判断放在最底层：paths 不该依赖任何本项目模块，platform.js 从这里转出去 */
export const IS_WIN = process.platform === 'win32'

/**
 * POSIX 权限位是否真的起作用。
 * Windows 上 `chmod` 只映射到「只读」属性，0700 这类值形同虚设，
 * 目录的实际访问控制来自 `%USERPROFILE%` 继承的 NTFS ACL（默认只有本人 + 管理员）。
 */
export const HAS_POSIX_PERMS = !IS_WIN

/**
 * `O_NOFOLLOW` 在 Windows 上不存在（`fs.constants.O_NOFOLLOW` 是 undefined）。
 * 拼 flag 时 `x | undefined` 会当 0 处理，所以不会崩，但保护也就没了。
 * 显式取 0，并让 openAppendNoFollow 在那边改用 lstat 预检。
 */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0

/**
 * 运行时状态目录（控制 socket、daemon 日志、截图产物）。
 *
 * **不要用 `os.tmpdir()`**：那在 Linux 上是全局可写的 `/tmp`。放在那里意味着
 *   - 任何本地用户都能连上我们的控制 socket，而 daemon 会执行任意命令
 *     （包括在小程序里 eval 代码、往任意路径写截图）；
 *   - 攻击者可以预置同名 symlink 劫持日志/产物的写入目标。
 * macOS 的 tmpdir 恰好是 0700 的私有目录，但不能依赖这个平台差异。
 *
 * Windows 上落在 `%USERPROFILE%\.wx-agent`，靠 NTFS ACL 而非权限位保护。
 *
 * 用 `WX_AGENT_HOME` 可以覆盖（比如放到项目内或自定义位置）。
 */
export function stateDir (...parts) {
  const base = process.env.WX_AGENT_HOME || path.join(os.homedir(), '.wx-agent')
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  // recursive 创建时 mode 会被 umask 削弱，且目录可能是早先建的，显式收紧一次。
  // Windows 上 chmod 只能改只读位，调它没有收紧效果，跳过。
  if (HAS_POSIX_PERMS) {
    try {
      fs.chmodSync(base, 0o700)
    } catch {
      /* 别人的目录改不动就算了，至少不该因此崩掉 */
    }
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
 *
 * Windows 没有这个 flag，退回 lstat 预检。这**不等价** —— 检查和打开之间存在
 * TOCTOU 窗口。之所以还可接受：目标目录在 `%USERPROFILE%` 下，能往里放 reparse point
 * 的攻击者已经拿到了当前用户的写权限，此时他有远比这更直接的手段。
 */
export function openAppendNoFollow (file) {
  if (!O_NOFOLLOW) {
    const st = fs.lstatSync(file, { throwIfNoEntry: false })
    if (st?.isSymbolicLink()) {
      throw new Error(`拒绝写入 ${file}：它是一个符号链接/重解析点`)
    }
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | O_NOFOLLOW
  return fs.openSync(file, flags, 0o600)
}

/**
 * Windows 的保留设备名。拿它们当文件名，写入会失败或者被重定向到设备本身，
 * 且带任意扩展名（`CON.png`）同样命中。
 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i

/**
 * 把用户/模型给的名字变成安全的文件名。
 * 不做这一步的话，`label: "../../../etc/x"` 这类值会拼出目录穿越。
 */
export function safeFileName (name, fallback = 'shot') {
  let cleaned = String(name ?? '')
    .replace(/[/\\]/g, '-') // 干掉路径分隔符
    .replace(/\.{2,}/g, '.') // 干掉 ..
    .replace(/[^\w.\-一-龥]/g, '_') // 只留字母数字下划线点横线和中文（顺带干掉 Windows 的 : ? * " < > |）
    .replace(/^[.\-]+/, '') // 不以点或横线开头（隐藏文件 / 参数注入）
    .replace(/[.\s]+$/, '') // Windows 会静默吃掉结尾的点和空格，导致实际文件名和返回的路径不一致
    .slice(0, 80)

  // 保留名加前缀而不是丢弃，免得多个不同 label 都塌成同一个 fallback
  if (WIN_RESERVED.test(cleaned)) cleaned = `_${cleaned}`
  return cleaned || fallback
}

/**
 * 确认 target 落在 baseDir 之内。
 * 用于把「相对路径」限制在产物目录里，`../../` 穿不出去。
 *
 * Windows 上路径大小写不敏感，`C:\Base` 和 `c:\base` 是同一个目录。
 * 不折叠大小写的话，合法写入会被误判成越界而拒掉。
 * @returns {boolean}
 */
export function isInside (baseDir, target) {
  const norm = (p) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p))
  const base = norm(baseDir)
  const resolved = norm(target)
  return resolved === base || resolved.startsWith(base + path.sep)
}
