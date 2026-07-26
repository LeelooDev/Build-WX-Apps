<p align="center">
  <img src="docs/banner.jpg" alt="wx-agent —— 让 AI 为你开发微信小程序" width="460">
</p>

<h1 align="center">wx-agent</h1>

<p align="center">
  让 AI 编码助手真正能开发微信小程序<br>
  编译 · 运行 · 截图 · 驱动 UI · 读日志 · <b>把报错映射回你的源码</b>
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#接入">接入 Claude / Codex / Gemini</a> ·
  <a href="#一个真实例子">效果</a> ·
  <a href="#hbuilderx-版-uni-appwxctl-init-到底做了什么">uni-app 的 9 个坑</a> ·
  <a href="#能力一览">能力一览</a>
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518.17-brightgreen">
  <img alt="mcp" src="https://img.shields.io/badge/MCP-26%20tools-8A2BE2">
  <img alt="platform" src="https://img.shields.io/badge/%E5%8E%9F%E7%94%9F%20%7C%20uni--app%20%7C%20Taro-supported-orange">
</p>

---

让 AI 编码助手真正能开发微信小程序 —— 编译、跑起来、看见界面、点击操作、读运行日志、**把报错映射回你的源码**。

支持 **原生小程序**、**uni-app**（含 HBuilderX 工程一键补齐命令行编译能力）、**Taro**。
通过 MCP 协议对接 **Claude Code / Codex / Cursor / Cline** 等任意 AI 工具，也提供独立命令行 `wxctl`。

---

## 为什么需要它

