import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * CLI ↔ daemon 的本地通信。
 *
 * 为什么要 daemon：console 日志只在 automator 连接期间才会推送过来。
 * 如果每条 wxctl 命令都各自连一次、断一次，那么"点一下按钮然后看日志"永远看不到东西 ——
 * 日志产生在两次连接之间。所以让一个常驻进程持有连接和日志缓冲，CLI 只是它的瘦客户端。
 */

const IDLE_TIMEOUT_MS = 30 * 60 * 1000

export function socketPathFor (projectDir) {
  const hash = crypto.createHash('sha1').update(path.resolve(projectDir)).digest('hex').slice(0, 10)
  return path.join(os.tmpdir(), `wx-agent-${hash}.sock`)
}

export function logPathFor (projectDir) {
  const hash = crypto.createHash('sha1').update(path.resolve(projectDir)).digest('hex').slice(0, 10)
  return path.join(os.tmpdir(), `wx-agent-${hash}.log`)
}

/** 发一条请求；daemon 不在就返回 null（由调用方决定是否拉起） */
export function request (sockPath, payload, { timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(sockPath)) return resolve(null)
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
      // socket 文件是上次没清干净的残留
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
        try {
          fs.rmSync(sockPath, { force: true })
        } catch {}
        return resolve(null)
      }
      reject(err)
    })
  })
}

/** 拉起 daemon 并等它就绪 */
export async function ensureDaemon (projectDir, { port = 9420 } = {}) {
  const sockPath = socketPathFor(projectDir)
  const ping = await request(sockPath, { cmd: 'ping' }, { timeout: 5000 }).catch(() => null)
  if (ping?.ok) return { sockPath, started: false }

  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wxctl.js')
  const out = fs.openSync(logPathFor(projectDir), 'a')
  const child = spawn(process.execPath, [entry, '__daemon', projectDir, String(port), sockPath], {
    detached: true,
    stdio: ['ignore', out, out]
  })
  child.unref()

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    const r = await request(sockPath, { cmd: 'ping' }, { timeout: 3000 }).catch(() => null)
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
  try {
    fs.rmSync(sockPath, { force: true })
  } catch {}

  let idleTimer = null
  const resetIdle = (server) => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      server.close()
      process.exit(0)
    }, IDLE_TIMEOUT_MS)
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

  server.listen(sockPath, () => resetIdle(server))

  const shutdown = () => {
    try {
      fs.rmSync(sockPath, { force: true })
    } catch {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return server
}
