import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { exists, readJsonLoose, writeJson } from './util.js'
import { DevTools } from './devtools.js'
import {
  BABEL_CONFIG,
  BUILD_SCRIPT,
  NPMRC,
  POSTCSS_CONFIG,
  POSTINSTALL_PATCH,
  uniScripts,
  vue2Recipe
} from './recipes.js'

const AGENT_DIR = '.wx-agent'
const MANIFEST = 'init-manifest.json'

/**
 * 把 HBuilderX 模式的 uni-app 工程补成"命令行可编译"，同时**不改动目录结构**：
 * 源码留在原地，HBuilderX 照样能用，两套工具共存。
 *
 * 只做加法（新增文件 / 往 package.json 补字段），所有改动记在
 * .wx-agent/init-manifest.json 里，`wxctl init --revert` 可以完整撤销。
 */
export async function initProject (info, { dryRun = false, install = true, force = false } = {}) {
  const changes = []
  const warnings = []
  const root = info.root

  if (info.kind === 'native') {
    return { ok: true, skipped: true, message: '原生小程序不需要编译链，直接 `wxctl run` 即可', changes, warnings }
  }
  if (info.kind === 'taro') {
    return { ok: true, skipped: true, message: 'Taro 工程自带 npm 脚本，直接 `wxctl run` 即可', changes, warnings }
  }
  if (!info.kind.startsWith('uniapp')) {
    return { ok: false, message: `不支持的工程类型：${info.kind}`, changes, warnings }
  }
  if (String(info.vueVersion) === '3') {
    return {
      ok: false,
      message:
        'Vue3 的 uni-app 走 vite 工具链，与本配方（vue-cli + webpack4）完全不同，尚未验证。\n' +
        '欢迎提 issue，或先手动按官方 vite 模板补 package.json 再用 wxctl 的其余能力。',
      changes,
      warnings
    }
  }

  const recipe = vue2Recipe()
  const agentDir = path.join(root, AGENT_DIR)
  const plan = []

  // 1. 编译入口 + postinstall 补丁脚本
  plan.push({ file: path.join(agentDir, 'build.mjs'), content: BUILD_SCRIPT, kind: 'create' })
  plan.push({ file: path.join(agentDir, 'postinstall.mjs'), content: POSTINSTALL_PATCH, kind: 'create' })

  // 2. postcss / babel / npmrc —— 已存在就不动（除非 --force）
  for (const [name, content] of [
    ['postcss.config.js', POSTCSS_CONFIG],
    ['babel.config.js', BABEL_CONFIG]
  ]) {
    const file = path.join(root, name)
    if (exists(file) && !force) warnings.push(`${name} 已存在，保留原文件（要覆盖用 --force）`)
    else plan.push({ file, content, kind: exists(file) ? 'overwrite' : 'create' })
  }

  const npmrc = path.join(root, '.npmrc')
  if (exists(npmrc)) {
    const cur = fs.readFileSync(npmrc, 'utf8')
    if (!/legacy-peer-deps\s*=\s*true/.test(cur)) {
      plan.push({ file: npmrc, content: cur.trimEnd() + '\n' + NPMRC, kind: 'append' })
    }
  } else {
    plan.push({ file: npmrc, content: NPMRC, kind: 'create' })
  }

  // 3. package.json：只补不覆盖
  const pkgFile = path.join(root, 'package.json')
  const pkg = readJsonLoose(pkgFile) ?? {}
  const merged = mergePackage(pkg, recipe, info)
  plan.push({ file: pkgFile, json: merged, kind: exists(pkgFile) ? 'merge' : 'create' })

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      changes: plan.map((p) => ({ file: path.relative(root, p.file), kind: p.kind })),
      warnings,
      message: `将新增/修改 ${plan.length} 个文件（--dry-run，未实际写入）`
    }
  }

  // 4. 落盘，同时记录原始内容以便回退
  const manifest = { createdAt: new Date().toISOString(), files: [] }
  for (const step of plan) {
    const rel = path.relative(root, step.file)
    const existed = exists(step.file)
    manifest.files.push({
      path: rel,
      existed,
      backup: existed ? fs.readFileSync(step.file, 'utf8') : null
    })
    fs.mkdirSync(path.dirname(step.file), { recursive: true })
    if (step.json) writeJson(step.file, step.json)
    else fs.writeFileSync(step.file, step.content, 'utf8')
    changes.push({ file: rel, kind: step.kind })
  }
  writeJson(path.join(agentDir, MANIFEST), manifest)

  // 5. 装依赖（顺带触发 postinstall 打补丁）
  if (install) {
    const r = await runNpm(['install', '--no-audit', '--no-fund'], root)
    if (!r.ok) {
      return {
        ok: false,
        message: `npm install 失败：${r.message}`,
        output: r.output,
        changes,
        warnings
      }
    }
    changes.push({ file: 'node_modules', kind: 'install' })

    // postinstall 理论上已经跑过，保险起见再跑一次（幂等）
    await runNode([path.join(agentDir, 'postinstall.mjs')], root)
  }

  return {
    ok: true,
    changes,
    warnings,
    message: install
      ? '已补上 uni-app CLI 编译能力，现在可以 `wxctl run` 了（HBuilderX 仍可正常使用）'
      : '文件已生成，还需在项目目录跑一次 npm install'
  }
}

