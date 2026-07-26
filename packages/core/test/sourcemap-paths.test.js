import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeSource } from '../src/sourcemap.js'

/**
 * sourcemap 里 source 的形态跟**打包时所在的平台**有关，不是跟运行时平台有关：
 * 在 Windows 上编出来的产物拿到 macOS 上分析（反之亦然）都是常见的。
 * 所以这两种形态都得认，不能靠 process.platform 分支。
 */
describe('normalizeSource —— 两种平台产出的 webpack 路径都要认', () => {
  it('uni-app:/// 前缀剥掉后就是相对项目根的路径', () => {
    assert.equal(normalizeSource('uni-app:///pages/login/login.vue', '/proj'), 'pages/login/login.vue')
  })

  it('POSIX 绝对路径（四斜杠）转成相对项目根', () => {
    assert.equal(
      normalizeSource('webpack:////Users/me/proj/pages/a.vue', '/Users/me/proj'),
      'pages/a.vue'
    )
  })

  it('Windows 绝对路径（三斜杠 + 盘符）同样转成相对项目根', () => {
    // 这是修掉的 bug：没有盘符特判时它会掉进「相对路径」分支，
    // 结果把 C:/Users/... 原样当成相对路径，拼出 <root>/C:/Users/... 这种鬼东西
    assert.equal(
      normalizeSource('webpack:///C:/Users/me/proj/pages/a.vue', 'C:/Users/me/proj'),
      'pages/a.vue'
    )
  })

  it('Windows 反斜杠形态也认，且结果统一成正斜杠', () => {
    const out = normalizeSource('webpack:///D:\\work\\proj\\pages\\a.vue', 'D:\\work\\proj')
    assert.equal(out, 'pages/a.vue')
    assert.ok(!out.includes('\\'), '输出里不该残留反斜杠')
  })

  it('盘符大小写不一致时仍能对上 —— Windows 路径本来就不区分大小写', () => {
    assert.equal(
      normalizeSource('webpack:///c:/Users/me/proj/pages/a.vue', 'C:/Users/me/proj'),
      'pages/a.vue'
    )
  })

  it('./ 开头的相对路径去掉前缀', () => {
    assert.equal(normalizeSource('webpack:///./pages/a.vue', '/proj'), 'pages/a.vue')
  })

  it('查询串（vue-loader 的 ?hash）一律丢掉', () => {
    assert.equal(normalizeSource('uni-app:///pages/a.vue?19d2', '/proj'), 'pages/a.vue')
  })

  it('没给项目根时保留绝对路径，不瞎猜', () => {
    assert.equal(normalizeSource('webpack:////Users/me/a.vue', null), '/Users/me/a.vue')
    assert.equal(normalizeSource('webpack:///C:/x/a.vue', null), 'C:/x/a.vue')
  })
})
