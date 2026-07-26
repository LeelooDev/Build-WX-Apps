import { parseWxml, outline, interactiveList, selectorFor } from './wxml.js'
import { defaultOpTimeout, isTimeout, withTimeout } from './timeout.js'

/** 页面根节点的候选 selector，按可靠性排序 */
const ROOT_CANDIDATES = ['page', 'body', '.page', 'view']

/**
 * page 级 API 卡死时给出的指路。
 *
 * 这不是假设，是实测：某些开发者工具/基础库组合下 automator 的 page 代理会整条通路
 * 无响应（`page.data()` / `page.$()` / `page.callMethod()` 全部不 settle），而同一条
 * 连接上 `mp.evaluate` / `mp.screenshot` 完全正常。既然 appservice 通路是好的，
 * 就把它指出来，而不是让调用方对着一个「超时」发呆。
 */
const EVAL_FALLBACK_HINT =
  'page 级 API 无响应（automator 已知问题：appservice 通路正常但 page 代理卡死）。\n' +
  '改走 eval 通常可以绕过 —— `wxctl eval` / MCP 的 wx_eval：\n' +
  "  原生小程序：getCurrentPages().pop().setData({ k: v })\n" +
  "  uni-app(Vue2)：getCurrentPages().pop().$vm.k = v; getCurrentPages().pop().$vm.someMethod()\n" +
  '  注意 uni-app 里 page.setData() 不会同步到 Vue 实例，必须改 $vm 上的字段。'

/**
 * 驱动运行中的小程序：看结构、点、输入、跳转、读写数据。
 * 所有方法都基于 Session 持有的 automator 实例。
 *
 * **所有 automator 调用都必须经过 `_t()`**（见 timeout.js 的说明）——
 * 裸调用一旦卡死就是无限挂起，没有任何东西能把它拉回来。
 */
export class UI {
  /**
   * @param {import('./session.js').Session} session
   * @param {{timeout?:number}} opts
   */
  constructor (session, { timeout = defaultOpTimeout() } = {}) {
    this.session = session
    this.timeout = timeout
  }

  get mp () {
    return this.session.mp
  }

  /** 给一次 automator 调用套超时；超时信息里带上 eval 降级指路 */
  _t (work, label, { ms = this.timeout, hint = EVAL_FALLBACK_HINT } = {}) {
    return withTimeout(work, { ms, label, hint })
  }

  /** 当前页面代理（这一步本身也可能卡死） */
  _page () {
    return this._t(() => this.mp.currentPage(), 'currentPage()')
  }

  /**
   * 页面结构快照 —— AI 决定"点哪里"的依据。
   * @param {{raw?:boolean, withText?:boolean, maxNodes?:number}} opts
   */
  async snapshot ({ raw = false, withText = true, maxNodes = 120 } = {}) {
    const page = await this._page()
    const wxml = await this._rootWxml(page)
    const data = await this._safe(() => page.data(), {}, 'page.data()')

    if (raw) return { path: page.path, wxml, data }

    const roots = parseWxml(wxml)
    let actions = interactiveList(roots)

    // wxml() 拿不到数据绑定后的文本节点，按需回查一遍（元素通常几十个，代价可接受）。
    // 单个元素的回查给短超时：这是锦上添花的信息，不值得为它把整个 snapshot 拖死。
    if (withText) {
      actions = await Promise.all(
        actions.map(async (a) => {
          if (a.text || !a.selector) return a
          const text = await this._safe(
            async () => {
              const el = await page.$(a.selector)
              return el ? await el.text() : null
            },
            null,
            `取 ${a.selector} 文本`,
            Math.min(this.timeout, 5000)
          )
          return { ...a, text: text ? String(text).trim().slice(0, 40) || null : null }
        })
      )
    }

    return {
      path: page.path,
      outline: outline(roots, { maxNodes }),
      actions,
      data,
      wxmlLength: wxml.length
    }
  }

