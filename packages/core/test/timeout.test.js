import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OpTimeoutError, isTimeout, withTimeout } from '../src/timeout.js'

/**
 * 这些用例守的是一条实测教训：automator 的 page 级 API 会**不 resolve 也不 reject**。
 * try/catch 对「不 settle」完全无能为力，所以「永不 settle 的 promise 一定要被超时拦下」
 * 是这个模块存在的全部理由 —— 它退化了，整套工具就会重新变成无限挂起。
 */
describe('withTimeout', () => {
  it('正常完成时原样返回结果', async () => {
    assert.equal(await withTimeout(Promise.resolve(42), { ms: 1000 }), 42)
  })

  it('接受返回 promise 的函数', async () => {
    assert.equal(await withTimeout(() => Promise.resolve('x'), { ms: 1000 }), 'x')
  })

  it('永不 settle 的 promise 会被超时拦下', async () => {
    const never = new Promise(() => {})
    await assert.rejects(
      () => withTimeout(never, { ms: 30, label: 'page.data()' }),
      (err) => {
        assert.ok(isTimeout(err))
        assert.ok(err instanceof OpTimeoutError)
        assert.match(err.message, /page\.data\(\)/)
        assert.match(err.message, /30ms/)
        return true
      }
    )
  })

  it('超时信息里带上调用方给的降级指路', async () => {
    await assert.rejects(
      () => withTimeout(new Promise(() => {}), { ms: 20, label: 'x', hint: '改用 wx_eval' }),
      /改用 wx_eval/
    )
  })

  it('原始拒绝原样抛出，不会被伪装成超时', async () => {
    const boom = new Error('元素不存在')
    await assert.rejects(() => withTimeout(Promise.reject(boom), { ms: 1000 }), (err) => {
      assert.equal(err, boom)
      assert.equal(isTimeout(err), false)
      return true
    })
  })

  it('输掉竞争的 promise 之后才 reject 也不会变成 unhandledRejection', async () => {
    let sawUnhandled = null
    const onUnhandled = (err) => { sawUnhandled = err }
    process.on('unhandledRejection', onUnhandled)
    try {
      const late = new Promise((_, rej) => setTimeout(() => rej(new Error('迟到的失败')), 40))
      await assert.rejects(() => withTimeout(late, { ms: 10 }), isTimeout)
      // 给迟到的 rejection 足够时间冒出来
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(sawUnhandled, null, 'daemon 是常驻进程，一次未处理的 rejection 就会把它带崩')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('isTimeout 只认超时错误', () => {
    assert.equal(isTimeout(new Error('别的错')), false)
    assert.equal(isTimeout(new OpTimeoutError('x', 1)), true)
  })
})
