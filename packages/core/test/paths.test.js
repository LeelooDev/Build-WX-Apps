import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { isInside, openAppendNoFollow, safeFileName, stateDir } from '../src/paths.js'

const HOME = path.join(os.tmpdir(), `wx-agent-paths-test-${process.pid}`)
process.env.WX_AGENT_HOME = HOME

after(() => fs.rmSync(HOME, { recursive: true, force: true }))

describe('safeFileName —— 拼进文件名的值必须先消毒', () => {
  it('挡住目录穿越', () => {
    assert.ok(!safeFileName('../../../etc/passwd').includes('/'))
    assert.ok(!safeFileName('../../../etc/passwd').includes('..'))
    assert.ok(!safeFileName('..\\..\\windows\\system32').includes('\\'))
  })

  it('不产生隐藏文件或像参数的名字', () => {
    assert.ok(!safeFileName('.bashrc').startsWith('.'))
    assert.ok(!safeFileName('--force').startsWith('-'))
  })

  it('保留正常名字和中文', () => {
    assert.equal(safeFileName('login-page'), 'login-page')
    assert.equal(safeFileName('登录页'), '登录页')
  })

  it('空值回退到默认名', () => {
    assert.equal(safeFileName('', 'shot'), 'shot')
    assert.equal(safeFileName('///', 'shot'), 'shot')
    assert.equal(safeFileName(undefined, 'shot'), 'shot')
  })
})

describe('isInside —— 目录边界判定', () => {
  const base = '/tmp/base'
  it('允许目录内的路径', () => {
    assert.equal(isInside(base, '/tmp/base/a/b.png'), true)
    assert.equal(isInside(base, base), true)
  })
  it('挡住 ../ 穿越', () => {
    assert.equal(isInside(base, '/tmp/base/../evil'), false)
    assert.equal(isInside(base, '/tmp/base/a/../../evil'), false)
  })
  it('不被同前缀的兄弟目录骗过（base 与 base-evil）', () => {
    assert.equal(isInside(base, '/tmp/base-evil/x'), false)
  })
})

describe('stateDir —— 运行时目录必须是用户私有的', () => {
  it('创建出来的目录权限是 0700', () => {
    const dir = stateDir('run')
    const mode = fs.statSync(dir).mode & 0o777
    assert.equal(mode, 0o700, `实际权限 ${mode.toString(8)}`)
    const baseMode = fs.statSync(HOME).mode & 0o777
    assert.equal(baseMode, 0o700, `根目录权限 ${baseMode.toString(8)}`)
  })

  it('不落在全局可写的 tmpdir 里', () => {
    // Linux 的 os.tmpdir() 是 /tmp（0777），把控制 socket 放那里等于对所有本地用户开放
    assert.ok(!isInside(os.tmpdir(), stateDir()) || process.env.WX_AGENT_HOME === HOME)
  })
})

describe('openAppendNoFollow —— 拒绝跟随 symlink', () => {
  it('正常文件可以追加写', () => {
    const f = path.join(stateDir('run'), 'normal.log')
    const fd = openAppendNoFollow(f)
    fs.writeSync(fd, 'hello')
    fs.closeSync(fd)
    assert.equal(fs.readFileSync(f, 'utf8'), 'hello')
  })

  it('目标是 symlink 时直接报错，而不是写进它指向的文件', () => {
    const dir = stateDir('run')
    const secret = path.join(dir, 'secret.txt')
    const link = path.join(dir, 'evil.log')
    fs.writeFileSync(secret, 'ORIGINAL')
    fs.symlinkSync(secret, link)

    assert.throws(() => openAppendNoFollow(link), /ELOOP|EMLINK|ENOTDIR/)
    // 关键：被指向的文件必须原封不动
    assert.equal(fs.readFileSync(secret, 'utf8'), 'ORIGINAL')
  })
})
