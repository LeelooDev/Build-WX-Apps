import fs from 'node:fs'
import path from 'node:path'
import { exists, readJsonLoose } from './util.js'

/**
 * @typedef {'native'|'uniapp-hbuilderx'|'uniapp-cli'|'taro'|'unknown'} ProjectKind
 *
 * @typedef {Object} ProjectInfo
 * @property {string}      root         小程序工程根目录
 * @property {ProjectKind} kind
 * @property {string}      srcDir       源码目录（原生项目 = 小程序目录本身）
 * @property {string}      distDir      给微信开发者工具打开的目录
 * @property {string|null} sourcemapDir 编译产物 sourcemap 目录
 * @property {string|null} appid
 * @property {string|null} projectName
 * @property {string|null} vueVersion   uni-app 的 '2' / '3'
 * @property {boolean}     needsCompile 是否需要先编译才能给开发者工具
 * @property {string[]}    issues       探测到的问题（doctor 用）
 */

/** uni-app 编译产物的常见位置，按优先级 */
const UNI_DIST_CANDIDATES = [
  'unpackage/dist/dev/mp-weixin',
  'dist/dev/mp-weixin',
  'dist/build/mp-weixin'
]

/**
 * 探测小程序工程。
 * 先看 dir 本身，不像小程序工程就向下最多找 4 层
 * （monorepo 很常见：仓库根/frontend/xxx_mini 才是真正的小程序）。
 * @param {string} dir
 * @returns {ProjectInfo}
 */
export function detectProject (dir) {
  const start = path.resolve(dir)
  const found = looksLikeProject(start) ? start : searchDown(start, 4)
  if (!found) {
    return {
      root: start,
      kind: 'unknown',
      srcDir: start,
      distDir: start,
      sourcemapDir: null,
      appid: null,
      projectName: null,
      vueVersion: null,
      needsCompile: false,
      issues: ['没找到小程序工程：目录下既没有 app.json（原生），也没有 manifest.json + pages.json（uni-app），也不是 Taro 工程']
    }
  }
  return describe(found)
}

/** 该目录本身是否像个小程序工程 */
function looksLikeProject (dir) {
  return (
    (exists(path.join(dir, 'app.json')) && exists(path.join(dir, 'project.config.json'))) ||
    exists(path.join(dir, 'manifest.json')) ||
    exists(path.join(dir, 'src', 'manifest.json')) ||
    isTaro(dir)
  )
}

function isTaro (dir) {
  const pkg = readJsonLoose(path.join(dir, 'package.json'))
  if (!pkg) return false
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  return Object.keys(deps).some((d) => d.startsWith('@tarojs/'))
}

/** 广度优先向下找，跳过 node_modules / unpackage / dist 等噪声目录 */
function searchDown (root, maxDepth) {
  const skip = new Set(['node_modules', 'unpackage', 'dist', '.git', '.idea', '.vscode', 'build'])
  let level = [root]
  for (let depth = 0; depth < maxDepth && level.length; depth++) {
    const next = []
    for (const dir of level) {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (!e.isDirectory() || skip.has(e.name) || e.name.startsWith('.')) continue
        const child = path.join(dir, e.name)
        if (looksLikeProject(child)) return child
        next.push(child)
      }
    }
    level = next
  }
  return null
}

function describe (root) {
  const issues = []

  if (isTaro(root)) {
    const distDir = path.join(root, 'dist')
    return {
      root,
      kind: 'taro',
      srcDir: path.join(root, 'src'),
      distDir,
      sourcemapDir: null,
      appid: readJsonLoose(path.join(distDir, 'project.config.json'))?.appid ?? null,
      projectName: readJsonLoose(path.join(root, 'package.json'))?.name ?? null,
      vueVersion: null,
      needsCompile: true,
      issues
    }
  }

  // uni-app：manifest.json 在根或 src/
  const manifestAtRoot = exists(path.join(root, 'manifest.json'))
  const manifestAtSrc = exists(path.join(root, 'src', 'manifest.json'))
  if (manifestAtRoot || manifestAtSrc) {
    const srcDir = manifestAtSrc ? path.join(root, 'src') : root
    const manifest = readJsonLoose(path.join(srcDir, 'manifest.json'), {})
    const pkg = readJsonLoose(path.join(root, 'package.json'))
    const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {}
    const hasUniCli = Boolean(deps['@dcloudio/vue-cli-plugin-uni'] || deps['@dcloudio/vite-plugin-uni'])

    // 产物在 <...>/dist/dev/mp-weixin，sourcemap 是它的兄弟目录 <...>/dist/dev/.sourcemap/mp-weixin
    const distDir = resolveUniDist(root, pkg)
    const smDir = path.join(path.dirname(distDir), '.sourcemap', 'mp-weixin')

    if (!exists(path.join(srcDir, 'pages.json'))) {
      issues.push(`${path.relative(root, srcDir) || '.'} 下没有 pages.json，uni-app 工程不完整`)
    }
    if (!hasUniCli) {
      issues.push('这是 HBuilderX 模式的 uni-app 工程（没有 uni-app CLI 依赖），AI 无法自己触发编译；跑 `wxctl init` 可以在不改动目录结构的前提下补上 npm 编译能力')
    }

    return {
      root,
      kind: hasUniCli ? 'uniapp-cli' : 'uniapp-hbuilderx',
      srcDir,
      distDir,
      sourcemapDir: exists(smDir) ? smDir : null,
      appid: manifest?.['mp-weixin']?.appid ?? null,
      projectName: manifest?.name ?? pkg?.name ?? null,
      vueVersion: String(manifest?.vueVersion ?? '2'),
      needsCompile: true,
      issues
    }
  }

  // 原生小程序：app.json 可能被 miniprogramRoot 指到子目录
  const projectConfig = readJsonLoose(path.join(root, 'project.config.json'), {})
  const miniRoot = projectConfig.miniprogramRoot
    ? path.resolve(root, projectConfig.miniprogramRoot)
    : root
  return {
    root,
    kind: 'native',
    srcDir: miniRoot,
    distDir: miniRoot,
    sourcemapDir: null,
    appid: projectConfig.appid ?? null,
    projectName: projectConfig.projectname ?? null,
    vueVersion: null,
    needsCompile: false,
    issues
  }
}

/**
 * 确定 uni-app 产物目录。
 * 优先信 package.json 里 dev:mp-weixin 脚本显式写的 UNI_OUTPUT_DIR
 * （wxctl init 生成的脚本就会显式写），否则按惯例位置探。
 */
function resolveUniDist (root, pkg) {
  const script = pkg?.scripts?.['dev:mp-weixin'] ?? ''
  const m = script.match(/UNI_OUTPUT_DIR=(\S+)/)
  if (m) return path.resolve(root, m[1])

  for (const rel of UNI_DIST_CANDIDATES) {
    const p = path.join(root, rel)
    if (exists(path.join(p, 'app.json'))) return p
  }
  return path.join(root, UNI_DIST_CANDIDATES[0])
}

/** 产物是否已经编译出来了 */
export function distReady (info) {
  return exists(path.join(info.distDir, 'app.json'))
}

/** 人类可读的一行摘要 */
export function summarize (info) {
  const kindLabel = {
    native: '原生小程序',
    'uniapp-hbuilderx': 'uni-app（HBuilderX 模式）',
    'uniapp-cli': 'uni-app（CLI 模式）',
    taro: 'Taro',
    unknown: '未识别'
  }[info.kind]
  const vue = info.vueVersion ? ` Vue${info.vueVersion}` : ''
  return `${kindLabel}${vue}${info.appid ? ` · appid ${info.appid}` : ''}`
}
