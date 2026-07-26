import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { pageUsesCanvas } from '../src/canvas.js'

/**
 * 关键场景：canvas 往往**不在页面自己的 wxml 里**，而在它引用的自定义组件里
 * （实测那次就是 tree-panorama 组件）。只扫页面 wxml 会漏掉，
 * 于是截图照样不带警告 —— 也就等于这条修复没做。
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-agent-canvas-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

function write (rel, content) {
  const file = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

describe('页面 canvas 检测', () => {
  it('页面自己就有 canvas', () => {
    write('pages/draw/index.wxml', '<view><canvas id="c" type="2d"></canvas></view>')
    write('pages/draw/index.json', JSON.stringify({ usingComponents: {} }))
    const r = pageUsesCanvas(tmp, 'pages/draw/index')
    assert.equal(r.has, true)
  })

  it('canvas 藏在自定义组件里也要能查出来', () => {
    write('pages/tree/index.wxml', '<view><tree-panorama bind:select="onSelect"/></view>')
    write('pages/tree/index.json', JSON.stringify({
      usingComponents: { 'tree-panorama': '/components/tree-panorama/tree-panorama' }
    }))
    write('components/tree-panorama/tree-panorama.wxml', '<view class="pano"><canvas type="2d" id="kn-pano"/></view>')

    const r = pageUsesCanvas(tmp, 'pages/tree/index')
    assert.equal(r.has, true)
    assert.ok(r.files.some((f) => f.includes('tree-panorama')))
  })

  it('相对路径引用的组件也要解析对', () => {
    write('pages/me/index.wxml', '<view><chart/></view>')
    write('pages/me/index.json', JSON.stringify({ usingComponents: { chart: '../../components/chart/chart' } }))
    write('components/chart/chart.wxml', '<canvas canvas-id="c"/>')
    assert.equal(pageUsesCanvas(tmp, 'pages/me/index').has, true)
  })

  it('没有 canvas 就不报警，不能到处加噪音', () => {
    write('pages/plain/index.wxml', '<view><text>纯文本页</text></view>')
    write('pages/plain/index.json', JSON.stringify({ usingComponents: {} }))
    assert.equal(pageUsesCanvas(tmp, 'pages/plain/index').has, false)
  })

  it('组件循环引用不会把自己转死', () => {
    write('pages/loop/index.wxml', '<a-comp/>')
    write('pages/loop/index.json', JSON.stringify({ usingComponents: { 'a-comp': '/components/a/a' } }))
    write('components/a/a.wxml', '<b-comp/>')
    write('components/a/a.json', JSON.stringify({ usingComponents: { 'b-comp': '/components/b/b' } }))
    write('components/b/b.wxml', '<a-comp/><canvas/>')
    write('components/b/b.json', JSON.stringify({ usingComponents: { 'a-comp': '/components/a/a' } }))

    assert.equal(pageUsesCanvas(tmp, 'pages/loop/index').has, true)
  })

  it('产物不存在时安静返回 false，不抛错', () => {
    assert.equal(pageUsesCanvas(tmp, 'pages/nope/index').has, false)
    assert.equal(pageUsesCanvas(null, 'pages/x/y').has, false)
    assert.equal(pageUsesCanvas(tmp, null).has, false)
  })
})
