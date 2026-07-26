import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { interactiveList, outline, parseEventOpts, parseWxml, selectorFor } from '../src/wxml.js'

/**
 * 这些样本取自微信开发者工具对 uni-app 产物的真实 wxml() 返回，
 * 包括它那个「class 会重复一遍」的怪行为 —— 不要"修正"成看起来更合理的样子。
 */
const FORM_WXML = `<view class="page page data-v-1a2b3c4d data-v-1a2b3c4d"><view class="form form data-v-1a2b3c4d data-v-1a2b3c4d"><input class="input-field input-field data-v-1a2b3c4d" data-event-opts="input,__set_model,,account,$event," placeholder="账号" type="text"/><input class="input-field input-field data-v-1a2b3c4d" data-event-opts="input,__set_model,,pwd,$event," placeholder="密码" type="password"/><button class="submit-btn submit-btn data-v-1a2b3c4d" data-event-opts="tap,onSubmit,$event" role="button" aria-disabled="false">提交</button></view></view>`

describe('WXML 解析', () => {
  it('解析出嵌套结构', () => {
    const roots = parseWxml(FORM_WXML)
    assert.equal(roots.length, 1)
    assert.equal(roots[0].tag, 'view')
    assert.equal(roots[0].children[0].tag, 'view')
    assert.equal(roots[0].children[0].children.length, 3)
  })

  it('去掉重复 class 和 scoped 的 data-v 哈希', () => {
    const roots = parseWxml(FORM_WXML)
    // 原始 class 是 "page page data-v-x data-v-x"，selector 只应保留 .page
    assert.equal(selectorFor(roots[0]), '.page')
  })

  it('从 data-event-opts 解析出双向绑定的字段', () => {
    const events = parseEventOpts('input,__set_model,,account,$event,')
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'input')
    assert.equal(events[0].field, 'account')
    assert.equal(events[0].handler, null)
  })

  it('从 data-event-opts 解析出事件处理函数', () => {
    const events = parseEventOpts('tap,onSubmit,$event')
    assert.equal(events[0].event, 'tap')
    assert.equal(events[0].handler, 'onSubmit')
    assert.equal(events[0].field, null)
  })

  it('空的 data-event-opts 不产生噪声', () => {
    assert.deepEqual(parseEventOpts(''), [])
    assert.deepEqual(parseEventOpts(undefined), [])
  })

  it('同名 class 的多个元素带上下标，否则第二个永远点不到', () => {
    const actions = interactiveList(parseWxml(FORM_WXML))
    const inputs = actions.filter((a) => a.tag === 'input')
    assert.equal(inputs.length, 2)
    assert.equal(inputs[0].selector, '.input-field[0]')
    assert.equal(inputs[1].selector, '.input-field[1]')
    // 唯一的 class 不加下标
    assert.equal(actions.find((a) => a.tag === 'button').selector, '.submit-btn')
  })

  it('可交互元素带出绑定信息，AI 才不用猜哪个框是密码', () => {
    const actions = interactiveList(parseWxml(FORM_WXML))
    const pwd = actions.find((a) => a.type === 'password')
    assert.ok(pwd, '应识别出密码输入框')
    assert.equal(pwd.events[0].field, 'pwd')

    const btn = actions.find((a) => a.tag === 'button')
    assert.equal(btn.text, '提交')
    assert.equal(btn.events[0].handler, 'onSubmit')
  })

  it('轮廓包含 selector 与绑定，且不含 data-v 噪声', () => {
    const text = outline(parseWxml(FORM_WXML))
    assert.ok(text.includes('.input-field'))
    assert.ok(text.includes('data.account'))
    assert.ok(text.includes('onSubmit()'))
    assert.ok(!text.includes('data-v-'), '轮廓里不该出现 scoped 哈希')
  })

  it('容错：标签没闭合也不该崩', () => {
    const roots = parseWxml('<view class="a"><text>hi</view>')
    assert.ok(Array.isArray(roots))
    assert.equal(roots[0].tag, 'view')
  })
})
