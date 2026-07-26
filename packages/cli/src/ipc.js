import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  IS_WIN,
  channelFor,
  channelIsPath,
  clearChannel,
  openAppendNoFollow,
  stateDir
} from 'wx-agent-core'

/**
 * CLI ↔ daemon 的本地通信。
 *
 * 为什么要 daemon：console 日志只在 automator 连接期间才会推送过来。
 * 如果每条 wxctl 命令都各自连一次、断一次，那么"点一下按钮然后看日志"永远看不到东西 ——
 * 日志产生在两次连接之间。所以让一个常驻进程持有连接和日志缓冲，CLI 只是它的瘦客户端。
 *
 * 安全：这个通道等同于一个**无认证的控制接口** —— 连上就能让 daemon 在小程序里
 * 执行任意 JS、往路径里写截图。两个平台的隔离手段不同：
 *   - POSIX：Unix domain socket 放在 ~/.wx-agent/run/（0700），靠目录权限限制到本人。
 *     绝不能放 os.tmpdir()，Linux 上那是全局可写的 /tmp。
 *   - Windows：没有 Unix socket，改用 named pipe；而 \\.\pipe\ 是全机器共享且无权限位的
 *     命名空间，所以 pipe 名带 16 字节随机串，真名存在受 NTFS ACL 保护的指针文件里。
 * 具体实现见 core/src/platform.js 的 channelFor。
 */

const IDLE_TIMEOUT_MS = 30 * 60 * 1000

function runtimeKey (projectDir) {
  return crypto.createHash('sha1').update(path.resolve(projectDir)).digest('hex').slice(0, 10)
}

/**
 * 本项目的控制通道地址。
 * POSIX 下是 socket 文件路径，Windows 下是 `\\.\pipe\wx-agent-<key>-<随机>`。
 * 名字保留 socketPathFor 是为了不动调用方；返回值一律直接交给 net.connect / server.listen。
 */
export function socketPathFor (projectDir) {
  return channelFor(runtimeKey(projectDir))
}

export function logPathFor (projectDir) {
  return path.join(stateDir('run'), `${runtimeKey(projectDir)}.log`)
}

/** 发一条请求；daemon 不在就返回 null（由调用方决定是否拉起） */
export function request (sockPath, payload, { timeout = 600000, key = null } = {}) {
  return new Promise((resolve, reject) => {
    // Windows 的 pipe 名不是文件系统路径，拿 fs 探测只会得到假的 false
    if (channelIsPath(sockPath) && !fs.existsSync(sockPath)) return resolve(null)
    const sock = net.connect(sockPath)
    let buf = ''
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error(`daemon 响应超时（${timeout}ms）`))
    }, timeout)

    sock.on('connect', () => sock.write(JSON.stringify(payload) + '\n'))
    sock.on('data', (c) => {
      buf += c.toString()
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      clearTimeout(timer)
      sock.end()
      try {
        resolve(JSON.parse(buf.slice(0, nl)))
      } catch (e) {
        reject(new Error(`daemon 返回了无法解析的内容：${buf.slice(0, 200)}`))
      }
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      // 地址记录是上次没清干净的残留：POSIX 下是 socket 文件，Windows 下是 pipe 指针文件。
      // Windows 连不存在的 pipe 报的是 ENOENT，另有管道忙时的 EPIPE。
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
        clearChannel(sockPath, key)
        return resolve(null)
      }
      reject(err)
    })
  })
}

/** 拉起 daemon 并等它就绪 */
export async function ensureDaemon (projectDir, { port = 9420 } = {}) {
  const key = runtimeKey(projectDir)
  let sockPath = socketPathFor(projectDir)
  const ping = await request(sockPath, { cmd: 'ping' }, { timeout: 5000, key }).catch(() => null)
  if (ping?.ok) return { sockPath, started: false }

  // ping 失败时残留的地址记录已被 clearChannel 清掉，Windows 下要重新取一次
  // 才能拿到新生成的 pipe 名（否则父子两边用的名字不一致，永远连不上）。
  sockPath = socketPathFor(projectDir)

  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wxctl.js')
  // O_NOFOLLOW：日志路径若被换成 symlink，宁可报错也不能顺着写到别的文件里去
  const out = openAppendNoFollow(logPathFor(projectDir))
  const child = spawn(process.execPath, [entry, '__daemon', projectDir, String(port), sockPath], {
    detached: true,
    stdio: ['ignore', out, out],
    // Windows 上 detached 会给子进程开一个新控制台，不隐藏就会在用户屏幕上弹黑窗口
    windowsHide: true
  })
  child.unref()

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    const r = await request(sockPath, { cmd: 'ping' }, { timeout: 3000, key }).catch(() => null)
    if (r?.ok) return { sockPath, started: true }
  }
  throw new Error(`daemon 启动失败，看日志：${logPathFor(projectDir)}`)
}

/**
 * daemon 服务端。
 * @param {string} sockPath
 * @param {(cmd:string, args:any)=>Promise<any>} handler
 */
export function serve (sockPath, handler) {
  // 清上次残留的 socket 文件，否则 listen 会 EADDRINUSE。
  // Windows 的 pipe 由内核随进程回收，没有文件要删（对 pipe 名调 rmSync 只会报错）。
  if (channelIsPath(sockPath)) {
    try {
      fs.rmSync(sockPath, { force: true })
    } catch {}
  }

  let idleTimer = null
  const resetIdle = (server) => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      server.close()
      process.exit(0)
    }, IDLE_TIMEOUT_MS)
    // daemon 靠 server 的 handle 保持存活，这个定时器不需要额外撑着事件循环。
    // unref 之后 server.close() 就能让进程正常退出（否则得等满 30 分钟）。
    idleTimer.unref?.()
  }

  const server = net.createServer((sock) => {
    resetIdle(server)
    let buf = ''
    sock.on('data', async (c) => {
      buf += c.toString()
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let reply
        try {
          const msg = JSON.parse(line)
          reply = { ok: true, data: await handler(msg.cmd, msg.args ?? {}) }
        } catch (err) {
          reply = { ok: false, error: err?.message ?? String(err) }
        }
        sock.write(JSON.stringify(reply) + '\n')
      }
    })
    sock.on('error', () => {})
  })

  server.listen(sockPath, () => {
    // 目录已是 0700，socket 再收一次权限做纵深防御。
    // Windows 的 named pipe 没有 POSIX 权限位，隔离靠 channelFor 里的随机名字。
    if (channelIsPath(sockPath)) {
      try {
        fs.chmodSync(sockPath, 0o600)
      } catch {
        /* 某些平台上 socket 不支持 chmod，忽略 */
      }
    }
    resetIdle(server)
  })

  const shutdown = () => {
    if (channelIsPath(sockPath)) {
      try {
        fs.rmSync(sockPath, { force: true })
      } catch {}
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  // Windows 不投递 SIGTERM（注册不报错但永远不触发），那边靠 SIGBREAK 和进程退出兜底
  process.on('SIGTERM', shutdown)
  if (IS_WIN) process.on('SIGBREAK', shutdown)
  return server
}
