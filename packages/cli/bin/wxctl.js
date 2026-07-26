#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import {
  detectProject,
  doctor,
  fmtBytes,
  initProject,
  renderArtifactStats,
  renderSetDataReport,
  renderSizeReport,
  revertInit,
  WxAgent
} from 'wx-agent-core'
import { ensureDaemon, logPathFor, request, socketPathFor } from '../src/ipc.js'
import { startDaemon } from '../src/daemon.js'
import { render } from '../src/render.js'

const HELP = `wxctl —— 微信小程序开发的命令行控制器

用法：wxctl <命令> [参数] [选项]

环境与工程
  doctor  [dir]                环境体检：开发者工具、登录态、依赖、产物、sourcemap
  info    [dir]                看识别出的工程信息
  init    [dir]                给 HBuilderX 版 uni-app 补上命令行编译能力
          --dry-run              只看会改哪些文件，不写入
          --revert               撤销 init 的全部改动
          --force                覆盖已存在的 postcss/babel 配置
          --no-install           只生成文件，不跑 npm install

跑起来
  compile [dir] [--watch]      只编译
  run     [dir]                编译 → 在开发者工具里打开 → 连上
          --rebuild              强制重新编译
          --watch                编译后保持 watch（改源码自动重编）
          --no-open              不开开发者工具（假设已经开着）
          --force-open           强制重启开发者工具（默认复用已开着的窗口，不会重复开）
  connect [dir]                只连接已打开的项目
  stop    [dir]                关掉后台常驻进程

看
  screenshot [-o 文件]          截图
  snapshot   [--raw] [--no-text] 页面结构快照 + 可交互元素 + 页面数据
  data       [路径]             读页面运行时数据
  pagestack                    页面栈
  logs       [--tail N] [--level lv] [--grep 关键字] [--errors]
  errors     [--limit N]        错误，并把堆栈映射回 .vue 源码
  record     [--count N] [--interval ms] [--no-gif]   连拍并合成 GIF

性能与体积
  size    [dir]                包体积分析（主包/分包 vs 官方限制、最大文件）
  setdata <start|report|stop>  监控 setData：start → 操作页面 → report

产物管理（截图 / 帧序列 / GIF）
  artifacts [dir]              看占用了多少磁盘
  clean     [dir]              清空全部产物
            --auto               只回收超出上限的部分
  说明：默认上限 100MB，超限时截图会自动回收最旧的文件；
        改上限用环境变量 WX_AGENT_MAX_ARTIFACT_MB=200

操作
  tap     <selector>
  input   <selector> <值>
  trigger <selector> <事件>
  wait    <selector|毫秒>
  nav     <url> [--type navigateTo|redirectTo|reLaunch|switchTab|navigateBack]
  call    <方法名> [JSON参数...]
  eval    <js 源码>            在小程序 VM 里执行
  scroll  <y>
  component <selector> [data|call|setData] [参数]   读/改自定义组件内部状态、调组件方法
  box     <selector>           元素尺寸与位置（排查点不到 / 被遮挡 / 高度为 0）
  reload                       等一次重新编译完成并重新注入错误钩子

发布
  preview [dir] [-o 二维码路径]  生成真机预览二维码
  upload  --version 1.2.0 --desc "改了什么"   上传体验版（团队可见，谨慎）

通用选项
  --dir <路径>    指定工程目录（默认当前目录，会自动向下寻找小程序工程）
  --port <端口>   自动化端口（默认 9420）
  --json          输出原始 JSON，便于脚本/AI 解析
  --cli-path <路径>  微信开发者工具 cli 的位置（自动探测失败时用；
                     Windows 上是 cli.bat）。等价于环境变量 WX_DEVTOOLS_CLI
`

function parseArgs (argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const [k, inlineV] = a.slice(2).split('=')
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      if (inlineV !== undefined) flags[key] = inlineV
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[key] = argv[++i]
      else flags[key] = true
    } else if (a.startsWith('-') && a.length === 2) {
      const key = { o: 'output', d: 'dir', p: 'port', n: 'count' }[a[1]] ?? a[1]
      flags[key] = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true
    } else {
      positional.push(a)
    }
  }
  return { flags, positional }
}

