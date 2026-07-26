import fs from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  DEFAULT_MAX_BYTES,
  WxAgent,
  analyzeSetData,
  detectProject,
  doctor,
  fmtBytes,
  initProject,
  renderArtifactStats,
  renderSetDataReport,
  renderSizeReport,
  summarize
} from 'wx-agent-core'

/**
 * wx-agent MCP server。
 *
 * 注意：stdio 传输下 **stdout 属于协议**，任何调试输出都必须走 stderr，
 * 否则会直接把 MCP 会话搞坏。
 */

const DEFAULT_DIR = process.env.WX_AGENT_PROJECT || process.cwd()
const DEFAULT_PORT = Number(process.env.WX_AGENT_PORT || 9420)

/** 按项目目录缓存 agent（MCP server 是常驻进程，会话和日志缓冲活在这里） */
const agents = new Map()

function agentFor (projectDir) {
  const dir = projectDir || DEFAULT_DIR
  const info = detectProject(dir)
  const key = info.root
  if (!agents.has(key)) agents.set(key, new WxAgent(info, { port: DEFAULT_PORT }))
  return agents.get(key)
}

async function connectedAgent (projectDir) {
  const agent = agentFor(projectDir)
  if (!agent.session) {
    await agent.connect()
    return agent
  }
  // 会话可能已经死了（开发者工具重启/切项目），探一下活；死了就重连
  try {
    await agent.session.page()
  } catch (err) {
    if (!WxAgent.isConnectionError(err)) throw err
    agent.resetSession()
    await agent.connect()
  }
  return agent
}

const text = (s) => ({ content: [{ type: 'text', text: String(s) }] })
const fail = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true })

const dirArg = { projectDir: z.string().optional().describe('小程序工程目录；省略则用服务启动时的目录。会自动向下寻找真正的工程根') }

