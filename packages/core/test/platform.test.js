import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const HOME = path.join(os.tmpdir(), `wx-agent-platform-test-${process.pid}`)
process.env.WX_AGENT_HOME = HOME

const { channelFor, channelIsPath, clearChannel, quoteCmdArg, spawnSpec, findNpmCli } =
  await import('../src/platform.js')

after(() => fs.rmSync(HOME, { recursive: true, force: true }))

/**
 * 这些用例都显式传 `win: true/false`，而不是靠 process.platform。
 * 否则 Windows 分支只有在 Windows 上才被执行到 —— 等于永远没人验证。
 */

describe('quoteCmdArg —— 传给 cmd.exe 的参数必须不能变成命令', () => {
  it('普通参数加引号', () => {
    assert.equal(quoteCmdArg('hello'), '"hello"')
  })

  it('含空格的路径不会被拆成两个参数', () => {
    assert.equal(quoteCmdArg('C:\\Program Files\\x'), '"C:\\Program Files\\x"')
  })

  it('cmd 元字符落在引号内，不再有命令拼接的语义', () => {
    // 目录名带 & 是真实存在的情况，不加引号 cmd 会把它当命令分隔符
    assert.equal(quoteCmdArg('D:\\work\\A&B'), '"D:\\work\\A&B"')
    assert.equal(quoteCmdArg('a|b'), '"a|b"')
    assert.equal(quoteCmdArg('a>b'), '"a>b"')
    assert.equal(quoteCmdArg('a^b'), '"a^b"')
  })

  it('内部引号按 cmd 的规矩翻倍', () => {
    assert.equal(quoteCmdArg('say "hi"'), '"say ""hi"""')
  })

  it('拒绝 % —— 引号内它照样展开成环境变量，没有可靠转义', () => {
    assert.throws(() => quoteCmdArg('%USERPROFILE%'), /无法安全传给 cmd\.exe/)
    assert.throws(() => quoteCmdArg('C:\\a%b\\c'), /无法安全传给 cmd\.exe/)
  })

  it('拒绝换行 —— 换行会把后半段变成第二条命令', () => {
    assert.throws(() => quoteCmdArg('a\nwhoami'), /无法安全传给 cmd\.exe/)
    assert.throws(() => quoteCmdArg('a\r\nwhoami'), /无法安全传给 cmd\.exe/)
  })
})

describe('spawnSpec —— 把命令翻译成 spawn 能安全接受的形式', () => {
  it('Windows 上 .bat 走 cmd.exe，且参数各自加引号', () => {
    const spec = spawnSpec('C:\\Tencent\\微信web开发者工具\\cli.bat', ['auto', '--project', 'D:\\my app'], { win: true })
    assert.match(spec.file, /cmd\.exe$/i)
    assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c'])
    // 最外层一对引号 + 内部每个参数一对，cmd /s 剥掉最外层后内部原样保留
    assert.equal(
      spec.args[3],
      '""C:\\Tencent\\微信web开发者工具\\cli.bat" "auto" "--project" "D:\\my app""'
    )
    // 没有 verbatim，Node 会再转义一轮，引号结构就被破坏了
    assert.equal(spec.opts.windowsVerbatimArguments, true)
  })

  it('POSIX 上同样的 cli 路径直接执行，不套 shell', () => {
    const spec = spawnSpec('/Applications/wechatwebdevtools.app/Contents/MacOS/cli', ['islogin'], { win: false })
    assert.equal(spec.file, '/Applications/wechatwebdevtools.app/Contents/MacOS/cli')
    assert.deepEqual(spec.args, ['islogin'])
    assert.equal(spec.opts.windowsVerbatimArguments, undefined)
  })

  it('项目路径含 % 时报错说清原因，而不是让参数被悄悄改写', () => {
    assert.throws(
      () => spawnSpec('C:\\x\\cli.bat', ['--project', 'D:\\100%done'], { win: true }),
      /无法安全传给 cmd\.exe/
    )
  })

  it('npm 走 JS 入口而不是 npm.cmd —— 这正是 Windows 上 EINVAL 的根因', () => {
    const spec = spawnSpec('npm', ['install'])
    if (findNpmCli()) {
      assert.equal(spec.file, process.execPath)
      assert.match(spec.args[0], /npm-cli\.js$/)
      assert.deepEqual(spec.args.slice(1), ['install'])
    }
  })

  it('npx <本地已装的 bin> 直接跑那个包的入口，绕开 npx 这一层', (t) => {
    const root = path.join(HOME, 'proj')
    const cli = path.join(root, 'node_modules/@vue/cli-service/bin/vue-cli-service.js')
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.writeFileSync(cli, '// stub')

    const spec = spawnSpec('npx', ['vue-cli-service', 'uni-build', '--watch'], { root })
    assert.equal(spec.file, process.execPath)
    assert.equal(spec.args[0], cli)
    assert.deepEqual(spec.args.slice(1), ['uni-build', '--watch'])
  })

  it('Windows 上没扩展名的裸命令补成 .cmd 再交给 cmd.exe', () => {
    const spec = spawnSpec('some-tool', ['--flag'], { win: true })
    assert.match(spec.file, /cmd\.exe$/i)
    assert.match(spec.args[3], /some-tool\.cmd/)
  })

  it('.js 入口一律用当前这个 node 跑（而不是碰运气找 PATH 里的 node）', () => {
    const spec = spawnSpec('/x/build.mjs', ['--prod'], { win: false })
    assert.equal(spec.file, process.execPath)
    assert.deepEqual(spec.args, ['/x/build.mjs', '--prod'])
  })
})

describe('channelFor —— 控制通道的地址', () => {
  it('POSIX 下是 0700 目录里的 socket 文件路径', () => {
    const addr = channelFor('abc123', { win: false })
    assert.ok(addr.endsWith(`${path.sep}abc123.sock`), addr)
    assert.ok(channelIsPath(addr))
  })

  it('Windows 下是 named pipe，且名字带足够长的随机串', () => {
    const addr = channelFor('abc123', { win: true })
    assert.match(addr, /^\\\\\.\\pipe\\wx-agent-abc123-[0-9a-f]{32}$/)
    // pipe 名不是文件系统路径，拿 fs.existsSync 探测只会得到假的 false
    assert.equal(channelIsPath(addr), false)
  })

  it('Windows 下重复调用返回同一个地址 —— 否则 CLI 和 daemon 用的名字对不上', () => {
    const a = channelFor('stable-key', { win: true })
    const b = channelFor('stable-key', { win: true })
    assert.equal(a, b)
  })

  it('不同项目拿到不同的 pipe（随机串不同，不只是 key 不同）', () => {
    const a = channelFor('proj-a', { win: true })
    const b = channelFor('proj-b', { win: true })
    assert.notEqual(a, b)
    assert.notEqual(a.split('-').pop(), b.split('-').pop())
  })

  it('清掉之后重新生成的名字不一样 —— 旧名字不能被复用', () => {
    const before = channelFor('recycled', { win: true })
    clearChannel(before, 'recycled', { win: true })
    const after = channelFor('recycled', { win: true })
    assert.notEqual(before, after)
  })

  it('指针文件里的内容被篡改成畸形值时不采信', () => {
    const key = 'tampered'
    channelFor(key, { win: true })
    const ptr = path.join(HOME, 'run', `${key}.pipe`)
    fs.writeFileSync(ptr, 'C:\\Windows\\System32\\evil.exe')
    const addr = channelFor(key, { win: true })
    assert.match(addr, /^\\\\\.\\pipe\\wx-agent-/)
  })
})