function resolveDir (flags, positional, consumePositional = false) {
  if (flags.dir) return path.resolve(String(flags.dir))
  if (consumePositional && positional[0]) return path.resolve(positional[0])
  return process.cwd()
}

async function callDaemon (dir, port, cmd, args = {}) {
  const { sockPath } = await ensureDaemon(dir, { port })
  const res = await request(sockPath, { cmd, args })
  if (!res) throw new Error(`连不上 daemon（${sockPath}），日志见 ${logPathFor(dir)}`)
  if (!res.ok) throw new Error(res.error)
  return res.data
}

async function main () {
  const [, , rawCmd, ...rest] = process.argv
  const cmd = rawCmd ?? 'help'

  // 内部入口：由 ensureDaemon 拉起
  if (cmd === '__daemon') {
    const [dir, port, sock] = rest
    startDaemon(dir, Number(port), sock)
    return
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return
  }

  const { flags, positional } = parseArgs(rest)
  const port = Number(flags.port ?? 9420)
  const json = Boolean(flags.json)

  // --cli-path 走环境变量而不是逐层传参：daemon 是 spawn 出来的子进程，会继承环境，
  // 这样一处设置就同时覆盖直连模式和 daemon 模式（否则两条路径要各改一遍，必漏）。
  // Windows 上开发者工具的安装位置五花八门，这是唯一的逃生舱，不能形同虚设。
  if (typeof flags['cli-path'] === 'string') {
    process.env.WX_DEVTOOLS_CLI = path.resolve(flags['cli-path'])
  }
  const out = (kind, data) => console.log(json ? JSON.stringify(data, null, 2) : render(kind, data))

  switch (cmd) {
    case 'doctor': {
      const info = detectProject(resolveDir(flags, positional, true))
      out('doctor', { info, result: await doctor(info) })
      break
    }

    case 'info': {
      out('info', detectProject(resolveDir(flags, positional, true)))
      break
    }

    case 'init': {
      const info = detectProject(resolveDir(flags, positional, true))
      if (flags.revert) {
        out('init', revertInit(info))
        break
      }
      out('init', await initProject(info, {
        dryRun: Boolean(flags.dryRun),
        force: Boolean(flags.force),
        install: flags.install !== false && !flags.noInstall
      }))
      break
    }

    case 'compile': {
      const dir = resolveDir(flags, positional, true)
      const agent = WxAgent.create(dir, { port })
      const r = await agent.compiler.build({
        watch: Boolean(flags.watch),
        onOutput: flags.verbose ? (s) => process.stdout.write(s) : null
      })
      out('compile', r)
      if (!r.ok) process.exitCode = 1
      break
    }

    case 'run': {
      const dir = resolveDir(flags, positional, true)
      out('run', await callDaemon(dir, port, 'run', {
        rebuild: Boolean(flags.rebuild),
        watch: Boolean(flags.watch),
        open: !flags.noOpen,
        forceOpen: Boolean(flags.forceOpen)
      }))
      break
    }

    case 'connect':
      out('generic', await callDaemon(resolveDir(flags, positional, true), port, 'connect'))
      break

    case 'stop': {
      const dir = resolveDir(flags, positional, true)
      const res = await request(socketPathFor(dir), { cmd: 'shutdown' }).catch(() => null)
      console.log(res?.ok ? '已停止后台进程' : '后台进程本来就没在跑')
      break
    }

    case 'screenshot': {
      const dir = resolveDir(flags, positional)
      const target = flags.output ? path.resolve(String(flags.output)) : null
      out('screenshot', await callDaemon(dir, port, 'screenshot', { path: target }))
      break
    }

    case 'snapshot':
      out('snapshot', await callDaemon(resolveDir(flags, positional), port, 'snapshot', {
        raw: Boolean(flags.raw),
        withText: !flags.noText,
        maxNodes: flags.maxNodes ? Number(flags.maxNodes) : undefined
      }))
      break

    case 'tap':
      requireArg(positional[0], 'tap 需要一个 selector，例如 wxctl tap "#login-btn"')
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'tap', { selector: positional[0] }))
      break

    case 'longpress':
      requireArg(positional[0], 'longpress 需要一个 selector')
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'longpress', { selector: positional[0] }))
      break

    case 'input':
      requireArg(positional[0], 'input 需要 selector 和值，例如 wxctl input "#account" demo-user')
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'input', {
        selector: positional[0],
        value: positional.slice(1).join(' ')
      }))
      break

    case 'trigger':
      requireArg(positional[1], 'trigger 需要 selector 和事件名')
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'trigger', {
        selector: positional[0],
        event: positional[1],
        detail: positional[2] ? JSON.parse(positional[2]) : {}
      }))
      break

    case 'wait': {
      const arg = positional[0]
      requireArg(arg, 'wait 需要一个 selector 或毫秒数')
      const target = /^\d+$/.test(arg) ? Number(arg) : arg
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'wait', { target }))
      break
    }

    case 'nav':
      requireArg(positional[0], 'nav 需要目标页面路径')
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'nav', {
        url: positional[0],
        kind: flags.type ?? 'navigateTo'
      }))
      break

    case 'data':
      out('data', await callDaemon(resolveDir(flags, positional), port, 'data', { path: positional[0] }))
      break

    case 'pagestack':
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'pagestack'))
      break

    case 'call':
      requireArg(positional[0], 'call 需要方法名')
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'call', {
        method: positional[0],
        args: positional.slice(1).map(tryJson)
      }))
      break

    case 'eval':
      requireArg(positional[0], 'eval 需要一段 JS 源码')
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'eval', {
        source: positional.join(' ')
      }))
      break

    case 'scroll':
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'scroll', { y: Number(positional[0] ?? 0) }))
      break

    case 'logs':
      out('logs', await callDaemon(resolveDir(flags, positional), port, 'logs', {
        level: flags.level,
        keyword: flags.grep,
        limit: Number(flags.tail ?? 50),
        errorsOnly: Boolean(flags.errors)
      }))
      break

    case 'errors':
      out('errors', await callDaemon(resolveDir(flags, positional), port, 'errors', {
        limit: Number(flags.limit ?? 10)
      }))
      break

    case 'clearlogs':
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'clearlogs'))
      break

    case 'record':
      out('record', await callDaemon(resolveDir(flags, positional), port, 'record', {
        count: Number(flags.count ?? 10),
        interval: Number(flags.interval ?? 500),
        gif: !flags.noGif,
        fps: flags.fps ? Number(flags.fps) : undefined
      }))
      break

    case 'reload':
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'reload', {
        timeout: flags.timeout ? Number(flags.timeout) : undefined
      }))
      break

    case 'component': {
      const selector = positional[0]
      requireArg(selector, '用法：wxctl component <selector> [data|call|setData] [方法名/JSON]')
      const action = positional[1] ?? 'data'
      out('generic', await callDaemon(resolveDir(flags, positional), port, 'component', {
        selector,
        action,
        path: action === 'data' ? positional[2] : undefined,
        method: action === 'call' ? positional[2] : undefined,
        args: action === 'call' ? positional.slice(3).map(tryJson) : undefined,
        patch: action === 'setData' && positional[2] ? JSON.parse(positional[2]) : undefined
      }))
      break
    }

    case 'box': {
      requireArg(positional[0], 'box 需要一个 selector')
      const b = await callDaemon(resolveDir(flags, positional), port, 'box', { selector: positional[0] })
      if (json) console.log(JSON.stringify(b, null, 2))
      else {
        console.log(JSON.stringify(b, null, 2))
        if (b.size && (b.size.width === 0 || b.size.height === 0)) {
          console.log('⚠️ 宽或高为 0 —— 元素实际不可见，多半是样式没生效或父容器没撑开')
        }
      }
      break
    }

    case 'artifacts': {
      const agent = WxAgent.create(resolveDir(flags, positional, true), { port })
      const s = agent.artifactStats()
      console.log(json ? JSON.stringify(s, null, 2) : renderArtifactStats(s, agent.maxArtifactBytes))
      break
    }

    case 'clean': {
      const agent = WxAgent.create(resolveDir(flags, positional, true), { port })
      // 默认清空；--auto 只回收超出上限的部分
      const r = agent.sweepArtifacts({ force: !flags.auto })
      console.log(
        json
          ? JSON.stringify(r, null, 2)
          : `✅ 已${flags.auto ? '回收' : '清空'}：删除 ${r.removed} 个文件，释放 ${fmtBytes(r.freed)}，当前占用 ${fmtBytes(r.after)}`
      )
      break
    }

    case 'size': {
      const agent = WxAgent.create(resolveDir(flags, positional, true), { port })
      const r = agent.analyzeSize()
      console.log(json ? JSON.stringify(r, null, 2) : renderSizeReport(r))
      if (!r.ok) process.exitCode = 1
      break
    }

    case 'setdata': {
      const action = positional[0] ?? 'report'
      if (!['start', 'report', 'stop'].includes(action)) {
        console.error('用法：wxctl setdata <start|report|stop>')
        process.exitCode = 1
        break
      }
      const r = await callDaemon(resolveDir(flags, positional), port, 'setdata', { action })
      if (json) console.log(JSON.stringify(r, null, 2))
      else if (action === 'start') console.log(r?.ok ? `✅ 已开始监控 ${r.route} 的 setData，现在去操作页面，然后 wxctl setdata report` : `✖ ${r?.reason}`)
      else if (action === 'stop') console.log(r?.ok ? `✅ 已停止监控 ${r.route}` : `（${r?.reason ?? '本来就没在监控'}）`)
      else console.log(renderSetDataReport(r))
      break
    }

    case 'preview': {
      const agent = WxAgent.create(resolveDir(flags, positional, true), { port })
      const build = await agent.compiler.ensureBuilt()
      if (!build.ok) {
        console.error(`✖ 编译失败，无法预览：${build.message}`)
        process.exitCode = 1
        break
      }
      const qr = flags.output ? path.resolve(String(flags.output)) : path.join(process.cwd(), 'wx-preview-qr.png')
      const r = await agent.devtools.preview(agent.info.distDir, { qrOutput: qr })
      console.log(r.ok ? `✅ 预览二维码：${qr}\n${r.stdout}` : `✖ 生成预览失败：\n${r.stdout}\n${r.stderr}`)
      if (!r.ok) process.exitCode = 1
      break
    }

    case 'upload': {
      const version = flags.version ?? positional[0]
      const desc = flags.desc ?? positional[1] ?? ''
      requireArg(version, '上传体验版必须指定版本号：wxctl upload --version 1.2.0 --desc "改了什么"')
      const agent = WxAgent.create(resolveDir(flags, positional), { port })
      const build = await agent.compiler.ensureBuilt()
      if (!build.ok) {
        console.error(`✖ 编译失败，已中止上传：${build.message}`)
        process.exitCode = 1
        break
      }
      const r = await agent.devtools.upload(agent.info.distDir, { version, desc })
      console.log(r.ok ? `✅ 已上传体验版 ${version}\n${r.stdout}` : `✖ 上传失败：\n${r.stdout}\n${r.stderr}`)
      if (!r.ok) process.exitCode = 1
      break
    }

    default:
      console.error(`未知命令：${cmd}\n`)
      console.log(HELP)
      process.exitCode = 1
  }
}

function requireArg (v, msg) {
  if (v === undefined || v === null || v === '') {
    console.error(msg)
    process.exit(1)
  }
}

function tryJson (s) {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

main().catch((err) => {
  console.error(`✖ ${err?.message ?? err}`)
  process.exitCode = 1
})
