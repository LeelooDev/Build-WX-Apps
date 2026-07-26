import { WxAgent } from 'wx-agent-core'

/** 把 daemon 返回的数据渲染成人和 AI 都好读的文本 */
export function render (kind, data) {
  switch (kind) {
    case 'doctor':
      return renderDoctor(data)
    case 'info':
      return renderInfo(data)
    case 'init':
      return renderInit(data)
    case 'compile':
      return renderCompile(data)
    case 'run':
      return renderRun(data)
    case 'screenshot':
      return renderScreenshot(data)
    case 'snapshot':
      return renderSnapshot(data)
    case 'logs':
      return renderLogs(data.entries)
    case 'errors':
      return WxAgent.renderErrors(data.errors)
    case 'data':
      return JSON.stringify(data.data, null, 2)
    case 'record':
      return renderRecord(data)
    default:
      return renderGeneric(data)
  }
}

function renderDoctor ({ info, result }) {
  const lines = [`工程：${info.root}`, `类型：${describeKind(info)}`, '']
  for (const c of result.checks) {
    lines.push(`${c.ok ? '✅' : '❌'} ${c.name.padEnd(22, '·')} ${c.detail}`)
    if (!c.ok && c.hint) lines.push(`     ↳ ${c.hint}`)
  }
  const bad = result.checks.filter((c) => !c.ok && c.hint)
  lines.push('')
  lines.push(bad.length ? `有 ${bad.length} 项需要处理（见上面 ↳）` : '一切就绪，可以 `wxctl run` 了')
  return lines.join('\n')
}

function renderInfo (info) {
  return [
    `类型      ${describeKind(info)}`,
    `工程根    ${info.root}`,
    `源码      ${info.srcDir}`,
    `产物      ${info.distDir}`,
    `sourcemap ${info.sourcemapDir ?? '无'}`,
    `appid     ${info.appid ?? '未配置'}`,
    `需要编译  ${info.needsCompile ? '是' : '否'}`,
    ...(info.issues?.length ? ['', ...info.issues.map((i) => `⚠️  ${i}`)] : [])
  ].join('\n')
}

function renderInit (r) {
  const lines = []
  if (r.dryRun) lines.push('（--dry-run，未实际写入）')
  if (r.changes?.length) {
    lines.push('改动：')
    for (const c of r.changes) lines.push(`  ${kindMark(c.kind)} ${c.file}`)
  }
  if (r.restored?.length) {
    lines.push('已回退：')
    for (const c of r.restored) lines.push(`  ${c.kind === 'restored' ? '↩' : '✗'} ${c.file}`)
  }
  if (r.warnings?.length) {
    lines.push('')
    for (const w of r.warnings) lines.push(`⚠️  ${w}`)
  }
  if (r.message) {
    lines.push('')
    lines.push(`${r.ok ? '✅' : '❌'} ${r.message}`)
  }
  // 装依赖失败但文件都写好了 —— 这句必须显眼，否则用户会以为得 --revert 重来
  if (r.resumeHint) lines.push('', r.resumeHint)
  if (r.output && !r.ok) lines.push(`\n${r.output}`)
  return lines.join('\n')
}

function renderScreenshot (r) {
  const lines = [`📸 ${r.path}  (${fmtBytes(r.bytes)})`]
  if (r.warning) {
    lines.push('', r.warning)
    if (r.canvas?.wxml?.length) lines.push(`  （canvas 出现在：${r.canvas.wxml.join('、')}）`)
  }
  return lines.join('\n')
}

function renderCompile (r) {
  if (r.ok) {
    return [
      `✅ 编译${r.cached ? '跳过（产物已是最新）' : '成功'}${r.watching ? '，watch 中' : ''}`,
      r.skipped ? `   ${r.message}` : null
    ]
      .filter(Boolean)
      .join('\n')
  }
  const lines = [`❌ 编译失败：${r.message ?? ''}`]
  if (r.errors?.length) {
    lines.push('')
    r.errors.forEach((e, i) => {
      lines.push(`[${i + 1}] ${e.message}`)
      const where = e.affected > e.files.length
        ? `${e.files.join(', ')} 等 ${e.affected} 个文件`
        : e.files.join(', ')
      lines.push(`    影响：${where}`)
      lines.push('')
    })
  } else if (r.output) {
    lines.push('', r.output.slice(-1500))
  }
  return lines.join('\n')
}

