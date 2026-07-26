import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { IS_WIN, stateDir } from './paths.js'

/**
 * 平台差异集中处。
 *
 * 这个项目要在 macOS / Windows / Linux 上都能跑，而 Windows 和 POSIX 的差别
 * 不是「换个路径分隔符」那么简单，有四处是**硬性不兼容**，散在各模块里改必然漏：
 *
 * 1. **控制通道**：Unix domain socket 在 Windows 上不存在，必须换 named pipe，
 *    而 named pipe 又没有文件权限，安全模型要跟着换（见 channelFor）。
 * 2. **跑 .cmd / .bat**：Node 修掉 CVE-2024-27980 之后（18.20.2+ / 20.12.2+），
 *    不带 shell 直接 spawn 批处理文件会抛 EINVAL。`npm` / `npx` / 微信开发者工具的
 *    `cli.bat` 全中招 —— 也就是说编译和开窗在 Windows 上是直接挂掉，不是「效果差一点」。
 * 3. **目录软链**：`fs.symlinkSync(..., 'dir')` 在 Windows 上需要管理员权限或开发者模式，
 *    普通用户会 EPERM。junction 不需要特权，是这里唯一可用的选项。
 * 4. **文件权限**：chmod / O_NOFOLLOW 在 Windows 上是空操作，只能靠用户 profile 的
 *    NTFS ACL 兜底。
 */

// IS_WIN 定义在 paths.js（最底层、零依赖），这里转出去方便统一从 platform 引用
export { IS_WIN }
export const IS_MAC = process.platform === 'darwin'

/* ------------------------------------------------------------------ *
 * 1. 控制通道（CLI ↔ daemon）
 * ------------------------------------------------------------------ */

/**
 * 为什么 Windows 上要在 pipe 名字里塞随机串：
 *
 * POSIX 那边 socket 是 `~/.wx-agent/run/<key>.sock`，目录 0700，别的本地用户连不上。
 * Windows 的 `\\.\pipe\` 是**全机器共享的扁平命名空间**，没有目录、没有权限位，
 * libuv 创建 pipe 时用默认安全描述符，同机器上的其他用户能连上来。
 * 而这个通道等同于无认证的控制接口：连上就能让 daemon 在小程序里执行任意 JS、
 * 往路径里写文件。
 *
 * 所以改成「名字本身就是凭据」：随机 16 字节，真名写在 `~/.wx-agent/run/<key>.pipe`
 * 这个受 NTFS ACL 保护的指针文件里。猜不到名字就连不上。
 */
function pipePointer (key) {
  return path.join(stateDir('run'), `${key}.pipe`)
}

const PIPE_NAME_RE = /^\\\\[.?]\\pipe\\wx-agent-[\w.-]+$/

/**
 * 取本项目的控制通道地址。同一个 key 反复调用会拿到同一个地址
 * （Windows 下靠指针文件保持稳定，否则 CLI 每次都算出新名字就永远连不上 daemon）。
 *
 * `win` 参数默认取当前平台。之所以做成可传入：Windows 分支要是只能在 Windows 上
 * 才跑得到，就等于没人验证过 —— 开发机在 macOS，CI 也未必有 Windows runner。
 * 显式传参让这套逻辑在任何平台都能被测到。
 *
 * @param {string} key 项目路径的短 hash
 * @param {{win?:boolean}} opts
 */
export function channelFor (key, { win = IS_WIN } = {}) {
  if (!win) return path.join(stateDir('run'), `${key}.sock`)

  const ptr = pipePointer(key)
  try {
    const existing = fs.readFileSync(ptr, 'utf8').trim()
    if (PIPE_NAME_RE.test(existing)) return existing
  } catch {
    /* 没有或读不动就重新生成 */
  }

  const name = `\\\\.\\pipe\\wx-agent-${key}-${crypto.randomBytes(16).toString('hex')}`
  fs.writeFileSync(ptr, name, { mode: 0o600 })
  return name
}