  /** 尽力拿到页面根节点的 wxml */
  async _rootWxml (page) {
    let timedOut = false
    for (const sel of ROOT_CANDIDATES) {
      const wxml = await this._safe(
        async () => {
          const el = await page.$(sel)
          return el ? el.wxml() : null
        },
        null,
        `page.$('${sel}')`,
        undefined,
        () => { timedOut = true }
      )
      if (wxml) return wxml
      // 第一个候选就超时，说明整条 page 通路是死的，再试三次只是白等三倍时间
      if (timedOut) break
    }

    if (!timedOut) {
      // 全都不行就把所有顶层 view 拼起来
      const els = await this._safe(() => page.$$('view'), [], "page.$$('view')")
      const parts = []
      for (const el of els.slice(0, 5)) {
        const w = await this._safe(() => el.wxml(), null, 'el.wxml()')
        if (w) parts.push(w)
      }
      if (parts.length) return parts.join('\n')
    }

    if (timedOut) {
      throw new Error(`拿不到页面 WXML：${EVAL_FALLBACK_HINT}`)
    }
    throw new Error('拿不到页面 WXML：页面可能还没渲染完，或当前处于原生组件覆盖层')
  }

  /**
   * 跑一个可能失败的取值，失败/超时就返回兜底值。
   *
   * 相比原来的裸 try/catch，这里必须带超时 —— 「不 settle」不是异常，catch 拦不住。
   */
  async _safe (fn, fallback, label = '操作', ms = this.timeout, onTimeout = null) {
    try {
      return await withTimeout(fn, { ms, label, hint: EVAL_FALLBACK_HINT })
    } catch (err) {
      if (isTimeout(err) && onTimeout) onTimeout(err)
      return fallback
    }
  }

  /**
   * 按 selector 找元素。
   * 支持 `.input-field[1]` 这种下标形式 —— 同一个 class 对应多个元素时（登录页两个输入框
   * 都是 .input-field），没有下标就只能永远操作第一个。
   */
  async _el (selector) {
    const page = await this._page()
    const indexed = String(selector).match(/^(.*?)\[(\d+)\]$/)

    if (indexed) {
      const [, base, idxRaw] = indexed
      const idx = Number(idxRaw)
      const els = await this._t(() => page.$$(base), `page.$$('${base}')`)
      if (!els?.[idx]) {
        throw new Error(
          `${base} 只匹配到 ${els?.length ?? 0} 个元素，取不到下标 ${idx}（下标从 0 开始）。先跑 snapshot 看看。`
        )
      }
      return els[idx]
    }

    const el = await this._t(() => page.$(selector), `page.$('${selector}')`)
    if (!el) {
      throw new Error(
        `找不到元素 ${selector}。先跑一次 snapshot 看当前页面有哪些可交互元素；` +
          'automator 的 selector 只支持 #id / .class / 标签名这类简单形式，不支持复杂 CSS。'
      )
    }
    return el
  }

  async tap (selector) {
    const el = await this._el(selector)
    await this._t(() => el.tap(), `tap ${selector}`)
    return { ok: true, selector }
  }

  async longPress (selector) {
    const el = await this._el(selector)
    await this._t(() => el.longpress(), `longpress ${selector}`)
    return { ok: true, selector }
  }

  /** 往 input / textarea 里填值 */
  async input (selector, value) {
    const el = await this._el(selector)
    await this._t(() => el.input(String(value)), `input ${selector}`)
    return { ok: true, selector, value }
  }

  /** 触发任意事件，比如自定义组件的 change */
  async trigger (selector, event, detail = {}) {
    const el = await this._el(selector)
    await this._t(() => el.trigger(event, detail), `trigger ${selector} ${event}`)
    return { ok: true, selector, event }
  }

  /**
   * 等待。
   * @param {string|number|Function} target selector / 毫秒数 / 判定函数
   */
  async waitFor (target, timeout = 10000) {
    const page = await this._page()
    if (typeof target === 'number') {
      // 纯等待，超时上限给足：这里的「慢」是调用方自己要的
      await this._t(() => page.waitFor(target), `等待 ${target}ms`, { ms: target + this.timeout })
      return { ok: true, waited: target }
    }
    const started = Date.now()
    await this._t(() => page.waitFor(target), `等待 ${target}`, { ms: timeout })
    return { ok: true, waited: Date.now() - started }
  }

