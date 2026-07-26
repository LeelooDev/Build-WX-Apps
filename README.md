<p align="center">
  <img src="docs/banner.jpg" alt="wx-agent —— 让 AI 为你开发微信小程序" width="460">
</p>

<h1 align="center">wx-agent</h1>

<p align="center">
  让 AI 编码助手真正能开发微信小程序<br>
  编译 · 运行 · 截图 · 驱动 UI · 读日志 · <b>把报错映射回你的源码</b>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
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
| 报错只有 `login.js:300`，对不上源码 | `wx_errors` 用 sourcemap 映射回 **`login.vue:136` 并附上那几行代码** |
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

## 快速开始

### 前置条件

1. 装好 **微信开发者工具** 并**扫码登录**
2. **开发者工具 → 设置 → 安全设置 → 服务端口（CLI/HTTP 调用）** 打开 ← 这是硬前提，关着什么都连不上
3. Node ≥ 18.17
4. 可选：`ffmpeg`（连拍合成 GIF 用）

### 本地开发（尚未发布到 npm 时）

先把三个包 link 到全局，这样 `npx wx-agent-mcp` 和 `wxctl` 都能直接用：

```bash
cd wx-agent
npm install
npm link -w wx-agent-core -w wx-agent-mcp -w wx-agent-cli
```

### Claude Code

```bash
claude plugin marketplace add /path/to/wx-agent/plugin-claude-code
claude plugin install wx-agent@wx-agent-local
```

> 修改插件源之后必须重装才生效（cache 是副本）：
> `claude plugin uninstall wx-agent@wx-agent-local && claude plugin install wx-agent@wx-agent-local`，然后在会话里 `/reload-plugins`。

也可以不装插件，直接在小程序项目根目录放一个 `.mcp.json`：

```json
{
  "mcpServers": {
    "wx-agent": { "command": "npx", "args": ["-y", "wx-agent-mcp"] }
  }
}
```

然后直接说人话就行：

- "把小程序跑起来，登录页截图给我看看"
- "填上账号密码点登录，把日志总结一下"
- "这个页面报错了，帮我看看是哪行"

或者用统一入口 `/wxgo run` / `/wxgo debug` / `/wxgo ui` / `/wxgo init`。

### Codex / Cursor / 其他 MCP 客户端

在各自的 MCP 配置里加：

```json
{
  "mcpServers": {
    "wx-agent": {
      "command": "npx",
      "args": ["-y", "wx-agent-mcp@latest"],
      "env": { "WX_AGENT_PROJECT": "/绝对路径/你的小程序工程" }
    }
  }
}
```

`WX_AGENT_PROJECT` 可省略（默认取工作目录），每个工具也都能单独传 `projectDir`。

另见 [`docs/AGENTS.md`](docs/AGENTS.md)，可直接放进项目给 Codex 等工具当上下文。

### 只用命令行

```bash
npm i -g wx-agent-cli

wxctl doctor          # 体检：缺什么一目了然
wxctl init            # HBuilderX 工程补齐命令行编译能力（只新增文件，可回退）
wxctl run             # 编译 → 打开开发者工具 → 连上
wxctl snapshot        # 看页面结构和可点元素
wxctl screenshot      # 截图
wxctl input '.input-field[0]' demo-user
wxctl tap '.submit-btn'
wxctl logs --tail 30
wxctl errors          # 报错 + 源码定位
```

---

## 一个真实例子

在 `login.vue` 第 96 行放一个不存在的方法调用，点击登录后：

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
  .input-field[0]   input   placeholder="账号"        → data.account
  .input-field[1]   input   placeholder="密码" type=password → data.pwd
  .submit-btn     button  "登录"                          → tap:onSubmit()
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
- **日志以 `O_NOFOLLOW` 打开**，路径若被换成符号链接则直接报错，不会顺着写进它指向的文件。
- **文件名会消毒，相对路径锁在产物目录内**，`../../` 穿不出去。
- **MCP 层的落盘路径受限**：`wx_screenshot` 的 `savePath` 等参数由模型填写，而模型读的是
  小程序页面内容（可能含诱导性文字），因此只允许写到项目目录或产物目录内。
  CLI 侧不做此限制——那是你本人在敲命令。

## 已知限制

- **只支持 Vue2 版 uni-app 的自动配置**。Vue3 走 vite 工具链，配方完全不同，尚未验证；Vue3 工程可以正常使用运行/调试类能力，只是 `init` 帮不上忙。
- **日志有时间窗口**：只从建立连接那一刻起才开始采集。要先连上，再触发行为，然后才看得到。
- **selector 只支持简单形式**（`#id` / `.class` / 标签名 / `.class[n]`），这是 miniprogram-automator 的限制，不支持复杂 CSS。
- **sourcemap 行号 ±1**：`async` 函数被 babel 转译后有固有偏移，所以输出总是带上下文代码片段。
- **正式发布不在范围内**：提交审核只能在微信公众平台网页端做。
- **CI 环境**：开发者工具需要 GUI，无头 CI 上传请用官方 `miniprogram-ci`。
- **产物回收有 60 秒保护期**：极端情况下（60 秒内截出超过上限的量）会短暂超出上限，等文件过了保护期即被回收。

---

## 致谢

设计上参考了 [XcodeBuildMCP](https://github.com/cameroncooke/XcodeBuildMCP) 与 Codex 的 "Build iOS Apps" 插件：**引擎做成通用 MCP server，各家 AI 工具再套薄薄一层壳**。

底层依赖微信官方的 [miniprogram-automator](https://www.npmjs.com/package/miniprogram-automator) 与微信开发者工具 CLI。

## License

MIT
