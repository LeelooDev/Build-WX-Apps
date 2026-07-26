/**
 * HBuilderX 工程 → 可命令行编译的 uni-app CLI 工程，所需的依赖配方。
 *
 * 这份清单不是照抄官方模板 —— 官方模板在 2026 年的依赖环境下**编译不过**
 * （已用官方 uni-preset-vue hello 模板做过对照实验，报同样的错）。
 * 下面每一条 EXTRA 都是实测踩出来的，注释写明了为什么。
 */

/** 已实测跑通的 dcloudio 版本；所有 @dcloudio 包必须同版本 */
export const DCLOUDIO_VUE2_VERSION = '2.0.2-5010520260709001'

/** Vue2（vue-cli + webpack4）配方 */
export function vue2Recipe (version = DCLOUDIO_VUE2_VERSION) {
  const d = (name) => [`@dcloudio/${name}`, version]

  return {
    dependencies: Object.fromEntries([
      d('uni-app'),
      // vue-cli-plugin-uni-optimize 会 require('@dcloudio/uni-h5/path')，
      // 即使只编小程序也必须装，否则启动即崩
      d('uni-h5'),
      d('uni-i18n'),
      d('uni-mp-vue'),
      d('uni-mp-weixin'),
      d('uni-stat'),
      ['core-js', '^3.8.3'],
      ['regenerator-runtime', '^0.12.1'],
      ['vue', '2.6.14']
    ]),
    devDependencies: Object.fromEntries([
      d('uni-automator'),
      // vue-cli-plugin-uni/lib/env.js 直接 require 它，但没在自己的 dependencies 里声明
      d('uni-cli-i18n'),
      d('uni-cli-shared'),
      d('uni-migration'),
      d('uni-template-compiler'),
      d('vue-cli-plugin-uni'),
      d('vue-cli-plugin-uni-optimize'),
      d('webpack-uni-mp-loader'),
      // 同上，error-reporting.js require 了但没声明
      d('webpack-uni-pages-loader'),
      ['@dcloudio/uni-helper-json', '^1.0.13'],
      // babel.config.js 在非 h5 平台会显式 push 这个插件
      ['@babel/plugin-transform-runtime', '^7.23.0'],
      ['@vue/cli-plugin-babel', '~4.5.19'],
      ['@vue/cli-service', '~4.5.19'],
      // autoprefixer 9 用了 postcss 8 已移除的 postcss.vendor，会抛
      // "Cannot read properties of undefined (reading 'unprefixed')"，必须上 10
      ['autoprefixer', '^10.4.16'],
      ['babel-plugin-import', '^1.11.0'],
      // 下面三个本该由 @vue/cli-service 带，但 legacy-peer-deps 下容易被 dedupe 掉，显式钉住
      ['cache-loader', '^4.1.0'],
      ['copy-webpack-plugin', '^6.4.1'],
      ['mini-css-extract-plugin', '^0.9.0'],
      ['cross-env', '^7.0.3'],
      ['postcss', '^8.4.31'],
      ['postcss-import', '^14.1.0'],
      ['postcss-loader', '^4.3.0'],
      ['sass', '^1.49.0'],
      ['sass-loader', '^8.0.2'],
      ['vue-template-compiler', '2.6.14'],
      // uni-app 的 webpack 插件用了 webpack4 才有的 lib/GraphHelpers，
      // 不钉住的话 webpack5 会被提升到顶层导致 MODULE_NOT_FOUND
      ['webpack', '^4.47.0']
    ]),
    /**
     * 新版 uni-app 的 postcss 插件要求 PostCSS 8，
     * 而 @vue/cli-service 4.5 整条 CSS 链（含它自带的 postcss-loader@3）锁在 PostCSS 7。
     * PostCSS 8 能跑 7 的插件，反过来不行，所以整树强制到 8。
     */
    overrides: { postcss: '^8.4.31' }
  }
}

/**
 * postcss.config.js 内容。
 *
 * 与官方模板的唯一差异：去掉 `parser: require('postcss-comment')`。
 * postcss-comment 最高只有 2.0.0 且锁死 postcss@^6，在 postcss 8 下会抛
 * "Class constructor Parser cannot be invoked without 'new'"，而且不可能修好。
 * 代价：<style> 块里不能写 // 单行注释（要用 /* *\/）；scss 不受影响。
 */
export const POSTCSS_CONFIG = `const path = require('path')

module.exports = {
  plugins: [
    require('postcss-import')({
      resolve (id) {
        if (id.startsWith('~@/')) return path.resolve(process.env.UNI_INPUT_DIR, id.substr(3))
        if (id.startsWith('@/')) return path.resolve(process.env.UNI_INPUT_DIR, id.substr(2))
        if (id.startsWith('/') && !id.startsWith('//')) return path.resolve(process.env.UNI_INPUT_DIR, id.substr(1))
        return id
      }
    }),
    require('autoprefixer')({ remove: process.env.UNI_PLATFORM !== 'h5' }),
    require('@dcloudio/vue-cli-plugin-uni/packages/postcss')
  ]
}
`