export function createServer () {
  const server = new McpServer({ name: 'wx-agent', version: '0.1.0' })

  // ───────────────────────── 环境与工程 ─────────────────────────

  server.registerTool(
    'wx_doctor',
    {
      title: '小程序开发环境体检',
      description:
        '检查微信开发者工具是否安装/登录、工程类型、依赖、编译产物、sourcemap 是否就绪。' +
        '任何"连不上/跑不起来"的问题都先用它定位。',
      inputSchema: dirArg
    },
    async ({ projectDir }) => {
      const info = detectProject(projectDir || DEFAULT_DIR)
      const r = await doctor(info)
      const lines = [`工程：${info.root}`, `类型：${summarize(info)}`, '']
      for (const c of r.checks) {
        lines.push(`${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`)
        if (!c.ok && c.hint) lines.push(`   → ${c.hint}`)
      }
      return text(lines.join('\n'))
    }
  )

  server.registerTool(
    'wx_project_info',
    {
      title: '查看识别到的工程信息',
      description: '返回工程类型、源码目录、编译产物目录、sourcemap 目录、appid。',
      inputSchema: dirArg
    },
    async ({ projectDir }) => text(JSON.stringify(detectProject(projectDir || DEFAULT_DIR), null, 2))
  )

  server.registerTool(
    'wx_init',
    {
      title: '给 HBuilderX 版 uni-app 补上命令行编译能力',
      description:
        '当 wx_doctor 报"HBuilderX 模式，无法由命令行编译"时用它。' +
        '只新增文件（package.json / postcss.config.js / babel.config.js / .npmrc / .wx-agent/），' +
        '不改动目录结构，HBuilderX 仍可继续使用；可用 wxctl init --revert 完整回退。',
      inputSchema: {
        ...dirArg,
        dryRun: z.boolean().optional().describe('只列出会改动哪些文件，不实际写入'),
        force: z.boolean().optional().describe('覆盖已存在的 postcss/babel 配置'),
        install: z.boolean().optional().describe('是否顺带跑 npm install（默认 true，耗时约 1 分钟）')
      }
    },
    async ({ projectDir, dryRun, force, install }) => {
      const info = detectProject(projectDir || DEFAULT_DIR)
      const r = await initProject(info, { dryRun, force, install: install !== false })
      const lines = [r.ok ? '✅' : '❌', r.message ?? '']
      if (r.changes?.length) lines.push('', '改动：', ...r.changes.map((c) => `  ${c.kind} ${c.file}`))
      if (r.warnings?.length) lines.push('', ...r.warnings.map((w) => `⚠️ ${w}`))
      if (r.output && !r.ok) lines.push('', r.output.slice(-2000))
      return r.ok ? text(lines.join('\n')) : fail(lines.join('\n'))
    }
  )

  // ───────────────────────── 编译与运行 ─────────────────────────

  server.registerTool(
    'wx_run',
    {
      title: '把小程序跑起来',
      description:
        '一步完成：编译（产物已最新则跳过）→ 在微信开发者工具里打开 → 建立自动化连接。' +
        '这是所有观察和操作类工具的前置条件。之后就可以 wx_screenshot / wx_snapshot / wx_tap 了。' +
        '**幂等**：已经开着目标项目时会直接复用现有窗口，反复调用不会重复开窗口。',
      inputSchema: {
        ...dirArg,
        rebuild: z.boolean().optional().describe('强制重新编译，即使产物看起来是最新的'),
        watch: z.boolean().optional().describe('编译后保持 watch，改源码自动重编'),
        forceOpen: z
          .boolean()
          .optional()
          .describe('强制重启开发者工具。默认复用已开窗口，只在窗口状态确实坏掉时才用')
      }
    },
    async ({ projectDir, rebuild, watch, forceOpen }) => {
      const agent = agentFor(projectDir)
      const r = await agent.run({ rebuild, watch, forceOpen })
      if (!r.ok) return fail(`❌ ${r.message}\n${JSON.stringify(r.steps, null, 2)}`)
      const openStep = r.steps.find((s) => s.step === 'open')
      const how = openStep?.reused ? '（复用已开着的窗口）' : openStep?.switched ? '（原窗口开的是别的小程序，已切换）' : ''
      return text(
        [
          `✅ 已跑起来 ${how}`,
          `工程：${agent.info.root}`,
          `产物：${r.project}`,
          `当前页面：${r.page}`,
          '',
          '接下来可用：wx_snapshot 看页面结构、wx_screenshot 看画面、wx_logs / wx_errors 看日志'
        ].join('\n')
      )
    }
  )

  server.registerTool(
    'wx_compile',
    {
      title: '只编译，不打开',
      description: '重新编译小程序。编译失败时返回结构化的错误（已按根因去重，并列出受影响文件）。',
      inputSchema: { ...dirArg, watch: z.boolean().optional().describe('保持 watch 模式') }
    },
    async ({ projectDir, watch }) => {
      const agent = agentFor(projectDir)
      const r = await agent.compiler.build({ watch })
      if (r.ok) return text(`✅ 编译成功${r.watching ? '（watch 中）' : ''}`)
      const lines = [`❌ 编译失败：${r.message ?? ''}`]
      for (const e of r.errors ?? []) {
        lines.push('', e.message, `  影响 ${e.affected} 个文件：${e.files.join(', ')}`)
      }
      if (!r.errors?.length && r.output) lines.push('', r.output.slice(-2000))
      return fail(lines.join('\n'))
    }
  )

  // ───────────────────────── 观察 ─────────────────────────

  server.registerTool(
    'wx_screenshot',
    {
      title: '截取当前画面',
      description:
        '截取小程序模拟器当前画面并作为图片返回。' +
        '任何"改动是否生效""界面长什么样"的判断都应该以截图为准，不要凭代码猜。',
      inputSchema: {
        ...dirArg,
        savePath: z.string().optional().describe('另存到指定路径；省略则存到临时目录')
      }
    },
    async ({ projectDir, savePath }) => {
      const agent = await connectedAgent(projectDir)
      const shot = await agent.screenshot({ path: savePath })
      const data = fs.readFileSync(shot.path).toString('base64')
      return {
        content: [
          { type: 'image', data, mimeType: 'image/png' },
          { type: 'text', text: `已保存到 ${shot.path}（${Math.round(shot.bytes / 1024)} KB）` }
        ]
      }
    }
  )

  server.registerTool(
    'wx_snapshot',
    {
      title: '页面结构快照',
      description:
        '返回当前页面的结构轮廓、可交互元素清单（带可直接用于 wx_tap/wx_input 的 selector，' +
        '以及每个元素绑定的方法和数据字段）、页面运行时数据。' +
        '要点哪里、要填哪个框，先看这个，不要猜 selector。',
      inputSchema: {
        ...dirArg,
        raw: z.boolean().optional().describe('返回原始 WXML 而非压缩轮廓（很长，一般不需要）')
      }
    },
    async ({ projectDir, raw }) => {
      const agent = await connectedAgent(projectDir)
      const s = await agent.snapshot({ raw })
      if (raw) return text(`页面：${s.path}\n\n${s.wxml}`)

      const lines = [`页面：${s.path}`, '', '结构：', s.outline, '', '可操作元素：']
      for (const a of s.actions) {
        const bits = [`  ${a.selector ?? '(无 selector)'}`, a.tag]
        if (a.text) bits.push(`"${a.text}"`)
        if (a.placeholder) bits.push(`placeholder="${a.placeholder}"`)
        if (a.type && a.type !== 'text') bits.push(`type=${a.type}`)
        if (a.disabled) bits.push('[禁用]')
        if (a.events?.length) {
          bits.push('→ ' + a.events.map((e) => (e.field ? `data.${e.field}` : `${e.event}:${e.handler}()`)).join(' '))
        }
        lines.push(bits.join('  '))
      }
      lines.push('', '页面数据：', JSON.stringify(s.data, null, 2))
      return text(lines.join('\n'))
    }
  )

  server.registerTool(
    'wx_page_data',
    {
      title: '读页面运行时数据',
      description: '相当于在断点里看 this.data —— 判断状态对不对，比看界面更直接。',
      inputSchema: { ...dirArg, path: z.string().optional().describe('只取某个字段，如 "user.name"') }
    },
    async ({ projectDir, path }) => {
      const agent = await connectedAgent(projectDir)
      return text(JSON.stringify(await agent.ui.data(path), null, 2))
    }
  )

  server.registerTool(
    'wx_logs',
    {
      title: '看运行日志',
      description:
        'console.log/warn/error 的历史。注意：日志从本服务连上小程序那一刻起才开始收集，' +
        '所以要先 wx_run（或任意一次连接），再去触发行为，然后才看得到。',
      inputSchema: {
        ...dirArg,
        level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional(),
        keyword: z.string().optional().describe('只看包含该关键字的行'),
        limit: z.number().optional().describe('返回最近多少条，默认 50'),
        errorsOnly: z.boolean().optional().describe('只看错误级别')
      }
    },
    async ({ projectDir, level, keyword, limit, errorsOnly }) => {
      const agent = await connectedAgent(projectDir)
      const entries = agent.logs.query({ level, keyword, limit: limit ?? 50, errorsOnly })
      return text(entries.length ? agent.logs.render(entries) : '（这段时间没有日志）')
    }
  )

  server.registerTool(
    'wx_errors',
    {
      title: '看错误，并定位到源码',
      description:
        '返回运行时错误，并用 sourcemap 把堆栈映射回原始 .vue/.js 源码的行号，附带出错处的代码片段。' +
        '排查报错优先用它，而不是 wx_logs —— 它能直接告诉你是哪个文件哪一行。',
      inputSchema: { ...dirArg, limit: z.number().optional().describe('最多返回几条，默认 10') }
    },
    async ({ projectDir, limit }) => {
      const agent = await connectedAgent(projectDir)
      const errors = await agent.errors({ limit: limit ?? 10 })
      return text(WxAgent.renderErrors(errors))
    }
  )

  server.registerTool(
    'wx_record',
    {
      title: '连拍画面',
      description:
        '按固定间隔连续截图并合成 GIF，用于观察多步流程、动画、时序问题 —— 单张截图看不出这些。',
      inputSchema: {
        ...dirArg,
        count: z.number().optional().describe('帧数，默认 10'),
        interval: z.number().optional().describe('帧间隔毫秒，默认 500')
      }
    },
    async ({ projectDir, count, interval }) => {
      const agent = await connectedAgent(projectDir)
      const frames = await agent.capture.burst({ count: count ?? 10, interval: interval ?? 500 })
      const gif = await agent.capture.toGif(frames)
      return text(
        [`已抓 ${frames.length} 帧`, gif ? `GIF：${gif}` : '（未合成 GIF：没装 ffmpeg）', `帧目录：${frames[0]?.replace(/\/[^/]+$/, '')}`].join('\n')
      )
    }
  )

  // ───────────────────────── 操作 ─────────────────────────

  server.registerTool(
    'wx_tap',
    {
      title: '点击元素',
      description:
        'selector 用 wx_snapshot 给出的那个。同一个 class 有多个元素时用下标形式，如 ".input-field[1]"。',
      inputSchema: { ...dirArg, selector: z.string().describe('如 "#login-btn" / ".submit-btn" / ".item[2]"') }
    },
    async ({ projectDir, selector }) => {
      const agent = await connectedAgent(projectDir)
      await agent.ui.tap(selector)
      return text(`✅ 已点击 ${selector}`)
    }
  )

  server.registerTool(
    'wx_input',
    {
      title: '往输入框填值',
      description: '对 input / textarea 填入文本。selector 同样取自 wx_snapshot。',
      inputSchema: {
        ...dirArg,
        selector: z.string().describe('输入框的 selector'),
        value: z.string().describe('要填入的文本')
      }
    },
    async ({ projectDir, selector, value }) => {
      const agent = await connectedAgent(projectDir)
      await agent.ui.input(selector, value)
      return text(`✅ 已填入 ${selector} = ${JSON.stringify(value)}`)
    }
  )

  server.registerTool(
    'wx_trigger',
    {
      title: '触发任意事件',
      description: '给元素派发指定事件，用于自定义组件等 tap/input 覆盖不到的交互。',
      inputSchema: {
        ...dirArg,
        selector: z.string(),
        event: z.string().describe('事件名，如 change / confirm'),
        detail: z.record(z.any()).optional().describe('事件 detail 对象')
      }
    },
    async ({ projectDir, selector, event, detail }) => {
      const agent = await connectedAgent(projectDir)
      await agent.ui.trigger(selector, event, detail ?? {})
      return text(`✅ 已在 ${selector} 上触发 ${event}`)
    }
  )

  server.registerTool(
    'wx_navigate',
    {
      title: '页面跳转',
      description: '直接跳到指定页面，省去一路点过去。tabBar 页面必须用 switchTab。',
      inputSchema: {
        ...dirArg,
        url: z.string().describe('页面路径，如 "/pages/tree/index"'),
        kind: z.enum(['navigateTo', 'redirectTo', 'reLaunch', 'switchTab', 'navigateBack']).optional()
      }
    },
    async ({ projectDir, url, kind }) => {
      const agent = await connectedAgent(projectDir)
      const r = await agent.ui.navigate(url, kind ?? 'navigateTo')
      return text(`✅ 当前页面：${r.path}`)
    }
  )

  server.registerTool(
    'wx_wait',
    {
      title: '等待',
      description: '等待某个元素出现，或单纯等待若干毫秒。点击后界面需要时间响应时用。',
      inputSchema: {
        ...dirArg,
        selector: z.string().optional().describe('等这个元素出现'),
        ms: z.number().optional().describe('或者直接等这么多毫秒')
      }
    },
    async ({ projectDir, selector, ms }) => {
      const agent = await connectedAgent(projectDir)
      const r = await agent.ui.waitFor(selector ?? ms ?? 500)
      return text(`✅ ${JSON.stringify(r)}`)
    }
  )

  server.registerTool(
    'wx_call_method',
    {
      title: '直接调用页面方法',
      description:
        '绕过 UI 直接调页面上的方法（如 onSubmit）。比模拟一串点击更稳，适合跳过冗长的前置流程。',
      inputSchema: {
        ...dirArg,
        method: z.string().describe('页面方法名'),
        args: z.array(z.any()).optional().describe('参数数组')
      }
    },
    async ({ projectDir, method, args }) => {
      const agent = await connectedAgent(projectDir)
      const result = await agent.ui.callMethod(method, ...(args ?? []))
      return text(`✅ ${method}() → ${JSON.stringify(result ?? null)}`)
    }
  )

  server.registerTool(
    'wx_component',
    {
      title: '调试自定义组件',
      description:
        '读/改自定义组件**内部**的 data，或调用组件方法。页面级的 wx_page_data 看不到组件内部状态，' +
        '排查"组件不更新""props 没传进去""组件方法没生效"必须用这个。' +
        'selector 用 wx_snapshot 里那些自定义组件标签（如 uni-icons、kn-sheet）。',
      inputSchema: {
        ...dirArg,
        selector: z.string().describe('组件的 selector'),
        action: z.enum(['data', 'call', 'setData']).describe('data 读状态 / call 调方法 / setData 改状态'),
        path: z.string().optional().describe('action=data 时只取某个字段'),
        method: z.string().optional().describe('action=call 时的方法名'),
        args: z.array(z.any()).optional().describe('action=call 时的参数'),
        patch: z.record(z.any()).optional().describe('action=setData 时要设置的数据')
      }
    },
    async ({ projectDir, selector, action, path, method, args, patch }) => {
      const agent = await connectedAgent(projectDir)
      if (action === 'call') {
        if (!method) return fail('action=call 必须提供 method')
        const r = await agent.ui.componentCall(selector, method, ...(args ?? []))
        return text(`✅ ${selector}.${method}() → ${JSON.stringify(r ?? null)}`)
      }
      if (action === 'setData') {
        if (!patch) return fail('action=setData 必须提供 patch')
        await agent.ui.componentSetData(selector, patch)
        return text(`✅ 已设置 ${selector} 的 data`)
      }
      return text(JSON.stringify(await agent.ui.componentData(selector, path), null, 2))
    }
  )

  server.registerTool(
    'wx_element_box',
    {
      title: '元素尺寸与位置',
      description:
        '返回元素的宽高和在页面中的坐标。排查"点不到""被遮挡""高度是 0 所以看不见""布局错位"时用 —— ' +
        '光看截图判断不了元素实际占了多大。',
      inputSchema: { ...dirArg, selector: z.string() }
    },
    async ({ projectDir, selector }) => {
      const agent = await connectedAgent(projectDir)
      const b = await agent.ui.box(selector)
      const warn =
        b.size && (b.size.width === 0 || b.size.height === 0)
          ? '\n⚠️ 宽或高为 0 —— 元素实际不可见，多半是样式没生效或父容器没撑开'
          : ''
      return text(JSON.stringify(b, null, 2) + warn)
    }
  )

  server.registerTool(
    'wx_eval',
    {
      title: '在小程序里执行 JS',
      description:
        '在小程序运行环境中执行一段 JS 并返回结果（相当于调试器的 expression）。' +
        '代码只在目标小程序沙箱里跑。示例："return getCurrentPages().map(p => p.route)"',
      inputSchema: { ...dirArg, source: z.string().describe('JS 函数体，用 return 返回结果') }
    },
    async ({ projectDir, source }) => {
      const agent = await connectedAgent(projectDir)
      const result = await agent.ui.evaluate(source)
      return text(JSON.stringify(result ?? null, null, 2))
    }
  )

  // ───────────────────────── 性能与体积 ─────────────────────────

  server.registerTool(
    'wx_artifacts',
    {
      title: '截图产物的占用与清理',
      description:
        '查看截图/帧序列/GIF 占用了多少磁盘，或手动清理。' +
        `产物有容量上限（默认 ${Math.round(DEFAULT_MAX_BYTES / 1024 / 1024)}MB，可用环境变量 WX_AGENT_MAX_ARTIFACT_MB 调整），` +
        '超限时截图会自动回收最旧的文件，正常情况下不需要手动调用。',
      inputSchema: {
        ...dirArg,
        action: z
          .enum(['stats', 'sweep', 'clean'])
          .optional()
          .describe('stats 看占用（默认）/ sweep 回收超限部分 / clean 清空全部')
      }
    },
    async ({ projectDir, action }) => {
      const agent = agentFor(projectDir)
      if (action === 'clean' || action === 'sweep') {
        const r = agent.sweepArtifacts({ force: action === 'clean' })
        return text(
          `✅ 已${action === 'clean' ? '清空' : '回收'}：删除 ${r.removed} 个文件，释放 ${fmtBytes(r.freed)}\n` +
            `当前占用 ${fmtBytes(r.after)}`
        )
      }
      return text(renderArtifactStats(agent.artifactStats(), agent.maxArtifactBytes))
    }
  )

  server.registerTool(
    'wx_analyze_size',
    {
      title: '包体积分析',
      description:
        '分析编译产物体积，按主包/分包拆开并对照官方限制（主包 2MB、单个分包 2MB、合计 20MB），' +
        '列出最大的文件和按类型的占比。上传前自查、或遇到"包体积超限"时用。不需要先 wx_run。',
      inputSchema: dirArg
    },
    async ({ projectDir }) => {
      const agent = agentFor(projectDir)
      return text(renderSizeReport(agent.analyzeSize()))
    }
  )

  server.registerTool(
    'wx_setdata_monitor',
    {
      title: '监控 setData（小程序头号性能问题）',
      description:
        '劫持当前页面的 setData，统计调用频率、每次数据量、热点字段，并给出诊断。' +
        '用法：先 action="start"，然后去操作页面（滚动/点击/加载数据），再 action="report" 看结论。' +
        '页面卡顿、滚动掉帧、输入卡手时优先用它 —— 十有八九是 setData 的问题。',
      inputSchema: {
        ...dirArg,
        action: z.enum(['start', 'report', 'stop']).describe('start 开始监控，report 出报告，stop 停止')
      }
    },
    async ({ projectDir, action }) => {
      const agent = await connectedAgent(projectDir)
      if (action === 'start') {
        const r = await agent.perf.start()
        return r?.ok
          ? text(`✅ 已开始监控页面 ${r.route} 的 setData${r.already ? '（本来就在监控）' : ''}\n现在去操作页面，然后用 action="report" 看结果。`)
          : fail(`无法开始监控：${r?.reason ?? '未知原因'}`)
      }
      if (action === 'stop') {
        const r = await agent.perf.stop()
        return text(r?.ok ? `✅ 已停止监控 ${r.route}` : `（${r?.reason ?? '本来就没在监控'}）`)
      }
      const raw = await agent.perf.report()
      return text(renderSetDataReport(analyzeSetData(raw)))
    }
  )

  // ───────────────────────── 预览与发布 ─────────────────────────

  server.registerTool(
    'wx_preview',
    {
      title: '生成预览二维码',
      description:
        '编译并生成预览二维码，用户扫码即可在真机上看当前代码的效果。只影响本人，不影响线上。',
      inputSchema: {
        ...dirArg,
        qrOutput: z.string().optional().describe('二维码图片保存路径；省略则存到临时目录')
      }
    },
    async ({ projectDir, qrOutput }) => {
      const agent = agentFor(projectDir)
      const build = await agent.compiler.ensureBuilt()
      if (!build.ok) return fail(`编译失败，无法预览：${build.message}`)
      const out = qrOutput || `${agent.capture?.outDir ?? '/tmp'}/wx-preview-qr.png`
      const r = await agent.devtools.preview(agent.info.distDir, { qrOutput: out })
      if (!r.ok) return fail(`生成预览失败：\n${r.stdout}\n${r.stderr}`)
      return text(`✅ 预览二维码已生成：${out}\n${r.stdout}`)
    }
  )

  server.registerTool(
    'wx_upload',
    {
      title: '上传体验版',
      description:
        '把当前代码上传为小程序体验版。**这是对外可见的操作**：团队成员都会看到这个版本，' +
        '且会占用该 appid 的开发版本槽位。只有用户明确要求上传时才调用，且必须先向用户确认版本号和描述。',
      inputSchema: {
        ...dirArg,
        version: z.string().describe('版本号，如 "1.2.0"'),
        desc: z.string().describe('版本描述，说明这次改了什么')
      }
    },
    async ({ projectDir, version, desc }) => {
      const agent = agentFor(projectDir)
      const build = await agent.compiler.ensureBuilt()
      if (!build.ok) return fail(`编译失败，已中止上传：${build.message}`)
      const r = await agent.devtools.upload(agent.info.distDir, { version, desc })
      if (!r.ok) return fail(`上传失败：\n${r.stdout}\n${r.stderr}`)
      return text(`✅ 已上传体验版 ${version}\n${r.stdout}`)
    }
  )

  server.registerTool(
    'wx_mock_wx_method',
    {
      title: '打桩 wx API',
      description: '把某个 wx API 替换成固定返回值，用于让测试可控（如 mock wx.request、wx.login）。',
      inputSchema: {
        ...dirArg,
        method: z.string().describe('wx API 名，如 "getSystemInfoSync"'),
        result: z.any().describe('替换后的返回值')
      }
    },
    async ({ projectDir, method, result }) => {
      const agent = await connectedAgent(projectDir)
      await agent.ui.mockWxMethod(method, result)
      return text(`✅ 已打桩 wx.${method}`)
    }
  )

  return server
}