  /** 页面跳转 */
  async navigate (url, kind = 'navigateTo') {
    const fn = {
      navigateTo: 'navigateTo',
      redirectTo: 'redirectTo',
      reLaunch: 'reLaunch',
      switchTab: 'switchTab',
      navigateBack: 'navigateBack'
    }[kind]
    if (!fn) throw new Error(`不支持的跳转方式：${kind}`)
    if (fn === 'navigateBack') {
      await this._t(() => this.mp.navigateBack(), 'navigateBack')
    } else {
      await this._t(() => this.mp[fn](url), `${fn} ${url}`)
    }
    const page = await this._page()
    return { ok: true, path: page.path }
  }

  /** 读页面数据（相当于在断点里看 this.data） */
  async data (path = null) {
    const page = await this._page()
    return this._t(() => page.data(path ?? undefined), 'page.data()')
  }

  async setData (patch) {
    const page = await this._page()
    await this._t(() => page.setData(patch), 'page.setData()')
    return { ok: true }
  }

  /** 直接调页面上的方法（比 UI 点击更稳，适合跳过繁琐前置流程） */
  async callMethod (name, ...args) {
    const page = await this._page()
    return this._t(() => page.callMethod(name, ...args), `page.callMethod('${name}')`)
  }

  /**
   * 读自定义组件内部的 data。
   * 页面级的 wx_page_data 看不到组件内部状态 —— 组件有自己的 data 和 properties，
   * 排查"组件没更新/props 没传进去"必须看这里。
   */
  async componentData (selector, path = null) {
    const el = await this._el(selector)
    if (typeof el.data !== 'function') {
      throw new Error(`${selector} 不是自定义组件（原生元素没有 data）。用 wx_snapshot 确认这是不是组件标签。`)
    }
    return this._t(() => el.data(path ?? undefined), `${selector}.data()`)
  }

  /** 调自定义组件内部的方法 */
  async componentCall (selector, method, ...args) {
    const el = await this._el(selector)
    if (typeof el.callMethod !== 'function') {
      throw new Error(`${selector} 不是自定义组件，没有可调用的方法`)
    }
    return this._t(() => el.callMethod(method, ...args), `${selector}.${method}()`)
  }

  /** 改自定义组件内部的 data（用来直接构造某个状态，跳过触发流程） */
  async componentSetData (selector, patch) {
    const el = await this._el(selector)
    if (typeof el.setData !== 'function') {
      throw new Error(`${selector} 不是自定义组件`)
    }
    await this._t(() => el.setData(patch), `${selector}.setData()`)
    return { ok: true }
  }

  /** 元素的尺寸与位置 —— 排查"点不到""被遮住""高度为 0" */
  async box (selector) {
    const el = await this._el(selector)
    const [size, offset] = await Promise.all([
      this._safe(() => el.size(), null, `${selector}.size()`),
      this._safe(() => el.offset(), null, `${selector}.offset()`)
    ])
    return { selector, size, offset }
  }

  /**
   * 在**小程序 VM 里**执行一段 JS —— 相当于 lldb 的 expression。
   *
   * automator 的 evaluate 只取参数的 `.toString()` 当作函数声明发给小程序，
   * 所以字符串形式直接透传即可：本机进程不构造也不执行这段代码，
   * 它只在目标小程序的沙箱里跑（这正是本 API 的用途）。
   *
   * 这条是 page 通路卡死时的**降级出口**，所以它的超时提示不再指向自己。
   */
  async evaluate (fnOrSource, ...args) {
    const declaration =
      typeof fnOrSource === 'function' ? fnOrSource : `function () { ${fnOrSource} }`
    return this._t(() => this.mp.evaluate(declaration, ...args), 'evaluate()', {
      hint: '连 evaluate 都超时，说明小程序运行时整体无响应 —— 多半是模拟器没真正启动。跑 `wxctl run --force-open` 重开。'
    })
  }

  /** 打桩 wx API，让测试可控（比如把 wx.request 换成假数据） */
  async mockWxMethod (method, result) {
    return this._t(() => this.mp.mockWxMethod(method, result), `mockWxMethod('${method}')`)
  }

  async restoreWxMethod (method) {
    return this._t(() => this.mp.restoreWxMethod(method), `restoreWxMethod('${method}')`)
  }

  async scrollTo (y) {
    const page = await this._page()
    await this._t(() => page.setScrollTop(y), 'setScrollTop()')
    return { ok: true, scrollTop: y }
  }
}

export { selectorFor }