/**
 * 通道失效时把地址记录清掉，下次会重新生成 / 重新拉起 daemon。
 * POSIX 下要删的是 socket 文件本身；Windows 下 pipe 由内核在进程退出时回收，
 * 要删的是那个指针文件 —— 对 pipe 名字调 rmSync 只会报错。
 */
export function clearChannel (address, key = null, { win = IS_WIN } = {}) {
  try {
    if (win) {
      if (key) fs.rmSync(pipePointer(key), { force: true })
    } else {
      fs.rmSync(address, { force: true })
    }
  } catch {
    /* 清不掉不影响后续重建 */
  }
}

/**
 * 通道地址是不是「文件系统里的路径」——Windows 的 pipe 名不是，不能拿 fs 去探测。
 * 只看地址本身的形态，不看当前平台：地址是从 channelFor 拿来的，形态已经定了。
 */
export function channelIsPath (address) {
  return !String(address).startsWith('\\\\')
}

/* ------------------------------------------------------------------ *
 * 2. 跑外部命令
 * ------------------------------------------------------------------ */

/**
 * 把参数包成 cmd.exe 能安全接收的形式。
 *
 * `cmd /s /c "..."` 的规则：整串首尾是引号时剥掉最外层，内部原样交给解析器。
 * 于是每个参数各自加引号即可 —— 引号内 cmd 不再解析 `& | < > ^`，
 * 所以路径里有 `A&B` 这种目录也不会变成命令拼接。
 *
 * 但 `%VAR%` 在引号内**照样展开**，没有可靠的转义写法（`%%` 只在批处理文件里有效）。
 * 与其冒着参数被悄悄改写的风险，不如直接拒绝并说清楚原因。
 */
export function quoteCmdArg (a) {
  const s = String(a)
  if (/[%\r\n\0]/.test(s)) {
    throw new Error(
      `参数无法安全传给 cmd.exe（含 % 或换行）：${JSON.stringify(s)}\n` +
        '把项目移到路径中不含 % 的目录下，或用 --cli-path 指定不含 % 的路径。'
    )
  }
  return `"${s.replace(/"/g, '""')}"`
}

/**
 * 找 npm 的 JS 入口，绕开 npm.cmd。
 *
 * 直接 spawn `npm` 在 Windows 上会命中 .cmd 的 EINVAL；用 `shell: true` 又把
 * 参数交给 cmd 解析。既然 npm 本身就是个 node 脚本，最干净的做法是让当前
 * node 直接跑它 —— 顺带保证用的是跑我们的这个 node 版本。
 */
let npmCliCache
export function findNpmCli () {
  if (npmCliCache !== undefined) return npmCliCache

  const candidates = []
  // npm 执行 scripts 时会设这个变量，最准
  const fromEnv = process.env.npm_execpath
  if (fromEnv && fromEnv.endsWith('.js')) candidates.push(fromEnv)

  const nodeDir = path.dirname(process.execPath)
  // Windows：npm 与 node.exe 同级；POSIX：在 ../lib 下
  candidates.push(
    path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'),
    path.join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js'),
    path.join(nodeDir, '../npm/bin/npm-cli.js')
  )

  npmCliCache = candidates.find((p) => { try { return fs.statSync(p).isFile() } catch { return false } }) ?? null
  return npmCliCache
}

/** 项目本地 bin 的真实 JS 入口（避开 node_modules/.bin 下的 .cmd 包装） */
const KNOWN_LOCAL_BINS = {
  'vue-cli-service': ['@vue/cli-service/bin/vue-cli-service.js'],
  tsc: ['typescript/bin/tsc']
}

