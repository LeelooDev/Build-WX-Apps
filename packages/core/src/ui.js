import { parseWxml, outline, interactiveList, selectorFor } from './wxml.js'

/** 页面根节点的候选 selector，按可靠性排序 */
const ROOT_CANDIDATES = ['page', 'body', '.page', 'view']

/**
 * 驱动运行中的小程序：看结构、点、输入、跳转、读写数据。
 * 所有方法都基于 Session 持有的 automator 实例。
 */
export class UI {
  /** @param {import('./session.js').Session} session */
  constructor (session) {
    this.session = session
  }

  get mp () {
    return this.session.mp
  }

  /**
   * 页面结构快照 —— AI 决定"点哪里"的依据。
   * @param {{raw?:boolean, withText?:boolean, maxNodes?:number}} opts
   */
  async snapshot ({ raw = false, withText = true, maxNodes = 120 } = {}) {
    const page = await this.mp.currentPage()
    const wxml = await this._rootWxml(page)
    const data = await safe(() => page.data(), {})

    if (raw) return { path: page.path, wxml, data }

    const roots = parseWxml(wxml)
    let actions = interactiveList(roots)

    // wxml() 拿不到数据绑定后的文本节点，按需回查一遍（元素通常几十个，代价可接受）
    if (withText) {
      actions = await Promise.all(
        actions.map(async (a) => {
          if (a.text || !a.selector) return a
          const text = await safe(async () => {
            const el = await page.$(a.selector)
            return el ? (await el.text()) : null
          }, null)
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
    for (const sel of ROOT_CANDIDATES) {
      const wxml = await safe(async () => {
        const el = await page.$(sel)
        return el ? el.wxml() : null
      }, null)
      if (wxml) return wxml
    }
    // 全都不行就把所有顶层 view 拼起来
    const els = await safe(() => page.$$('view'), [])
    const parts = []
    for (const el of els.slice(0, 5)) {
      const w = await safe(() => el.wxml(), null)
      if (w) parts.push(w)
    }
    if (!parts.length) throw new Error('拿不到页面 WXML：页面可能还没渲染完，或当前处于原生组件覆盖层')
    return parts.join('\n')
  }

  /**
   * 按 selector 找元素。
   * 支持 `.input-field[1]` 这种下标形式 —— 同一个 class 对应多个元素时（登录页两个输入框
   * 都是 .input-field），没有下标就只能永远操作第一个。
   */
  async _el (selector) {
    const page = await this.mp.currentPage()
    const indexed = String(selector).match(/^(.*?)\[(\d+)\]$/)

    if (indexed) {
      const [, base, idxRaw] = indexed
      const idx = Number(idxRaw)
      const els = await safe(() => page.$$(base), [])
      if (!els[idx]) {
        throw new Error(
          `${base} 只匹配到 ${els.length} 个元素，取不到下标 ${idx}（下标从 0 开始）。先跑 snapshot 看看。`
        )
      }
      return els[idx]
    }

    const el = await safe(() => page.$(selector), null)
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
    await el.tap()
    return { ok: true, selector }
  }

  async longPress (selector) {
    const el = await this._el(selector)
    await el.longpress()
    return { ok: true, selector }
  }

  /** 往 input / textarea 里填值 */
  async input (selector, value) {
    const el = await this._el(selector)
    await el.input(String(value))
    return { ok: true, selector, value }
  }

  /** 触发任意事件，比如自定义组件的 change */
  async trigger (selector, event, detail = {}) {
    const el = await this._el(selector)
    await el.trigger(event, detail)
    return { ok: true, selector, event }
  }

  /**
   * 等待。
   * @param {string|number|Function} target selector / 毫秒数 / 判定函数
   */
  async waitFor (target, timeout = 10000) {
    const page = await this.mp.currentPage()
    if (typeof target === 'number') {
      await page.waitFor(target)
      return { ok: true, waited: target }
    }
    const started = Date.now()
    await Promise.race([
      page.waitFor(target),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`等待 ${target} 超时（${timeout}ms）`)), timeout))
    ])
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
      await this.mp.navigateBack()
    } else {
      await this.mp[fn](url)
    }
    const page = await this.mp.currentPage()
    return { ok: true, path: page.path }
  }

  /** 读页面数据（相当于在断点里看 this.data） */
  async data (path = null) {
    const page = await this.mp.currentPage()
    return page.data(path ?? undefined)
  }

  async setData (patch) {
    const page = await this.mp.currentPage()
    await page.setData(patch)
    return { ok: true }
  }

  /** 直接调页面上的方法（比 UI 点击更稳，适合跳过繁琐前置流程） */
  async callMethod (name, ...args) {
    const page = await this.mp.currentPage()
    return page.callMethod(name, ...args)
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
    return el.data(path ?? undefined)
  }

  /** 调自定义组件内部的方法 */
  async componentCall (selector, method, ...args) {
    const el = await this._el(selector)
    if (typeof el.callMethod !== 'function') {
      throw new Error(`${selector} 不是自定义组件，没有可调用的方法`)
    }
    return el.callMethod(method, ...args)
  }

  /** 改自定义组件内部的 data（用来直接构造某个状态，跳过触发流程） */
  async componentSetData (selector, patch) {
    const el = await this._el(selector)
    if (typeof el.setData !== 'function') {
      throw new Error(`${selector} 不是自定义组件`)
    }
    await el.setData(patch)
    return { ok: true }
  }

  /** 元素的尺寸与位置 —— 排查"点不到""被遮住""高度为 0" */
  async box (selector) {
    const el = await this._el(selector)
    const [size, offset] = await Promise.all([
      safe(() => el.size(), null),
      safe(() => el.offset(), null)
    ])
    return { selector, size, offset }
  }

  /**
   * 在**小程序 VM 里**执行一段 JS —— 相当于 lldb 的 expression。
   *
   * automator 的 evaluate 只取参数的 `.toString()` 当作函数声明发给小程序，
   * 所以字符串形式直接透传即可：本机进程不构造也不执行这段代码，
   * 它只在目标小程序的沙箱里跑（这正是本 API 的用途）。
   */
  async evaluate (fnOrSource, ...args) {
    const declaration =
      typeof fnOrSource === 'function' ? fnOrSource : `function () { ${fnOrSource} }`
    return this.mp.evaluate(declaration, ...args)
  }

  /** 打桩 wx API，让测试可控（比如把 wx.request 换成假数据） */
  async mockWxMethod (method, result) {
    return this.mp.mockWxMethod(method, result)
  }

  async restoreWxMethod (method) {
    return this.mp.restoreWxMethod(method)
  }

  async scrollTo (y) {
    const page = await this.mp.currentPage()
    await page.setScrollTop(y)
    return { ok: true, scrollTop: y }
  }
}

/** 跑一个可能失败的取值，失败就返回兜底值 */
async function safe (fn, fallback) {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

export { selectorFor }
