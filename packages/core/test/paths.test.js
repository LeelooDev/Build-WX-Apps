import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { HAS_POSIX_PERMS, IS_WIN, isInside, openAppendNoFollow, safeFileName, stateDir } from '../src/paths.js'

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

  it('干掉 Windows 文件名里非法的字符', () => {
    for (const ch of [':', '?', '*', '"', '<', '>', '|']) {
      assert.ok(!safeFileName(`a${ch}b`).includes(ch), `${ch} 没被清掉`)
    }
  })

  it('避开 Windows 保留设备名 —— CON.png 这种名字写不出文件', () => {
    // 带扩展名也照样命中，所以不能只比对全等
    for (const name of ['CON', 'con', 'PRN', 'aux', 'NUL', 'COM1', 'lpt9']) {
      assert.notEqual(safeFileName(name).toLowerCase(), name.toLowerCase(), `${name} 未被规避`)
    }
    // 但只是加前缀而不是塌成 fallback，不同 label 仍然区分得开
    assert.notEqual(safeFileName('CON'), safeFileName('PRN'))
  })

  it('去掉结尾的点和空格 —— Windows 会静默吃掉它们，导致实际文件名对不上', () => {
    assert.ok(!safeFileName('report.').endsWith('.'))
    assert.ok(!safeFileName('report ').endsWith(' '))
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

  it('Windows 上大小写不同视为同一路径，合法写入不该被误判成越界', { skip: !IS_WIN }, () => {
    assert.equal(isInside('C:\\Base', 'c:\\base\\a.png'), true)
    // 折叠大小写不能顺带放宽边界
    assert.equal(isInside('C:\\Base', 'c:\\base-evil\\a.png'), false)
  })
})

describe('stateDir —— 运行时目录必须是用户私有的', () => {
  // Windows 上 chmod 只映射到只读属性，权限位形同虚设；
  // 那边的隔离来自 %USERPROFILE% 继承的 NTFS ACL，没法用 statSync 断言。
  it('创建出来的目录权限是 0700', { skip: !HAS_POSIX_PERMS }, () => {
    const dir = stateDir('run')
    const mode = fs.statSync(dir).mode & 0o777
    assert.equal(mode, 0o700, `实际权限 ${mode.toString(8)}`)
    const baseMode = fs.statSync(HOME).mode & 0o777
    assert.equal(baseMode, 0o700, `根目录权限 ${baseMode.toString(8)}`)
  })

  it('落在用户目录下，而不是全局可写的 tmpdir 里', () => {
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
    try {
      fs.symlinkSync(secret, link)
    } catch (err) {
      // Windows 上建 symlink 要特权，建不了就没什么可测的
      if (IS_WIN) return
      throw err
    }

    // POSIX 走 O_NOFOLLOW（内核报 ELOOP）；Windows 没这个 flag，走 lstat 预检，报我们自己的信息
    assert.throws(() => openAppendNoFollow(link), IS_WIN ? /符号链接/ : /ELOOP|EMLINK|ENOTDIR/)
    // 关键：被指向的文件必须原封不动
    assert.equal(fs.readFileSync(secret, 'utf8'), 'ORIGINAL')
  })
})