export function localBinScript (root, name) {
  for (const rel of KNOWN_LOCAL_BINS[name] ?? []) {
    const abs = path.join(root, 'node_modules', rel)
    try {
      if (fs.statSync(abs).isFile()) return abs
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

/**
 * 把「我想跑什么」翻译成 spawn 能直接接受的三元组。
 *
 * 调用方一律用这个而不是自己拼 spawn 参数，否则每加一处命令调用就要重新踩一遍
 * Windows 的 .cmd 坑。
 *
 * @param {string} cmd 命令名（`npm` / `npx` 特殊处理），或可执行文件的绝对路径
 * @param {string[]} args
 * @param {{root?:string, win?:boolean}} opts
 *   root = 项目根，用于查找本地 bin；win 默认当前平台，可传入以便在别的平台上测 Windows 分支
 * @returns {{file:string, args:string[], opts:object, describe:string}}
 */
export function spawnSpec (cmd, args = [], { root = null, win = IS_WIN } = {}) {
  const asNode = (script, rest) => ({
    file: process.execPath,
    args: [script, ...rest],
    opts: {},
    describe: `node ${path.basename(script)} ${rest.join(' ')}`
  })

  // npm：走它的 JS 入口
  if (cmd === 'npm') {
    const cli = findNpmCli()
    if (cli) return asNode(cli, args)
  }

  // npx <bin> ...：本地装了就直接跑那个包的入口，比起 npx 少一层进程也少一个坑
  if (cmd === 'npx' && root && args.length) {
    const [bin, ...rest] = args
    const script = localBinScript(root, bin)
    if (script) return asNode(script, rest)
    // 退回 `npm exec -- <bin> ...`（npm 的 JS 入口能跑，npx.cmd 不行）
    const cli = findNpmCli()
    if (cli) return asNode(cli, ['exec', '--', bin, ...rest])
  }

  // 显式的 .js 入口
  if (/\.(js|mjs|cjs)$/i.test(cmd)) return asNode(cmd, args)

  // 批处理文件：必须经 cmd.exe，且自己控制引号
  if (win && /\.(cmd|bat)$/i.test(cmd)) {
    const line = [cmd, ...args].map(quoteCmdArg).join(' ')
    return {
      file: process.env.ComSpec || 'cmd.exe',
      // /d 跳过 AutoRun 注册表项（别让用户机器上的 AutoRun 掺进来）
      // /s 配合最外层引号，让内部引号原样传递
      args: ['/d', '/s', '/c', `"${line}"`],
      opts: { windowsVerbatimArguments: true },
      describe: `${path.basename(cmd)} ${args.join(' ')}`
    }
  }

  // Windows 上裸命令名（如 npm 没找到 JS 入口时）补 .cmd 再走上面那条路
  if (win && !path.isAbsolute(cmd) && !path.extname(cmd)) {
    return spawnSpec(`${cmd}.cmd`, args, { root, win })
  }

  return { file: cmd, args, opts: {}, describe: `${cmd} ${args.join(' ')}` }
}

/* ------------------------------------------------------------------ *
 * 3. 目录链接
 * ------------------------------------------------------------------ */

/**
 * 建一条指向目录的链接。
 *
 * Windows 上用 junction：symlink 要 SeCreateSymbolicLinkPrivilege（管理员或开启开发者模式），
 * 普通用户会 EPERM，而 junction 任何用户都能建。代价是 junction 只接受**绝对路径**。
 *
 * @returns {'symlink'|'junction'|'copy'} 实际用的方式
 */
export function linkDir (target, link, { win = IS_WIN } = {}) {
  fs.mkdirSync(path.dirname(link), { recursive: true })
  try {
    fs.rmSync(link, { recursive: true, force: true })
  } catch {
    /* 不存在最好 */
  }

  if (win) {
    fs.symlinkSync(path.resolve(target), link, 'junction')
    return 'junction'
  }
  fs.symlinkSync(path.relative(path.dirname(link), target), link, 'dir')
  return 'symlink'
}

/* ------------------------------------------------------------------ *
 * 4. 平台说明
 * ------------------------------------------------------------------ */

/** 给 doctor / 报错信息用的平台描述 */
export function platformNote () {
  if (!IS_WIN) return null
  return (
    'Windows：控制通道用 named pipe（名字随机、真名存在 %USERPROFILE%\\.wx-agent\\run\\ 下），' +
    '权限依赖该目录的 NTFS ACL 而非 POSIX 权限位。'
  )
}
