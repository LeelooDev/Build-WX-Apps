import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { exists, readJsonLoose, writeJson } from './util.js'
import { DevTools } from './devtools.js'
import { IS_WIN, findNpmCli, spawnSpec } from './platform.js'
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
/**
 * @param {{dryRun?:boolean, install?:boolean, force?:boolean,
 *          installTimeout?:number, onProgress?:(msg:string)=>void}} opts
 */
export async function initProject (
  info,
  { dryRun = false, install = true, force = false, installTimeout = defaultInstallTimeout(), onProgress = null } = {}
) {
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
    onProgress?.(`开始安装依赖（超时 ${humanDuration(installTimeout)}）…`)
    const r = await runNpm(['install', '--no-audit', '--no-fund'], root, {
      timeout: installTimeout,
      onProgress
    })
    if (!r.ok) {
      // 关键：文件其实都已经写好了，只差依赖。不说清楚的话，用户会以为要 --revert 重来。
      return {
        ok: false,
        message: `npm install 失败：${r.message}`,
        resumable: true,
        resumeHint:
          `配置文件已全部写入（共 ${changes.length} 处），只差依赖。直接续上即可，不需要 --revert：\n` +
          `  cd ${root}\n` +
          '  npm install --no-audit --no-fund\n' +
          '  wxctl doctor\n' +
          (r.timedOut
            ? `提示：这套配方要装 1500+ 个包，npm 缓存冷的时候确实会慢。` +
              `加大超时用 \`wxctl init --install-timeout 3600\` 或 WX_AGENT_INSTALL_TIMEOUT=3600（单位秒）。`
            : ''),
        output: r.output,
        changes,
        warnings
      }
    }
    changes.push({ file: 'node_modules', kind: 'install' })

    // postinstall 理论上已经跑过，保险起见再跑一次（幂等）
    onProgress?.('打 recyclableRender 补丁…')
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

  if (IS_WIN) {
    // npm 的 JS 入口找不到时只能退回 npm.cmd，那条路要经 cmd.exe，更容易出岔子
    const npmCli = findNpmCli()
    add(
      'npm 入口',
      Boolean(npmCli),
      npmCli ?? '未找到 npm-cli.js，将退回 npm.cmd',
      npmCli ? null : '通常说明 Node 装得不完整，重装 Node 或用 nvm-windows 换个版本'
    )

    // 路径里的 % 会在 cmd.exe 传参时被当环境变量展开，没有可靠转义。
    // 不提前拦的话，用户会在 `wxctl run` 时收到一句莫名其妙的「找不到项目」。
    const pctPath = [info.root, new DevTools().cliPath].find((p) => p && p.includes('%'))
    add(
      '路径可传给 cmd.exe',
      !pctPath,
      pctPath ? `含 % 的路径：${pctPath}` : '正常',
      pctPath ? '把项目（或开发者工具）移到路径中不含 % 的目录 —— cmd.exe 会把 %xxx% 当环境变量展开' : null
    )

    // 长路径：Win32 API 默认上限 260 字符，node_modules 深目录很容易撞上
    const longish = info.root.length > 150
    add(
      '路径长度',
      !longish,
      `${info.root.length} 字符`,
      longish
        ? '项目路径偏深，npm install 可能因 260 字符上限失败。' +
          '要么把项目挪到靠近盘符根的位置，要么开启长路径支持（组策略或注册表 LongPathsEnabled=1）'
        : null
    )
  }

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

/**
 * npm install 的默认超时。
 *
 * 原来是 15 分钟，不够 —— 这套配方要装 1500+ 个包（vue-cli-service 4.5 + webpack4 +
 * sass 要编原生 + @dcloudio 全家桶）。实测：npm 缓存是冷的时候 15 分钟装不完，
 * 缓存热了之后同样的树只要 1 分钟。也就是说超时与否取决于用户机器上有没有缓存，
 * 而失败的代价是「文件都写好了却告诉你失败」，非常不划算。
 *
 * 可用 WX_AGENT_INSTALL_TIMEOUT（秒）或 `wxctl init --install-timeout <秒>` 覆盖。
 */
export function defaultInstallTimeout () {
  const raw = Number(process.env.WX_AGENT_INSTALL_TIMEOUT)
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 45 * 60 * 1000
}

/** 毫秒 → 人话。不足一分钟就说秒，别显示成「0 分钟」 */
function humanDuration (ms) {
  return ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60000)} 分钟`
}

function runNpm (args, cwd, opts) {
  return runCmd('npm', args, cwd, opts)
}

function runNode (args, cwd) {
  return runCmd(process.execPath, args, cwd)
}

/**
 * @param {{timeout?:number, onProgress?:(msg:string)=>void, heartbeat?:number}} opts
 *   onProgress：装包是长任务，不给信号的话调用方无法区分「在装」和「卡死」。
 *   实测那次跑满 15 分钟没有一个字输出，只能去 ps 看进程 —— 这不该是用户要做的事。
 */
function runCmd (cmd, args, cwd, { timeout = defaultInstallTimeout(), onProgress = null, heartbeat = 30000 } = {}) {
  return new Promise((resolve) => {
    // Windows 上 `npm` 解析成 npm.cmd，直接 spawn 会 EINVAL（Node ≥18.20）。
    // spawnSpec 改走 npm 的 JS 入口，顺带保证用的是当前这个 node。
    let spec
    try {
      spec = spawnSpec(cmd, args, { root: cwd })
    } catch (err) {
      return resolve({ ok: false, message: String(err.message), output: '' })
    }
    const p = spawn(spec.file, spec.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...spec.opts
    })
    let buf = ''
    const startedAt = Date.now()
    let lastLine = ''
    let timer = null
    let beat = null

    const finish = (r) => {
      clearTimeout(timer)
      if (beat) clearInterval(beat)
      resolve(r)
    }

    timer = setTimeout(() => {
      p.kill('SIGTERM')
      finish({
        ok: false,
        message: `超时（${Math.round(timeout / 1000)}s）`,
        timedOut: true,
        output: buf.slice(-4000)
      })
    }, timeout)

    // 心跳：装包期间每隔一会儿报一次「还活着」，附上 npm 最近一行输出。
    // 没有它的话，长任务和卡死在外部看来是同一回事。
    beat = onProgress
      ? setInterval(() => {
          const min = ((Date.now() - startedAt) / 60000).toFixed(1)
          onProgress(lastLine ? `… 仍在安装（已 ${min} 分钟）：${lastLine}` : `… 仍在安装（已 ${min} 分钟）`)
        }, heartbeat)
      : null
    beat?.unref?.()

    const take = (c) => {
      const s = String(c)
      buf += s
      const lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
      if (lines.length) lastLine = lines[lines.length - 1].slice(0, 120)
    }
    p.stdout.on('data', take)
    p.stderr.on('data', take)
    p.on('exit', (code) => {
      finish({ ok: code === 0, message: code === 0 ? 'ok' : `退出码 ${code}`, output: buf.slice(-4000) })
    })
    p.on('error', (e) => {
      finish({ ok: false, message: e.message, output: buf })
    })
  })
}
