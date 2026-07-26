/**
 * 小程序运行时性能观测。
 *
 * 小程序的头号性能杀手是 setData：逻辑层到渲染层的数据要走 JSON 序列化 + 跨线程通信，
 * 频繁调用或单次传大对象都会直接导致掉帧。但开发者工具没有现成的地方能看到
 * "这个页面到底调了多少次 setData、每次传了多大" —— 这里通过劫持当前页面实例的
 * setData 把它测出来。
 *
 * 劫持的是页面实例上的方法（不是框架原型），所以页面卸载后自动失效，不会污染全局。
 */

/** 注入监控。返回是否成功。 */
const INSTALL_SRC = `
  var pages = getCurrentPages();
  var page = pages[pages.length - 1];
  if (!page) return { ok: false, reason: '没有活动页面' };
  if (page.__wxAgentSetDataPatched) return { ok: true, already: true, route: page.route };

  var orig = page.setData.bind(page);
  page.__wxAgentSetDataStats = { count: 0, bytes: 0, startedAt: Date.now(), calls: [] };
  page.__wxAgentSetDataPatched = true;

  page.setData = function (data, cb) {
    var stats = page.__wxAgentSetDataStats;
    var size = 0;
    var keys = [];
    try {
      keys = Object.keys(data || {});
      size = JSON.stringify(data || {}).length;
    } catch (e) { /* 有循环引用就算了，不能因为测量把业务搞挂 */ }
    stats.count++;
    stats.bytes += size;
    // 只留最近 200 条，避免长时间监控把内存吃光
    stats.calls.push({ t: Date.now() - stats.startedAt, keys: keys, bytes: size });
    if (stats.calls.length > 200) stats.calls.shift();
    return orig(data, cb);
  };
  return { ok: true, route: page.route };
`

const REPORT_SRC = `
  var pages = getCurrentPages();
  var page = pages[pages.length - 1];
  if (!page || !page.__wxAgentSetDataStats) return { ok: false, reason: '当前页面没有在监控（可能已经跳过页或还没 start）' };
  var s = page.__wxAgentSetDataStats;
  return {
    ok: true,
    route: page.route,
    count: s.count,
    bytes: s.bytes,
    elapsedMs: Date.now() - s.startedAt,
    calls: s.calls
  };
`

const STOP_SRC = `
  var pages = getCurrentPages();
  var page = pages[pages.length - 1];
  if (!page || !page.__wxAgentSetDataPatched) return { ok: false, reason: '当前页面没有在监控' };
  delete page.__wxAgentSetDataPatched;
  delete page.__wxAgentSetDataStats;
  return { ok: true, route: page.route };
`

export class Perf {
  /** @param {import('./ui.js').UI} ui */
  constructor (ui) {
    this.ui = ui
  }

  /** 开始监控当前页面的 setData */
  start () {
    return this.ui.evaluate(INSTALL_SRC)
  }

  /** 取监控结果 */
  report () {
    return this.ui.evaluate(REPORT_SRC)
  }

  /** 停止并清理 */
  stop () {
    return this.ui.evaluate(STOP_SRC)
  }
}

/**
 * 把原始统计整理成结论。
 * 阈值是社区与官方性能指引里的经验值，不是硬性规定，但超过通常确实有问题。
 */
export function analyzeSetData (report) {
  if (!report?.ok) return { ok: false, message: report?.reason ?? '没有数据' }

  const { count, bytes, elapsedMs, calls, route } = report
  const seconds = Math.max(elapsedMs / 1000, 0.001)
  const perSecond = count / seconds
  const avgBytes = count ? bytes / count : 0

  // 按 key 组合聚合，找出最费的那类调用
  const byKeys = new Map()
  for (const c of calls) {
    const k = (c.keys ?? []).sort().join(',') || '(空)'
    const cur = byKeys.get(k) ?? { keys: k, count: 0, bytes: 0 }
    cur.count++
    cur.bytes += c.bytes
    byKeys.set(k, cur)
  }
  const hotspots = [...byKeys.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8)

  // 找连续 100ms 内的密集调用（这是掉帧的直接原因）
  let burst = 0
  for (let i = 1; i < calls.length; i++) {
    let j = i
    while (j < calls.length && calls[j].t - calls[i - 1].t <= 100) j++
    burst = Math.max(burst, j - i + 1)
  }

  const issues = []
  if (avgBytes > 64 * 1024) issues.push(`单次 setData 平均 ${Math.round(avgBytes / 1024)}KB，超过 64KB —— 每次都要跨线程序列化，考虑只传变化的字段`)
  if (perSecond > 20) issues.push(`setData 频率 ${perSecond.toFixed(1)} 次/秒，偏高 —— 考虑合并调用或加节流`)
  if (burst >= 10) issues.push(`存在 100ms 内连续 ${burst} 次 setData 的突发 —— 这是掉帧的典型原因`)
  const bigOne = hotspots.find((h) => h.bytes / h.count > 100 * 1024)
  if (bigOne) issues.push(`字段 [${bigOne.keys}] 单次平均 ${Math.round(bigOne.bytes / bigOne.count / 1024)}KB —— 长列表要用局部更新 this.setData({'list[3].x': v})，不要整个数组重设`)

  return {
    ok: true,
    route,
    count,
    totalBytes: bytes,
    elapsedMs,
    perSecond: Number(perSecond.toFixed(2)),
    avgBytes: Math.round(avgBytes),
    maxBurstIn100ms: burst,
    hotspots,
    issues
  }
}

/** 渲染报告 */
export function renderSetDataReport (a) {
  if (!a.ok) return `❌ ${a.message}`
  const kb = (b) => `${(b / 1024).toFixed(1)}KB`
  const lines = [
    `页面：${a.route}`,
    `监控 ${(a.elapsedMs / 1000).toFixed(1)}s，共 ${a.count} 次 setData，合计 ${kb(a.totalBytes)}`,
    `频率 ${a.perSecond} 次/秒 · 单次平均 ${kb(a.avgBytes)} · 100ms 内最多连续 ${a.maxBurstIn100ms} 次`
  ]
  if (a.hotspots?.length) {
    lines.push('', '按字段（数据量降序）：')
    for (const h of a.hotspots) {
      lines.push(`  ${kb(h.bytes).padStart(9)}  ${String(h.count).padStart(4)} 次  [${h.keys}]`)
    }
  }
  lines.push('', a.issues.length ? '发现的问题：' : '✅ 没有发现明显的 setData 问题')
  for (const i of a.issues) lines.push(`  ⚠️ ${i}`)
  return lines.join('\n')
}
