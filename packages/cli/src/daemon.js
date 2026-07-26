import { WxAgent, analyzeSetData, recentErrors, renderDevtoolsErrors } from 'wx-agent-core'
import { serve } from './ipc.js'

/**
 * 「端口通了但运行时是死的」的统一说法。
 *
 * 这种状态最会骗人：连接秒成功，然后每个调用都挂住。不点名的话，
 * 表象全都指向 wx-agent 自己有问题，而真因是开发者工具的模拟器没启动起来。
 */
function deadRuntimeHint (port) {
  return [
    `已连上自动化端口 ${port}，但小程序运行时没有响应 —— 端口在监听不代表小程序在跑。`,
    '通常是开发者工具的模拟器没真正启动。试：`wxctl run --force-open`。',
    renderDevtoolsErrors(recentErrors({ limit: 8 })) ?? ''
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * daemon 主体：持有一个 WxAgent 实例，把 CLI 发来的命令转成对它的调用。
 * 会话和日志缓冲都活在这个进程里，所以"先点击、后看日志"才拿得到东西。
 */
export function startDaemon (projectDir, port, sockPath) {
  const agent = WxAgent.create(projectDir, { port })

  /** 需要活动会话的命令，进来先确保连上 */
  const NEEDS_SESSION = new Set([
    'screenshot', 'snapshot', 'tap', 'longpress', 'input', 'trigger', 'wait',
    'nav', 'data', 'setpagedata', 'call', 'eval', 'logs', 'errors', 'record',
    'pagestack', 'scroll', 'mock', 'reload', 'sysinfo', 'setdata', 'component', 'box'
  ])

  const dispatch = async (cmd, args) => {
    switch (cmd) {
      case 'ping':
        return { pid: process.pid, project: agent.info.root, connected: Boolean(agent.session) }

      case 'info':
        return {
          summary: agent.summary,
          ...agent.info,
          connected: Boolean(agent.session)
        }

      case 'run':
        return agent.run({
          rebuild: args.rebuild,
          watch: args.watch,
          open: args.open !== false,
          forceOpen: args.forceOpen
        })

      case 'compile':
        return args.watch
          ? agent.compiler.build({ watch: true })
          : agent.compiler.build({ watch: false })

      case 'connect': {
        await agent.connect()
        const probe = await agent.session.probeRuntime()
        if (!probe.alive) {
          agent.resetSession()
          throw new Error(deadRuntimeHint(agent.port))
        }
        return { ok: true, port: agent.port, probeMs: probe.ms }
      }

      case 'sysinfo':
        return agent.session.systemInfo()

      case 'pagestack':
        return { stack: await agent.session.pageStack() }

      case 'screenshot':
        return agent.screenshot({ path: args.path, label: args.label })

      case 'snapshot':
        return agent.snapshot({ raw: args.raw, withText: args.withText !== false, maxNodes: args.maxNodes })

      case 'tap':
        return agent.ui.tap(args.selector)

      case 'longpress':
        return agent.ui.longPress(args.selector)

      case 'input':
        return agent.ui.input(args.selector, args.value)

      case 'trigger':
        return agent.ui.trigger(args.selector, args.event, args.detail)

      case 'wait':
        return agent.ui.waitFor(args.target, args.timeout)

      case 'nav':
        return agent.ui.navigate(args.url, args.kind)

      case 'data':
        return { data: await agent.ui.data(args.path) }

      case 'setpagedata':
        return agent.ui.setData(args.patch)

      case 'call':
        return { result: await agent.ui.callMethod(args.method, ...(args.args ?? [])) }

      case 'eval':
        return { result: await agent.ui.evaluate(args.source) }

      case 'mock':
        return agent.ui.mockWxMethod(args.method, args.result)

      case 'scroll':
        return agent.ui.scrollTo(args.y)

      case 'logs':
        return {
          entries: agent.logs.query({
            level: args.level,
            keyword: args.keyword,
            limit: args.limit ?? 50,
            errorsOnly: args.errorsOnly,
            since: args.since
          })
        }

      case 'errors':
        return { errors: await agent.errors({ limit: args.limit ?? 10, since: args.since }) }

      case 'clearlogs':
        agent.logs.clear()
        return { ok: true }

      case 'record': {
        const frames = await agent.capture.burst({
          interval: args.interval ?? 500,
          count: args.count ?? 10
        })
        const gif = args.gif === false ? null : await agent.capture.toGif(frames, { fps: args.fps ?? 4 })
        return { frames, gif, count: frames.length }
      }

      case 'reload':
        return agent.reload({ timeout: args.timeout })

      case 'setdata': {
        if (args.action === 'start') return agent.perf.start()
        if (args.action === 'stop') return agent.perf.stop()
        return analyzeSetData(await agent.perf.report())
      }

      case 'component': {
        if (args.action === 'call') {
          return { result: await agent.ui.componentCall(args.selector, args.method, ...(args.args ?? [])) }
        }
        if (args.action === 'setData') return agent.ui.componentSetData(args.selector, args.patch)
        return { data: await agent.ui.componentData(args.selector, args.path) }
      }

      case 'box':
        return agent.ui.box(args.selector)

      case 'shutdown':
        setTimeout(async () => {
          await agent.close()
          process.exit(0)
        }, 50)
        return { ok: true }

      default:
        throw new Error(`未知命令：${cmd}`)
    }
  }

  /**
   * 会话可能在两条命令之间就死了 —— 开发者工具重启、切换项目、用户手动关掉窗口，
   * 旧连接就会报 "Connection closed"。自动重连一次再重试，别把这个负担丢给用户。
   * 日志缓冲保留在 agent 上，重连不会丢掉已收集的历史。
   */
  const handler = async (cmd, args) => {
    if (NEEDS_SESSION.has(cmd) && !agent.session) {
      await agent.connect()
      // 新建连接后先探活。不探的话，「模拟器没启动」会伪装成一个个操作各自超时，
      // 每条命令都得等满超时才知道，而且谁都没说出真正的原因。
      const probe = await agent.session.probeRuntime()
      if (!probe.alive) {
        agent.resetSession()
        throw new Error(deadRuntimeHint(agent.port))
      }
    }
    try {
      return await dispatch(cmd, args)
    } catch (err) {
      if (!NEEDS_SESSION.has(cmd) || !WxAgent.isConnectionError(err)) throw err
      agent.resetSession()
      await agent.connect()
      return dispatch(cmd, args)
    }
  }

  serve(sockPath, handler)
  console.log(`[wx-agent] daemon 已启动 pid=${process.pid} project=${agent.info.root} port=${port}`)
}
