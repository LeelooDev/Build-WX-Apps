import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { sweep, stats } from '../src/artifacts.js'

const ROOT = path.join(os.tmpdir(), `wx-agent-artifacts-test-${process.pid}`)
const KB = 1024
const MB = 1024 * KB

function reset () {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(path.join(ROOT, 'proj-a'), { recursive: true })
}

/**
 * 造 n 个 sizeKB 的文件，mtime 从 ageMinutes 分钟前起逐个递增（序号越大越新）。
 * 回收策略依赖 mtime，所以必须显式设置，不能靠写入顺序。
 */
function seed (n, sizeKB, ageMinutes) {
  const buf = Buffer.alloc(sizeKB * KB, 1)
  for (let i = 0; i < n; i++) {
    const f = path.join(ROOT, 'proj-a', `shot-${String(i).padStart(3, '0')}.png`)
    fs.writeFileSync(f, buf)
    const t = (Date.now() - (ageMinutes - i) * 60 * 1000) / 1000
    fs.utimesSync(f, t, t)
  }
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

describe('产物回收', () => {
  it('没超上限时一个文件都不动', () => {
    reset()
    seed(20, 100, 120) // 2MB
    const r = sweep({ root: ROOT, maxBytes: 10 * MB })
    assert.equal(r.triggered, false)
    assert.equal(stats(ROOT).fileCount, 20)
  })

  it('超上限时回收到水位线以下，保留最新的', () => {
    reset()
    seed(100, 100, 300) // 10MB
    const r = sweep({ root: ROOT, maxBytes: 4 * MB })
    const after = stats(ROOT)

    assert.equal(r.triggered, true)
    assert.ok(after.bytes <= 2 * MB, `应降到 2MB 以下，实际 ${after.bytes}`)
    assert.ok(after.fileCount > 0, '不应该全部删光')

    const names = fs.readdirSync(path.join(ROOT, 'proj-a')).sort()
    assert.equal(names.at(-1), 'shot-099.png', '最新的文件必须保留')
    assert.ok(!names.includes('shot-000.png'), '最旧的文件应被删除')
  })

  it('保护期内刚产生的文件不删（它们的路径可能刚返回给调用方）', () => {
    reset()
    seed(100, 100, 0) // 全是"现在"
    sweep({ root: ROOT, maxBytes: 1 * MB })
    assert.equal(stats(ROOT).fileCount, 100)
  })

  it('force 清空全部', () => {
    reset()
    seed(50, 100, 0)
    const r = sweep({ root: ROOT, maxBytes: 100 * MB, force: true })
    assert.ok(r.removed >= 50)
    assert.ok(!fs.existsSync(ROOT) || stats(ROOT).fileCount === 0)
  })

  it('目录不存在时不报错', () => {
    fs.rmSync(ROOT, { recursive: true, force: true })
    const r = sweep({ root: ROOT, maxBytes: 1 * MB })
    assert.equal(r.removed, 0)
  })
})