function renderRun (r) {
  if (!r.ok) return `❌ ${r.message}\n${(r.steps ?? []).map((s) => `  ${s.step}: ${s.ok ? 'ok' : s.message}`).join('\n')}`
  const lines = ['✅ 已跑起来']
  for (const s of r.steps ?? []) {
    if (s.step === 'compile') lines.push(`  编译  ${s.cached ? '跳过（已最新）' : s.skipped ? s.message : '完成'}`)
    if (s.step === 'open') {
      const how = s.reused ? '复用已开着的窗口' : s.switched ? '切换项目（原窗口开的是别的小程序）' : '新打开'
      lines.push(`  打开  ${how}  (自动化端口 ${s.port})`)
      lines.push(`        ${s.project}`)
    }
    if (s.step === 'connect') lines.push(`  连接  ok`)
    // 探活单独列出来：端口通不代表小程序在跑，这一步过了才算真的起来了
    if (s.step === 'probe') lines.push(`  探活  ${s.ok ? `运行时有响应 (${s.ms}ms)` : '无响应'}`)
  }
  lines.push('', `当前页面：${r.page}`)
  lines.push('接着可以：wxctl snapshot / wxctl screenshot / wxctl logs')
  return lines.join('\n')
}

function renderSnapshot (s) {
  if (s.wxml) return `页面：${s.path}\n\n${s.wxml}`
  const lines = [`页面：${s.path}   （WXML ${s.wxmlLength} 字符，已压缩为轮廓）`, '']
  lines.push('结构：')
  lines.push(indent(s.outline, 2))
  if (s.actions?.length) {
    lines.push('', '可操作元素：')
    for (const a of s.actions) {
      const bits = [`  ${a.selector ?? '(无 selector)'}`.padEnd(24), a.tag.padEnd(9)]
      if (a.text) bits.push(`"${a.text}"`)
      if (a.placeholder) bits.push(`placeholder="${a.placeholder}"`)
      if (a.type && a.type !== 'text') bits.push(`type=${a.type}`)
      if (a.disabled) bits.push('[禁用]')
      // 从 data-event-opts 解析出来的绑定，说明"点了会发生什么"
      if (a.events?.length) {
        bits.push('→ ' + a.events.map((e) => (e.field ? `data.${e.field}` : `${e.event}:${e.handler}()`)).join(' '))
      }
      lines.push(bits.join(' '))
    }
  }
  const keys = Object.keys(s.data ?? {}).filter((k) => !k.startsWith('$') && k !== 'vueId' && k !== 'vueSlots')
  if (keys.length) {
    lines.push('', '页面数据：')
    lines.push(indent(JSON.stringify(pick(s.data, keys), null, 2), 2))
  }
  return lines.join('\n')
}

function renderLogs (entries) {
  if (!entries?.length) return '（没有日志。注意：日志只从后台进程连上小程序那一刻起才开始收集）'
  return entries
    .map((e) => {
      const t = new Date(e.ts).toTimeString().slice(0, 8)
      const lv = e.level.toUpperCase().padEnd(6)
      return `${t} ${lv} ${e.text}`
    })
    .join('\n')
}

function renderRecord (r) {
  const lines = [`📷 抓了 ${r.count} 帧`]
  if (r.gif) lines.push(`🎞  GIF：${r.gif}`)
  else lines.push('（没合成 GIF：没装 ffmpeg 或被 --no-gif 关掉了）')
  if (r.frames?.length) lines.push(`帧目录：${r.frames[0].replace(/\/[^/]+$/, '')}`)
  return lines.join('\n')
}

function renderGeneric (data) {
  if (data == null) return 'ok'
  if (typeof data !== 'object') return String(data)
  if (data.ok && Object.keys(data).length <= 3) {
    const extra = Object.entries(data)
      .filter(([k]) => k !== 'ok')
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ')
    return `✅ ${extra}`.trim()
  }
  return JSON.stringify(data, null, 2)
}

function describeKind (info) {
  const label = {
    native: '原生小程序',
    'uniapp-hbuilderx': 'uni-app（HBuilderX 模式）',
    'uniapp-cli': 'uni-app（CLI 模式）',
    taro: 'Taro',
    unknown: '未识别'
  }[info.kind]
  return `${label}${info.vueVersion ? ` Vue${info.vueVersion}` : ''}${info.appid ? ` · ${info.appid}` : ''}`
}

function kindMark (kind) {
  return { create: '+', overwrite: '~', merge: '~', append: '»', install: '⬇' }[kind] ?? '·'
}

function pick (obj, keys) {
  const o = {}
  for (const k of keys) o[k] = obj[k]
  return o
}

function indent (text, n) {
  const pad = ' '.repeat(n)
  return String(text ?? '')
    .split('\n')
    .map((l) => pad + l)
    .join('\n')
}

function fmtBytes (b) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}
