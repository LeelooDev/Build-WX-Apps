/**
 * 把 WXML 字符串解析成树，并压成给 AI 看的紧凑轮廓。
 *
 * 为什么不直接把原始 WXML 丢给模型：一屏页面的 WXML 动辄上万字符，
 * 里面绝大多数是 scoped 样式 hash（data-v-xxx）和布局容器，对"我要点哪个"毫无帮助。
 * 这里只保留结构骨架 + 可交互元素 + 能用来定位的 selector。
 */

const TOKEN_RE =
  /<(\/)?([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:=(?:"[^"]*"|'[^']*'|[^\s/>]+))?)*)\s*(\/)?>|([^<]+)/g
const ATTR_RE = /([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g

/** 天生可交互的标签 */
const INTERACTIVE_TAGS = new Set([
  'button',
  'input',
  'textarea',
  'switch',
  'slider',
  'checkbox',
  'radio',
  'picker',
  'picker-view',
  'navigator',
  'form',
  'label'
])

/** 纯布局噪声，轮廓里可以折叠 */
const LAYOUT_TAGS = new Set(['view', 'block', 'scroll-view', 'swiper', 'swiper-item'])

/** 解析属性串 */
function parseAttrs (raw) {
  const attrs = {}
  if (!raw) return attrs
  ATTR_RE.lastIndex = 0
  let m
  while ((m = ATTR_RE.exec(raw))) {
    const name = m[1]
    if (!name) continue
    attrs[name] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return attrs
}

/**
 * 取出可用于定位的 class。
 * 开发者工具返回的 wxml 里 class 是重复的（实测 `class="page page data-v-x data-v-x"`），
 * 且带 vue scoped 的 data-v-xxx，两者都要清掉。
 */
function meaningfulClasses (cls) {
  const seen = new Set()
  const out = []
  for (const c of String(cls || '').split(/\s+/)) {
    if (!c || /^data-v-[\da-f]+$/i.test(c) || seen.has(c)) continue
    seen.add(c)
    out.push(c)
  }
  return out
}

/**
 * 解析 uni-app 编译出的 data-event-opts —— 这是快照里信息密度最高的东西。
 *
 * 形如：
 *   "input,__set_model,,account,$event,"   → input 事件，双向绑定到 data.account
 *   "change,onToggle,$event"   → change 事件，调用 onToggle
 *   "tap,onSubmit,$event"                → 点击调用 onSubmit
 *
 * 有了它，AI 不用猜"哪个输入框是密码"，也不用猜"点这个按钮会发生什么"。
 */
export function parseEventOpts (raw) {
  if (!raw) return []
  return String(raw)
    .split(';')
    .map((seg) => seg.split(','))
    .filter((parts) => parts.length >= 2 && parts[0])
    .map((parts) => {
      const [event, handler, , maybeField] = parts
      const isModel = handler === '__set_model'
      return {
        event,
        handler: isModel ? null : handler,
        field: isModel ? maybeField || null : null
      }
    })
    .filter((e) => e.handler || e.field)
}

/**
 * @param {string} wxml
 * @returns {Array} 顶层节点数组，节点为 {tag, attrs, children, text}
 */
export function parseWxml (wxml) {
  const roots = []
  const stack = []
  TOKEN_RE.lastIndex = 0
  let m

  while ((m = TOKEN_RE.exec(String(wxml || '')))) {
    const [, closing, tag, attrRaw, selfClose, textChunk] = m

    if (textChunk != null) {
      const text = textChunk.replace(/\s+/g, ' ').trim()
      if (text && stack.length) {
        const top = stack[stack.length - 1]
        top.text = top.text ? `${top.text} ${text}` : text
      }
      continue
    }

    if (closing) {
      // 容错：遇到不匹配的闭合标签就一路弹到匹配为止
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i
          break
        }
      }
      continue
    }

    const node = { tag, attrs: parseAttrs(attrRaw), children: [], text: '' }
    if (stack.length) stack[stack.length - 1].children.push(node)
    else roots.push(node)
    if (!selfClose) stack.push(node)
  }

  return roots
}

/** 把一条事件绑定说成人话 */
export function describeEvent (e) {
  return e.field ? `绑定 data.${e.field}` : `${e.event} → ${e.handler}()`
}

/** 给节点算一个 automator 能用的 selector（只支持 #id / .class 这类简单形式） */
export function selectorFor (node) {
  const id = node.attrs.id
  if (id) return `#${id}`
  const classes = meaningfulClasses(node.attrs.class)
  if (classes.length) return `.${classes[0]}`
  return null
}

/** 该节点是否值得作为"可点/可输入"目标列出 */
export function isInteractive (node) {
  if (INTERACTIVE_TAGS.has(node.tag)) return true
  if (node.attrs.role === 'button') return true
  // 绑了事件的普通 view 也是可点的 —— 这是最常见的情况，光看标签名会漏掉一大半
  if (node.attrs['data-event-opts']) return true
  return Boolean(node.attrs['aria-role'] === 'button')
}

/**
 * 压成轮廓文本。
 * @param {Array} roots
 * @param {{maxDepth?:number, maxNodes?:number}} opts
 */
export function outline (roots, { maxDepth = 6, maxNodes = 120 } = {}) {
  const lines = []
  let count = 0

  const walk = (node, depth, prefix) => {
    if (count >= maxNodes || depth > maxDepth) return
    count++

    const classes = meaningfulClasses(node.attrs.class)
    const sel = selectorFor(node)
    const bits = [node.tag]
    if (node.attrs.id) bits.push(`#${node.attrs.id}`)
    if (classes.length) bits.push(`.${classes.slice(0, 2).join('.')}`)

    let line = prefix + bits.join('')
    if (node.text) line += `  "${node.text.slice(0, 40)}"`
    if (isInteractive(node)) {
      const kind = ['input', 'textarea'].includes(node.tag) ? '可输入' : '可点击'
      line += `   ⟨${kind}${sel ? ` ${sel}` : ' 无稳定selector'}⟩`
    }
    if (node.attrs.placeholder) line += `  placeholder="${node.attrs.placeholder}"`
    const events = parseEventOpts(node.attrs['data-event-opts'])
    if (events.length) line += `  → ${events.map(describeEvent).join(', ')}`
    lines.push(line)

    // 纯布局容器且只有一个孩子时不额外缩进，避免深度浪费在套娃 view 上
    const collapse = LAYOUT_TAGS.has(node.tag) && node.children.length === 1 && !node.text
    for (const child of node.children) {
      walk(child, collapse ? depth : depth + 1, collapse ? prefix : prefix + '  ')
    }
  }

  for (const r of roots) walk(r, 0, '')
  if (count >= maxNodes) lines.push(`… （已截断，共超过 ${maxNodes} 个节点）`)
  return lines.join('\n')
}

/**
 * 扁平列出所有可交互元素，供"我要点哪个"决策。
 *
 * 关键细节：同一个 class 常常对应多个元素（登录页两个输入框都是 .input-field）。
 * 只给出 `.input-field` 的话第二个输入框永远点不到，所以重复的一律带上 [n] 下标，
 * UI 层会用 $$ + 下标来定位。
 */
export function interactiveList (roots) {
  const raw = []
  const walk = (node) => {
    if (isInteractive(node)) {
      raw.push({
        tag: node.tag,
        base: selectorFor(node),
        text: node.text || null,
        placeholder: node.attrs.placeholder || null,
        type: node.attrs.type || null,
        disabled: node.attrs.disabled === 'true' || node.attrs['aria-disabled'] === 'true',
        events: parseEventOpts(node.attrs['data-event-opts'])
      })
    }
    node.children.forEach(walk)
  }
  roots.forEach(walk)

  const total = new Map()
  for (const r of raw) if (r.base) total.set(r.base, (total.get(r.base) ?? 0) + 1)

  const used = new Map()
  return raw.map((r) => {
    let selector = r.base
    if (r.base && total.get(r.base) > 1) {
      const i = used.get(r.base) ?? 0
      used.set(r.base, i + 1)
      selector = `${r.base}[${i}]`
    }
    const { base, ...rest } = r
    return { ...rest, selector }
  })
}
