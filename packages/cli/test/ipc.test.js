import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const HOME = path.join(os.tmpdir(), `wx-agent-ipc-test-${process.pid}`)
process.env.WX_AGENT_HOME = HOME

const { logPathFor, request, serve, socketPathFor } = await import('../src/ipc.js')
const { IS_WIN, channelIsPath } = await import('wx-agent-core')

after(() => fs.rmSync(HOME, { recursive: true, force: true }))

/**
 * CLI ↔ daemon 的通道是整条链路的地基：它不通，所有 wxctl 命令和 MCP 工具都用不了。
 * 这里做真实回环 —— 起 server、连过去、发请求、验证回复，而不是只检查地址长得对不对。
 */
describe('控制通道回环', () => {
  it('地址形态与当前平台一致', () => {
    const addr = socketPathFor('/some/project')
    if (IS_WIN) {
      assert.match(addr, /^\\\\\.\\pipe\\wx-agent-[0-9a-f]{10}-[0-9a-f]{32}$/)
      assert.equal(channelIsPath(addr), false)
    } else {
      assert.ok(addr.endsWith('.sock'), addr)
      assert.equal(channelIsPath(addr), true)
    }
  })

  it('同一项目两次取到同一个地址，不同项目彼此不同', () => {
    assert.equal(socketPathFor('/proj/a'), socketPathFor('/proj/a'))
    assert.notEqual(socketPathFor('/proj/a'), socketPathFor('/proj/b'))
  })

  it('日志路径落在 state 目录下，不在全局可写的 tmpdir 里', () => {
    const log = logPathFor('/proj/a')
    assert.ok(log.startsWith(HOME), log)
    assert.ok(log.endsWith('.log'))
  })

  it('daemon 不在时 request 返回 null，而不是抛异常', async () => {
    const addr = socketPathFor('/never/started/project')
    const r = await request(addr, { cmd: 'ping' }, { timeout: 2000 })
    assert.equal(r, null)
  })

  it('起 server 之后能收发一个完整请求', async () => {
    const addr = socketPathFor('/loopback/project')
    const seen = []
    const server = serve(addr, async (cmd, args) => {
      seen.push([cmd, args])
      if (cmd === 'ping') return { pong: true }
      return { echo: args }
    })
    await new Promise((resolve) => server.once('listening', resolve))

    try {
      const ping = await request(addr, { cmd: 'ping' }, { timeout: 5000 })
      assert.deepEqual(ping, { ok: true, data: { pong: true } })

      // 带参数、且参数里有中文和特殊字符
      const echo = await request(addr, { cmd: 'echo', args: { s: '登录页 & 首页' } }, { timeout: 5000 })
      assert.deepEqual(echo, { ok: true, data: { echo: { s: '登录页 & 首页' } } })

      assert.deepEqual(seen[0], ['ping', {}])
    } finally {
      server.close()
    }
  })

  it('handler 抛错时回一条 ok:false，而不是把连接挂死', async () => {
    const addr = socketPathFor('/failing/project')
    const server = serve(addr, async () => {
      throw new Error('故意失败')
    })
    await new Promise((resolve) => server.once('listening', resolve))

    try {
      const r = await request(addr, { cmd: 'boom' }, { timeout: 5000 })
      assert.equal(r.ok, false)
      assert.match(r.error, /故意失败/)
    } finally {
      server.close()
    }
  })

  it('POSIX 下 socket 文件权限是 0600', { skip: IS_WIN }, async () => {
    const addr = socketPathFor('/perm/project')
    const server = serve(addr, async () => ({}))
    await new Promise((resolve) => server.once('listening', resolve))
    try {
      const mode = fs.statSync(addr).mode & 0o777
      assert.equal(mode, 0o600, `实际权限 ${mode.toString(8)}`)
    } finally {
      server.close()
    }
  })
})