iOS 开发有 [XcodeBuildMCP](https://github.com/cameroncooke/XcodeBuildMCP)，AI 能构建、跑模拟器、截图、点按、抓日志。小程序这边什么都没有，AI 只能盲写：

| 盲写的困境 | wx-agent 的解法 |
|---|---|
| 看不到界面，改完不知道对不对 | `wx_screenshot` 直接返回画面 |
| 不知道页面上有什么、该点哪里 | `wx_snapshot` 给出结构 + 可交互元素 + **每个元素绑定的方法和数据字段** |
| 拿不到 console 日志 | `wx_logs` 持续采集 console / 异常 / unhandledRejection |
| 报错只有 `form.js:300`，对不上源码 | `wx_errors` 用 sourcemap 映射回 **`form.vue:136` 并附上那几行代码** |
| 不能点击、不能填表、不能跑流程 | `wx_tap` / `wx_input` / `wx_navigate` / `wx_call_method` |
| 不能自己编译，得手动去 IDE 点 | `wx_run` 一步：编译 → 打开开发者工具 → 建立连接 |
| HBuilderX 工程根本没有命令行编译 | `wx_init` 一条命令补齐（不改目录结构，HBuilderX 照常可用） |

---

## 架构

```
packages/core/          引擎（不含任何 AI 概念，纯粹"驱动小程序"）
  project.js              工程探测：原生 / uni-app(HBuilderX) / uni-app(CLI) / Taro
  init.js + recipes.js    HBuilderX → CLI 的迁移配方（见下文 9 个坑）
  compile.js              可插拔编译层
  devtools.js             微信开发者工具 CLI 控制
  session.js + logs.js    automator 会话 + 三路日志采集
  sourcemap.js            报错堆栈 → 源码行号 + 代码片段
  ui.js + wxml.js         结构快照、元素定位、点击输入
  capture.js              截图、连拍、GIF

packages/mcp/           MCP server  → Claude / Codex / Cursor 都能装
packages/cli/           wxctl 命令行 → 人用，也是没有 MCP 的 agent 的兜底
plugin-claude-code/     Claude Code 插件（/wxgo 入口 + 4 个 skill）
```

**核心是 MCP server**，因为那是跨 AI 工具唯一的通用层。CLI 与它共用同一份 `core`。

---

## 安装

分三步：**① 装前置** → **② 装 wx-agent** → **③ 接进你的 AI 工具**。

### ① 前置条件

| 要求 | 说明 |
|---|---|
| **Node ≥ 18.17** | `node -v` 检查。建议 20 或 22 |
| **微信开发者工具** + **扫码登录** | 没登录的话几乎所有命令都会失败 |
| **服务端口（CLI/HTTP 调用）已开启** | 开发者工具 → 设置 → 安全设置 → 勾上「服务端口」← **这是硬前提，关着什么都连不上** |
| `ffmpeg`（可选） | 只有连拍合成 GIF 用得到，不装也能截图 |

平台支持情况：

| 平台 | 状态 | 说明 |
|---|---|---|
| **macOS** | ✅ 完整可用 | 开发环境，全部能力都在真机验证过 |
| **Windows** | ✅ 完整可用 | 平台差异已适配（见下），但**未在 Windows 真机跑过** |
| **Linux** | ⚠️ 部分可用 | **微信开发者工具没有官方 Linux 版**，详见 [Linux](#linux) |

#### macOS

```bash
# Node（用 Homebrew 或 nvm 都行）
brew install node
# 或：curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22
```

微信开发者工具从 [官方下载页](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) 装（选「稳定版 Stable Build」，Apple Silicon 选 ARM64 包）。装到 `/Applications` 即可自动找到。

打开工具 → **扫码登录** → **设置 → 安全设置 → 服务端口** 打开。

#### Windows

```powershell
# Node：从 https://nodejs.org 下 LTS 安装包，或者
winget install OpenJS.NodeJS.LTS
```

微信开发者工具装到默认位置（`C:\Program Files (x86)\Tencent\微信web开发者工具`）就能自动找到。装到别处的话指定一下：

```powershell
setx WX_DEVTOOLS_CLI "D:\Tools\微信web开发者工具\cli.bat"
```

> 注意是 **`cli.bat`**，不是 `.exe`。也可以每次用 `wxctl --cli-path "D:\...\cli.bat"`。

**两个 Windows 特有的坑**（`wxctl doctor` 会提前替你检查）：

- **项目路径不能含 `%`**。传参必须经 `cmd.exe`，而它会把 `%xxx%` 当环境变量展开，没有可靠的转义写法。所以 `D:\100%完成\proj` 这类路径会被直接拒绝并报明确错误，而不是让参数被悄悄改写。
- **路径别太深**。Win32 API 默认 260 字符上限，`node_modules` 很容易撞上，表现是 `npm install` 莫名失败。要么把项目挪到靠近盘符根的位置，要么开启长路径支持（`LongPathsEnabled=1`）。

<a id="linux"></a>
#### Linux

**微信开发者工具只有 Windows 和 macOS 官方版，没有 Linux 版。** 这不是本项目的限制——所有依赖它的能力（运行、截图、点击、读日志）在 Linux 上都没有官方途径。

不过**不依赖开发者工具的那部分是完整可用的**，在 CI 里尤其有价值：

```bash
wxctl doctor      # 体检（会如实报告开发者工具缺失）
wxctl info        # 工程识别
wxctl init        # HBuilderX 版 uni-app 补齐命令行编译能力
wxctl compile     # 编译
wxctl size        # 包体积分析（主包/分包 vs 官方限制）
wxctl artifacts   # 产物占用
```

也就是说：**在 Linux CI 上跑「编译 + 体积卡口」是可行的**，只是没法在上面跑 UI 自动化。

如果你用社区的 Linux 移植版（比如 [`msojocs/wechat-devtools-linux`](https://github.com/msojocs/wechat-devtools-linux)），把它的 cli 指过来即可：

```bash
export WX_DEVTOOLS_CLI=/opt/wechat-devtools/bin/cli
```

> 社区移植版**未经本项目验证**。它只要提供兼容的 `cli auto --project X --auto-port N`，理论上运行/调试能力就能工作。踩通了欢迎开 issue 告诉我。
>
> 需要无头环境上传体验版的话，用微信官方的 [`miniprogram-ci`](https://www.npmjs.com/package/miniprogram-ci)——那个是纯 Node 包，不需要 IDE。

---

### ② 装 wx-agent

> **目前还没发到 npm**，所以要从源码装。发布后会补上 `npm i -g` 的方式。

```bash
git clone https://github.com/LeelooDev/Build-WX-Apps.git wx-agent
cd wx-agent
npm install
npm link -w wx-agent-core -w wx-agent-mcp -w wx-agent-cli
```

`npm link` 之后 `wxctl` 和 `wx-agent-mcp` 就是全局命令了。验证一下：

```bash
wxctl doctor --dir /你的小程序工程
```

Windows 上如果 `npm link` 报权限错误，用管理员权限开一次 PowerShell 再跑。

<details>
<summary>不想全局 link？（点开）</summary>

也可以只在项目里用绝对路径调用，跳过 `npm link`：

```bash
node /path/to/wx-agent/packages/cli/bin/wxctl.js doctor
```

MCP 配置里同样可以直接指向文件（见下面各工具的「源码方式」）。
</details>

---

<a id="接入"></a>
## ③ 接入你的 AI 工具

核心是一个标准 **MCP server**，所以任何支持 MCP 的工具都能用，26 个工具全都一样。下面按工具给配置。

三个通用约定：

- **`WX_AGENT_PROJECT`** 指向你的小程序工程根目录。省略则取工作目录；每个工具调用也能单独传 `projectDir`。
- **路径要写绝对路径**，AI 工具启动 MCP server 时的工作目录未必是你想的那个。
- **Windows 上 `command` 要用 `cmd` + `/c`**。`npm link`（以及以后的 `npm i -g`）在 Windows 上装出来的是 `wx-agent-mcp.cmd`，而 Node 修掉 CVE-2024-27980 之后（18.20.2+ / 20.12.2+），不带 shell 执行批处理文件会抛 `EINVAL`——多数 MCP 客户端正是直接 spawn，所以会起不来。把真正的命令挪到 `args` 里即可。`npx` 同理（它是 `npx.cmd`）。

### Claude Code

**方式一：装插件**（推荐，附带 9 个小程序专用 skill 和 `/wxgo` 命令）

```bash
claude plugin marketplace add /path/to/wx-agent/plugin-claude-code
claude plugin install wx-agent@wx-agent-local
```

> 改了插件源之后必须重装才生效（cache 是副本）：
> `claude plugin uninstall wx-agent@wx-agent-local && claude plugin install wx-agent@wx-agent-local`，然后 `/reload-plugins`。

**方式二：只挂 MCP server**，在小程序项目根目录放 `.mcp.json`。

macOS / Linux：

```json
{
  "mcpServers": {
    "wx-agent": {
      "command": "wx-agent-mcp",
      "env": { "WX_AGENT_PROJECT": "/绝对路径/你的工程" }
    }
  }
}
```

Windows（注意 `cmd` + `/c`，以及 JSON 里反斜杠要写两个）：

```json
{
  "mcpServers": {
    "wx-agent": {
      "command": "cmd",
      "args": ["/c", "wx-agent-mcp"],
      "env": { "WX_AGENT_PROJECT": "D:\\你的工程" }
    }
  }
}
```

没做 `npm link` 的话，把 `command` 换成 `node`、`args` 换成 `["/path/to/wx-agent/packages/mcp/bin/wx-agent-mcp.js"]`。

**用起来**——直接说人话：

- 「把小程序跑起来，登录页截图给我看看」
- 「填上账号密码点登录，把日志总结一下」
- 「这个页面报错了，帮我看看是哪行」

或者用统一入口 `/wxgo run` / `/wxgo debug` / `/wxgo ui` / `/wxgo init`。

### Codex

配置在 **`~/.codex/config.toml`**，注意表名是 **snake_case 的 `mcp_servers`**（不是 `mcpServers`）：

```toml
[mcp_servers.wx-agent]
command = "wx-agent-mcp"

[mcp_servers.wx-agent.env]
WX_AGENT_PROJECT = "/绝对路径/你的工程"
```

Windows：

```toml
[mcp_servers.wx-agent]
command = "cmd"
args = ["/c", "wx-agent-mcp"]

[mcp_servers.wx-agent.env]
WX_AGENT_PROJECT = "D:\\你的工程"
```

也可以用命令行加（`--` 后面是真正要执行的命令）：

```bash
codex mcp add wx-agent --env WX_AGENT_PROJECT=/绝对路径/你的工程 -- wx-agent-mcp
```

另外把 [`docs/AGENTS.md`](docs/AGENTS.md) 拷到你项目根目录，Codex 会自动读它当上下文——里面写了这套工具的用法惯例，能少走弯路。

### Gemini CLI

配置在 **`~/.gemini/settings.json`**（全局）或项目里的 **`.gemini/settings.json`**：

```json
{
  "mcpServers": {
    "wx-agent": {
      "command": "wx-agent-mcp",
      "cwd": "/绝对路径/你的工程",
      "env": { "WX_AGENT_PROJECT": "/绝对路径/你的工程" },
      "timeout": 600000
    }
  }
}
```

Windows 把 `command` 换成 `"cmd"`、加 `"args": ["/c", "wx-agent-mcp"]`。

也可以用命令行：

```bash
gemini mcp add -s user -e WX_AGENT_PROJECT=/绝对路径/你的工程 wx-agent wx-agent-mcp
```

> `timeout` 建议留足（默认 600000ms）。首次 `wx_run` 要编译 + 拉起开发者工具 + 建连接，冷启动可能超过 60 秒。

### Cursor / Cline / Windsurf / 其他

都是 `mcpServers` 这套 JSON 格式，和上面 Claude Code 的「方式二」完全一样，只是文件位置不同：

| 工具 | 配置文件 |
|---|---|
| Cursor | `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json` |
| Cline / Roo | VS Code 里 Cline 面板 → MCP Servers → Configure |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Zed | `settings.json` 里的 `context_servers` |

### 配置写法速查

| | macOS / Linux | Windows |
|---|---|---|
| `command` | `wx-agent-mcp` | `cmd` |
| `args` | *(不用)* | `["/c", "wx-agent-mcp"]` |
| 工程路径写法 | `/Users/me/proj` | `D:\\my\\proj`（JSON 里反斜杠要转义） |
| 没 `npm link` 时 | `node` + `["/path/.../wx-agent-mcp.js"]` | `cmd` + `["/c", "node", "C:\\path\\...\\wx-agent-mcp.js"]` |

### 接上了没有？

问你的 AI：**「跑一下 wx_doctor」**。正常会看到这样的体检表：

```
工程：/Users/me/proj
类型：uni-app（CLI 模式） Vue2 · appid wx1234567890abcdef

✅ Node: v22.21.0
✅ 微信开发者工具: /Applications/wechatwebdevtools.app/Contents/MacOS/cli
✅ 开发者工具登录态: 已登录
✅ 工程类型: uniapp-cli (Vue2)
✅ appid: wx1234567890abcdef
✅ 依赖: 已安装
✅ recyclableRender 补丁: 已生效
✅ 编译产物: …/unpackage/dist/dev/mp-weixin
✅ sourcemap: …/unpackage/dist/dev/.sourcemap/mp-weixin
```

有 ❌ 的话它会一并给出修法。Windows 上还会多三项检查（npm 入口、路径含 `%`、路径长度）。

排查顺序：

| 现象 | 原因 |
|---|---|
| AI 说没有 wx_* 工具 | MCP server 没起来。先在终端直接跑 `wx-agent-mcp`（应该挂住不退出），再看 AI 工具的 MCP 日志 |
| Windows 上 MCP 起不来 | `command` 没用 `cmd` + `/c`（见上） |
| 「找不到微信开发者工具」 | 设 `WX_DEVTOOLS_CLI`；Windows 上注意是 `cli.bat` |
| 「自动化端口没起来」 | **服务端口没开**。开发者工具 → 设置 → 安全设置 → 服务端口 |
| 截图/点击报连接错误 | 工程没跑起来。先 `wx_run` |

---

## 只用命令行（不接 AI 工具）

`wxctl` 和 MCP server 共用同一套 core，能力完全一致。适合写脚本、上 CI，或者给没有 MCP 的 AI 工具当兜底。

```bash
wxctl doctor          # 体检：缺什么一目了然
wxctl init            # HBuilderX 工程补齐命令行编译能力（只新增文件，可回退）
wxctl run             # 编译 → 打开开发者工具 → 连上
wxctl snapshot        # 看页面结构和可点元素
wxctl screenshot      # 截图
wxctl input '.input-field[0]' demo-user
wxctl tap '.submit-btn'
wxctl logs --tail 30
wxctl errors          # 报错 + 源码定位

wxctl help            # 全部命令
```

超时相关的两个环境变量（默认值够用，卡住时再动）：

```bash
WX_AGENT_OP_TIMEOUT=30000        # 单步操作超时（毫秒）。tap/input/snapshot 这类
WX_AGENT_INSTALL_TIMEOUT=2700    # wxctl init 装依赖的超时（秒）
```

> **Windows 上引号不一样**：`cmd.exe` 不认单引号，selector 要用双引号 —— `wxctl tap ".submit-btn"`。PowerShell 两种都行。

---

## 一个真实例子

在 `form.vue` 第 96 行放一个不存在的方法调用，点击提交后：

```
$ wxctl errors

[1] unhandledRejection · _this.validateAccount is not a function
    → pages/demo/form.vue:97:0
        95 | 			async onSubmit() {
        96 | 				this.validateAccount();
    >   97 | 				if (!this.account) {
        98 | 					uni.showToast({ title: '请填写账号', icon: 'none' });
```

而开发者工具原本只会告诉你 `pages/demo/form.js:300`。

> `async` 函数经 babel 转译后行号可能有 ±1 偏移，所以输出总是带上下文代码片段——以片段里那行实际代码为准。

`wxctl snapshot` 的输出同样是给 AI 直接决策用的：

```
可操作元素：
  .input-field[0]  input   placeholder="账号"                → data.account
  .input-field[1]  input   placeholder="密码" type=password  → data.pwd
  .submit-btn      button  "提交"                            → tap:onSubmit()
```

箭头后面是从编译产物的 `data-event-opts` 里解析出来的**真实绑定关系**，不是猜的。

---

## HBuilderX 版 uni-app：`wxctl init` 到底做了什么

HBuilderX 工程没有 `package.json`，只能在 GUI 里点"运行"，AI 无从下手。`wxctl init` 把它补成可命令行编译，**只新增文件、不移动源码、不改目录结构**，HBuilderX 仍可继续使用，`wxctl init --revert` 完整回退。

难点在于：**照抄 uni-app 官方 `uni-preset-vue` 模板在当前依赖环境下编译不过**（已用官方 hello 模板做过对照实验，报同样的错）。以下 9 条是实测踩出来的，每条都对应一个真实报错：

| # | 报错 | 原因与修法 |
|---|---|---|
| 1 | `Cannot find module '@dcloudio/webpack-uni-pages-loader'` | `vue-cli-plugin-uni` require 了但没声明依赖；需显式装它和 `uni-cli-i18n`、`uni-h5` |
| 2 | `The "paths[0]" argument must be of type string` | `env.js` 第 90 行用了第 194 行才赋值的 `UNI_CLI_CONTEXT`（上游顺序 bug）；外部注入绝对路径 |
| 3 | `src/manifest.json does not exist` | CLI 模式默认要求源码在 `src/`；用 `UNI_INPUT_DIR` 指向工程根，源码留在原地 |
| 4 | `Cannot find module 'webpack/lib/GraphHelpers'` | webpack 5 被提升到顶层，但 uni-app 用的是 webpack 4 API；钉 `webpack@^4.47` |
| 5 | `postcss-uniapp-plugin requires PostCSS 8` | 新版 uni-app 要 PostCSS 8，`@vue/cli-service@4.5` 全家锁 7；用 `overrides` 强制整树到 8 |
| 6 | `Class constructor Parser cannot be invoked without 'new'` | `postcss-comment` 永远锁 postcss@6；移除该 parser（代价：`<style>` 内不能用 `//` 注释） |
| 7 | `Cannot read properties of undefined (reading 'unprefixed')` | autoprefixer 9 用了 PostCSS 8 已删的 `postcss.vendor`；升到 autoprefixer 10 + postcss-import 14 |
| 8 | **`Export 'recyclableRender' is not defined`** | uni-app 自带的补丁版 `@vue/component-compiler-utils` 没被放进任何可解析路径（上游缺陷）；建软链接进 vue-loader，并挂 `postinstall` 保证每次安装后自动修复 |
| 9 | `definePropertyModule.f is not a function` | babel 配置被"简化"导致 core-js 注入方式不匹配；webpack4 下 `modules` 必须 `commonjs`、小程序平台 `useBuiltIns` 必须 `entry` |

另外 npm 7+ 严格 peer deps 装不上 Vue2 生态，需要 `.npmrc` 里 `legacy-peer-deps=true`。

---

## 能力一览

| 分类 | MCP 工具 | wxctl |
|---|---|---|
| 环境 | `wx_doctor` `wx_project_info` `wx_init` | `doctor` `info` `init` |
| 编译运行 | `wx_run` `wx_compile` | `run` `compile` `connect` |
| 观察 | `wx_screenshot` `wx_snapshot` `wx_page_data` `wx_logs` `wx_errors` `wx_record` | `screenshot` `snapshot` `data` `logs` `errors` `record` |
| 操作 | `wx_tap` `wx_input` `wx_trigger` `wx_wait` `wx_navigate` `wx_call_method` `wx_eval` `wx_mock_wx_method` | `tap` `input` `trigger` `wait` `nav` `call` `eval` |
| 组件 | `wx_component` `wx_element_box` | `component` `box` |
| 性能体积 | `wx_setdata_monitor` `wx_analyze_size` | `setdata` `size` |
| 产物管理 | `wx_artifacts` | `artifacts` `clean` |
| 发布 | `wx_preview` `wx_upload` | `preview` `upload` |

**Claude Code 插件里的 9 个 skill**：运行调试、UI 自动化、性能与体积、登录鉴权、组件调试、
wx API 排查、路由与生命周期、uni-app 工程疑难、预览发布。统一入口 `/wxgo` 按症状分诊。

两个小程序特有的能力值得单独说：

- **`wx_setdata_monitor`** —— 劫持当前页面的 setData，测出调用频率、单次数据量、热点字段、
  100ms 内的突发次数，并直接给出诊断。setData 是小程序头号性能杀手，但开发者工具里没有地方能看到这些。
- **`wx_analyze_size`** —— 按主包/分包拆开算体积并对照官方限制（主包 2MB / 分包 2MB / 合计 20MB），
  列出最大的文件和按类型占比。开发者工具只在上传那一刻才告诉你超了。

---

## 截图产物不会堆积

daemon 和 MCP server 都是常驻进程，截图若不回收会无限堆积。所有产物统一放在
`~/.wx-agent/artifacts/<项目>/`（权限 0700），并有**全局容量上限（默认 100MB）**：

- 累计写入到一定量时自动检查，超上限就从**最旧的**开始删，降到 50% 水位为止
- **最近 60 秒内的文件受保护**——它们的路径可能刚返回给你或模型，删了就是死链
- 你用 `-o` / `savePath` 显式指定路径的截图**不纳入自动回收**（那是你要的产物）
- 超过 24 小时没动过的项目子目录整个清掉

```bash
wxctl artifacts     # 看占用：337.4 KB / 100.0 MB  (0%)  14 个文件
wxctl clean         # 立刻清空
wxctl clean --auto  # 只回收超出上限的部分
```

改上限：`WX_AGENT_MAX_ARTIFACT_MB=200`；改位置：`WX_AGENT_HOME=/your/path`。

## 安全说明

这套工具能驱动你的小程序、读写文件，所以运行时状态的存放位置是有讲究的：

- **控制 socket 和 daemon 日志放在 `~/.wx-agent/run/`（目录 0700，socket 0600）**，
  不放 `os.tmpdir()`。daemon 的 socket 等同于一个无认证的控制通道——连上就能让它在小程序里
  执行 JS、往磁盘写截图。在 Linux 上 tmpdir 是全局可写的 `/tmp`，放那里等于对所有本地用户开放。
  靠目录权限把访问者限制为你本人。
  **Windows** 没有 Unix socket，改用 named pipe；而 `\\.\pipe\` 是全机器共享且无权限位的命名空间，
  所以 pipe 名带 16 字节随机串，真名存在 `%USERPROFILE%\.wx-agent\run\` 下受 NTFS ACL 保护 ——
  隔离手段从「目录权限」换成了「名字即凭据」。
- **日志以 `O_NOFOLLOW` 打开**，路径若被换成符号链接则直接报错，不会顺着写进它指向的文件。
  Windows 没有这个 flag，退回 `lstat` 预检——这**不等价**（存在 TOCTOU 窗口），
  但能往 `%USERPROFILE%` 里放重解析点的攻击者已经拿到了你的写权限，此时他有远比这更直接的手段。
- **文件名会消毒，相对路径锁在产物目录内**，`../../` 穿不出去。
  Windows 上额外规避保留设备名（`CON`、`PRN`、`COM1`…）和结尾的点/空格，
  并按大小写不敏感来判断目录边界。
- **传给 `cmd.exe` 的参数逐个加引号**，而不是用 `shell: true` ——
  否则项目路径里的 `&`、`(`、`|` 会被当成命令分隔符。含 `%` 的路径直接拒绝（无可靠转义）。
- **MCP 层的落盘路径受限**：`wx_screenshot` 的 `savePath` 等参数由模型填写，而模型读的是
  小程序页面内容（可能含诱导性文字），因此只允许写到项目目录或产物目录内。
  CLI 侧不做此限制——那是你本人在敲命令。

## 跨平台是怎么做的

平台差异全部收在 [`packages/core/src/platform.js`](packages/core/src/platform.js) 一个文件里，其余模块不出现 `process.platform` 分支：

| 差异点 | macOS / Linux | Windows |
|---|---|---|
| CLI ↔ daemon 通道 | Unix domain socket，`~/.wx-agent/run/`（0700） | named pipe，名字带 16 字节随机串 |
| 跑 `npm` / `npx` | 直接执行 | 走 npm 的 JS 入口，绕开 `.cmd` |
| 跑开发者工具 cli | 直接执行 | `cmd.exe /d /s /c` + 自行逐参数加引号 |
| `init` 的补丁链接 | symlink | junction（symlink 需管理员权限） |
| 访问控制 | 目录权限位 0700 | `%USERPROFILE%` 继承的 NTFS ACL |
| 防 symlink 劫持 | `O_NOFOLLOW` | `lstat` 预检（不等价，有 TOCTOU 窗口） |
| GIF 合成 | ffmpeg concat demuxer | 同上（`-pattern_type glob` 在 Windows 构建里没编进去） |
| sourcemap 源路径 | `webpack:////abs/...`（四斜杠） | `webpack:///C:/...`（三斜杠 + 盘符） |

两处值得单独说明：

**为什么 Windows 的 pipe 名要带随机串。** 控制通道等同于一个无认证的控制接口——连上就能让 daemon 在你的小程序里执行任意 JS。POSIX 下靠 0700 目录挡住其他本地用户，而 `\\.\pipe\` 是**全机器共享且没有权限位**的命名空间，没有对应物。所以 pipe 名用 16 字节随机数，真名存在 `%USERPROFILE%\.wx-agent\run\<key>.pipe`（受 NTFS ACL 保护）——猜不到名字就连不上。

**为什么 `spawn('npm')` 在 Windows 上会挂。** 那里 `npm` 解析到 `npm.cmd`，而 Node 修掉 CVE-2024-27980 之后（18.20.2+ / 20.12.2+），不带 shell 执行批处理文件直接抛 `EINVAL`。用 `shell: true` 能绕过，但那样参数会交给 cmd 解析，项目路径里的 `&`（`D:\work\A&B\proj` 是真实存在的目录名）会变成命令拼接。所以改成走 npm 的 JS 入口，`.bat` 则经 `cmd.exe` 并自己控制引号。

Windows 分支的逻辑（cmd 引号规则、命令翻译、pipe 名生成、sourcemap 路径形态）都以**显式参数**而非 `process.platform` 驱动，因此在 macOS 上也能被测到——否则那部分代码只有 Windows 用户才跑得到，等于没人验证过。

## 已知限制

- **截图拍不到 canvas**。开发者工具**不把 `canvas type="2d"` 的同层渲染内容合成进截图** —— 画得好好的画布，截出来是一片空白，和「渲染失败」在像素上无法区分。
  实测验证过：整块画布填成不透明红色，`getImageData` 显示 104160/104160 像素全部非透明，截图依然全白。
  所以页面里有 canvas 时，`wxctl screenshot` / `wx_screenshot` 会自动附一条警告并指出 canvas 在哪个组件。
  要判断到底画没画，用 `wxctl eval` 读像素：`const d = ctx.getImageData(0,0,w,h).data; let n=0; for(let i=3;i<d.length;i+=4) if(d[i]) n++; return n`。
- **page 级 API 可能整条卡死**。某些开发者工具/基础库组合下，automator 的 page 代理会**不 resolve 也不 reject**
  （`page.data()` / `page.$()` / `page.callMethod()` 全挂），而同一条连接上 `mp.evaluate` / 截图完全正常。
  所有操作都带超时（默认 30 秒，`WX_AGENT_OP_TIMEOUT` 可调），超时会明确告诉你改走 `wxctl eval` / `wx_eval`。
  uni-app 走 eval 时注意：`page.setData()` 不会同步到 Vue 实例，要改 `getCurrentPages().pop().$vm` 上的字段。
- **端口通 ≠ 小程序在跑**。开发者工具启动异常时（模拟器启动超时、IDE cli server 没起来），自动化端口照样会 listen，
  `connect` 秒成功但之后所有调用无响应。`run` / `connect` 会做一次运行时探活并把开发者工具自己的日志摘出来，
  但**恢复只能靠重启开发者工具**（`wxctl run --force-open`）。
- **只支持 Vue2 版 uni-app 的自动配置**。Vue3 走 vite 工具链，配方完全不同，尚未验证；Vue3 工程可以正常使用运行/调试类能力，只是 `init` 帮不上忙。
- **`init` 装依赖是分钟级的**。这套配方要装 1500+ 个包，npm 缓存冷的时候实测超过 15 分钟，热了之后只要 1 分钟。
  默认超时 45 分钟，`--install-timeout <秒>` 或 `WX_AGENT_INSTALL_TIMEOUT` 可调；超时也不会丢文件，按提示手动 `npm install` 续上即可。
- **日志有时间窗口**：只从建立连接那一刻起才开始采集。要先连上，再触发行为，然后才看得到。
- **selector 只支持简单形式**（`#id` / `.class` / 标签名 / `.class[n]`），这是 miniprogram-automator 的限制，不支持复杂 CSS。
- **sourcemap 行号 ±1**：`async` 函数被 babel 转译后有固有偏移，所以输出总是带上下文代码片段。
- **正式发布不在范围内**：提交审核只能在微信公众平台网页端做。
- **Linux 上只有编译类能力**：微信开发者工具没有官方 Linux 版，运行/截图/UI 自动化都依赖它。详见 [Linux](#linux)。
- **Windows 未在真机验证**：平台差异已适配、逻辑层有测试覆盖，但我手上没有 Windows 机器跑端到端。遇到问题请开 issue，附上 `wxctl doctor --json` 的输出。
- **CI 环境**：开发者工具需要 GUI，无头 CI 上传请用官方 `miniprogram-ci`。编译和体积检查可以在无头 CI 上跑。
- **产物回收有 60 秒保护期**：极端情况下（60 秒内截出超过上限的量）会短暂超出上限，等文件过了保护期即被回收。

---

## 致谢

设计上参考了 [XcodeBuildMCP](https://github.com/cameroncooke/XcodeBuildMCP) 与 Codex 的 "Build iOS Apps" 插件：**引擎做成通用 MCP server，各家 AI 工具再套薄薄一层壳**。

底层依赖微信官方的 [miniprogram-automator](https://www.npmjs.com/package/miniprogram-automator) 与微信开发者工具 CLI。

## License

MIT