/** 撤销 init 的全部改动 */
export function revertInit (info) {
  const root = info.root
  const manifestFile = path.join(root, AGENT_DIR, MANIFEST)
  const manifest = readJsonLoose(manifestFile)
  if (!manifest) return { ok: false, message: '没找到 init 记录，无法自动回退' }

  const restored = []
  for (const f of manifest.files) {
    const abs = path.join(root, f.path)
    if (f.existed && f.backup != null) {
      fs.writeFileSync(abs, f.backup, 'utf8')
      restored.push({ file: f.path, kind: 'restored' })
    } else if (exists(abs)) {
      fs.rmSync(abs, { force: true })
      restored.push({ file: f.path, kind: 'removed' })
    }
  }
  fs.rmSync(path.join(root, AGENT_DIR), { recursive: true, force: true })
  return {
    ok: true,
    restored,
    message: '已回退；node_modules 未删除，需要的话手动 rm -rf'
  }
}

/** package.json 合并：已有的字段一律保留，只补缺的 */
function mergePackage (pkg, recipe, info) {
  const out = { ...pkg }
  out.name = out.name ?? (info.projectName ? slug(info.projectName) : 'miniprogram')
  out.version = out.version ?? '1.0.0'
  out.private = out.private ?? true

  out.scripts = { ...uniScripts(), ...out.scripts }
  // postinstall 必须是我们的（否则 recyclableRender 补丁不会生效）
  out.scripts.postinstall = uniScripts().postinstall

  out.dependencies = { ...recipe.dependencies, ...out.dependencies }
  out.devDependencies = { ...recipe.devDependencies, ...out.devDependencies }
  out.overrides = { ...recipe.overrides, ...out.overrides }
  out.browserslist = out.browserslist ?? ['Android >= 4.4', 'ios >= 9']
  return out
}

function slug (s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'miniprogram'
}

/**
 * 环境体检。跑任何东西之前先看这个，能省掉一半的"为什么连不上"。
 */
export async function doctor (info) {
  const checks = []
  const add = (name, ok, detail, hint = null) => checks.push({ name, ok, detail, hint })

  // Node
  const nodeMajor = Number(process.versions.node.split('.')[0])
  add('Node', nodeMajor >= 18, `v${process.versions.node}`, nodeMajor >= 18 ? null : '需要 Node 18.17+')

  // 开发者工具
  const dt = new DevTools()
  add(
    '微信开发者工具',
    dt.available,
    dt.cliPath ?? '未找到',
    dt.available ? null : '装了但路径不同的话，用 --cli-path 指定'
  )
  if (dt.available) {
    const login = await dt.isLogin()
    add('开发者工具登录态', login, login ? '已登录' : '未登录', login ? null : '打开开发者工具扫码登录')
  }

  // 工程
  add('工程类型', info.kind !== 'unknown', `${info.kind}${info.vueVersion ? ` (Vue${info.vueVersion})` : ''}`)
  add('appid', Boolean(info.appid), info.appid ?? '未配置', info.appid ? null : '没有 appid 只能用测试号')

  // 编译能力
  if (info.kind === 'uniapp-hbuilderx') {
    add('命令行编译', false, 'HBuilderX 模式，无法由命令行编译', '跑 `wxctl init` 补上')
  } else if (info.kind === 'uniapp-cli') {
    const nm = exists(path.join(info.root, 'node_modules'))
    add('依赖', nm, nm ? '已安装' : '缺 node_modules', nm ? null : '在项目目录跑 npm install')
    if (nm) {
      const patched = patchApplied(info.root)
      add(
        'recyclableRender 补丁',
        patched,
        patched ? '已生效' : '未生效',
        patched ? null : '跑 `node .wx-agent/postinstall.mjs`，否则编译会报 recyclableRender is not defined'
      )
    }
  }

  // 产物与 sourcemap
  const built = exists(path.join(info.distDir, 'app.json'))
  add('编译产物', built, built ? info.distDir : '尚未编译', built ? null : '跑 `wxctl compile`')
  add(
    'sourcemap',
    Boolean(info.sourcemapDir),
    info.sourcemapDir ?? '无',
    info.sourcemapDir ? null : '没有 sourcemap 时报错只能定位到编译产物行号'
  )

  return { ok: checks.every((c) => c.ok || c.hint === null), checks }
}

/** 补丁软链是否已生效 */
function patchApplied (root) {
  const link = path.join(
    root,
    'node_modules/@dcloudio/vue-cli-plugin-uni/packages/vue-loader/node_modules/@vue/component-compiler-utils'
  )
  return exists(link)
}

function runNpm (args, cwd) {
  return runCmd('npm', args, cwd)
}

function runNode (args, cwd) {
  return runCmd(process.execPath, args, cwd)
}

function runCmd (cmd, args, cwd, timeout = 900000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const timer = setTimeout(() => {
      p.kill('SIGTERM')
      resolve({ ok: false, message: '超时', output: buf.slice(-4000) })
    }, timeout)
    p.stdout.on('data', (c) => (buf += c))
    p.stderr.on('data', (c) => (buf += c))
    p.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, message: code === 0 ? 'ok' : `退出码 ${code}`, output: buf.slice(-4000) })
    })
    p.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, message: e.message, output: buf })
    })
  })
}