/**
 * babel.config.js —— 与 uni-app 官方模板保持一致，不要"简化"。
 *
 * 踩过的坑：自己写成 `presets: [['@vue/app', { useBuiltIns: 'usage', corejs: 3 }]]`
 * 会编译报 `TypeError: definePropertyModule.f is not a function`（core-js 注入方式不匹配）。
 * 关键两点：
 *   - webpack 4 下 modules 必须是 'commonjs'（webpack 5 才用 'auto'）
 *   - 非 h5 平台 useBuiltIns 必须是 'entry'，不是 'usage'
 */
export const BABEL_CONFIG = `const webpack = require('webpack')
const plugins = []

if (process.env.UNI_OPT_TREESHAKINGNG) {
  plugins.push(require('@dcloudio/vue-cli-plugin-uni-optimize/packages/babel-plugin-uni-api/index.js'))
}

process.UNI_LIBRARIES = process.UNI_LIBRARIES || ['@dcloudio/uni-ui']
process.UNI_LIBRARIES.forEach((libraryName) => {
  plugins.push([
    'import',
    {
      libraryName,
      customName: (name) => \`\${libraryName}/lib/\${name}/\${name}\`
    }
  ])
})

if (process.env.UNI_PLATFORM !== 'h5') {
  plugins.push('@babel/plugin-transform-runtime')
}

const config = {
  presets: [
    [
      '@vue/app',
      {
        modules: webpack.version[0] > 4 ? 'auto' : 'commonjs',
        useBuiltIns: process.env.UNI_PLATFORM === 'h5' ? 'usage' : 'entry'
      }
    ]
  ],
  plugins
}

const UNI_H5_TEST = '**/@dcloudio/uni-h5/dist/index.umd.min.js'
if (process.env.NODE_ENV === 'production') {
  config.overrides = [{ test: UNI_H5_TEST, compact: true }]
} else {
  config.ignore = [UNI_H5_TEST]
}

module.exports = config
`

export const NPMRC = `# Vue2 生态在 npm 7+ 的严格 peer deps 下装不上
legacy-peer-deps=true
`

/**
 * postinstall 补丁脚本。
 *
 * uni-app 自带一份打过补丁的 @vue/component-compiler-utils（在 vue-cli-plugin-uni/packages/@vue/ 下，
 * 只有它会生成 recyclableRender），但那个目录不在任何 Node 能解析到的 node_modules 路径上，
 * env.js 也没给它加 module-alias。结果 vue-loader 解析到顶层原版，编译必然报
 * "Export 'recyclableRender' is not defined"。
 *
 * 官方 hello 模板同样中招，属上游缺陷。这里建一条软链把补丁版接进 vue-loader 的解析路径。
 * 挂在 postinstall 上，保证以后每次 npm install 之后都自动修复。
 */
export const POSTINSTALL_PATCH = `import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = path.join(root, 'node_modules/@dcloudio/vue-cli-plugin-uni')
const patched = path.join(pluginDir, 'packages/@vue/component-compiler-utils')
const linkDir = path.join(pluginDir, 'packages/vue-loader/node_modules/@vue')
const link = path.join(linkDir, 'component-compiler-utils')

if (!fs.existsSync(patched)) {
  console.log('[wx-agent] 跳过：未找到 uni-app 补丁版 component-compiler-utils')
  process.exit(0)
}

try {
  fs.mkdirSync(linkDir, { recursive: true })
  if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) {
    fs.rmSync(link, { recursive: true, force: true })
  }
  fs.symlinkSync(path.relative(linkDir, patched), link, 'dir')
  console.log('[wx-agent] 已修复 @vue/component-compiler-utils 解析路径（recyclableRender 补丁）')
} catch (err) {
  console.warn('[wx-agent] 修复 component-compiler-utils 失败：' + err.message)
}
`

/**
 * 编译入口脚本。
 *
 * 不把环境变量直接写进 npm script，是因为 UNI_CLI_CONTEXT 必须是**绝对路径**
 * （vue-cli-plugin-uni 的 error-reporting.js 会拿它做 pathToRegexp），
 * 而在 npm script 里跨平台取绝对路径很别扭。交给一个 node 脚本来算最干净，
 * 顺便让手动 `npm run dev:mp-weixin` 和 `wxctl compile` 走完全相同的逻辑。
 */
export const BUILD_SCRIPT = `import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const watch = args.includes('--watch')
const prod = args.includes('--prod')

const outDir = prod ? 'unpackage/dist/build/mp-weixin' : 'unpackage/dist/dev/mp-weixin'

const child = spawn('npx', ['vue-cli-service', 'uni-build', ...(watch ? ['--watch'] : [])], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: prod ? 'production' : 'development',
    UNI_PLATFORM: 'mp-weixin',
    UNI_CLI_CONTEXT: root,
    UNI_INPUT_DIR: root,
    UNI_OUTPUT_DIR: path.join(root, outDir)
  }
})
child.on('exit', (code) => process.exit(code ?? 0))
`

/** 生成给 uni-app CLI 用的 npm scripts */
export function uniScripts () {
  return {
    'dev:mp-weixin': 'node ./.wx-agent/build.mjs --watch',
    'dev:mp-weixin:once': 'node ./.wx-agent/build.mjs',
    'build:mp-weixin': 'node ./.wx-agent/build.mjs --prod',
    postinstall: 'node ./.wx-agent/postinstall.mjs'
  }
}
