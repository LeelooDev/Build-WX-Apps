# 微信小程序开发（给 AI 助手的操作说明）

> 把本文件放进你的小程序项目根目录（Codex 读 `AGENTS.md`，Cursor 可放进 rules，其他工具按各自约定），
> AI 就知道该怎么用 wx-agent 开发这个项目。

本项目通过 **wx-agent** 让你可以真正地运行、观察和操作这个小程序，而不是盲写代码。

## 可用工具

如果 MCP server 已配置，你会看到 `wx_*` 开头的工具。没有 MCP 的话，用命令行 `wxctl`（两者能力一致）。

## 铁律

1. **不要靠读代码判断界面。** 任何"改动是否生效""现在长什么样"的结论，必须以 `wx_screenshot` 的实际画面为准。
2. **不要猜 selector。** 操作前先 `wx_snapshot`，用它给出的 selector。
3. **报错先看 `wx_errors`，不是 `wx_logs`。** 前者会把堆栈映射回 `.vue`/`.js` 源码并附上代码片段。
4. **日志有时间窗口。** 只从建立连接那一刻起才开始采集：先 `wx_run`，再触发行为，然后才 `wx_logs`。
5. **`wx_upload` 是对外可见的操作**（团队所有人都会看到这个体验版），只有用户明确要求才执行。

## 标准流程

### 起步

```
wx_doctor          # 先体检，缺什么它会直接说，比试错快
wx_run             # 编译 → 打开开发者工具 → 建立连接
wx_screenshot      # 确认界面真的渲染出来了
```

`wx_doctor` 报「HBuilderX 模式，无法由命令行编译」→ 这个 uni-app 工程没有 npm 编译能力，
用 `wx_init`（先 `dryRun: true` 给用户看会改哪些文件）。它只新增文件、不动目录结构，可完整回退。

### 改代码之后

```
1. 改源码
2. wx_compile                  （watch 模式下会自动重编，等一下即可）
3. 重新连接一次                 ← 重编会让错误钩子失效，不重连抓不到新报错
4. wx_screenshot / wx_errors    确认效果
```

### 调试一个报错

```
wx_errors        # 直接给出 pages/xxx/yyy.vue:123 和出错处代码
wx_page_data     # 看运行时状态，比对着截图猜可靠
wx_eval          # 需要时在小程序里直接求值，如 "return getCurrentPages().map(p => p.route)"
```

注意 `async` 函数经 babel 转译后行号可能 ±1，**以代码片段里那行实际代码为准**，不要死抠行号。

### 走一遍交互流程

```
wx_navigate      # 直接跳到起始页，省掉一路点击
wx_snapshot      # 拿当前页的可操作元素
wx_input / wx_tap
wx_wait          # 点击后要给界面响应时间，立刻断言常拿到旧状态
wx_page_data     # 断言这一步的结果
```

页面跳转后**旧 selector 全部失效**，必须重新 `wx_snapshot`。

同一 class 有多个元素时用下标：`.input-field[0]`、`.input-field[1]`（快照给出的 selector 已带好下标）。

### 让测试可控

- `wx_mock_wx_method` 打桩 `wx.request` / `wx.login`，排除后端依赖
- `wx_call_method` 直接调页面方法，跳过冗长前置流程

## 环境前提

- 微信开发者工具已安装并**扫码登录**
- **开发者工具 → 设置 → 安全设置 → 服务端口（CLI/HTTP 调用）已开启** ← 关着的话什么都连不上，这一步只能由用户完成
- 拿不准就先跑 `wx_doctor`，它会把缺的东西和修法一起列出来

## 平台差异

- **macOS / Windows**：能力完整。
- **Linux**：微信开发者工具**没有官方 Linux 版**，所以依赖它的能力（`wx_run`、截图、点击、日志）用不了。
  可用的是 `wx_doctor`、`wx_project_info`、`wx_init`、`wx_compile`、`wx_analyze_size`。
  别在 Linux 上反复重试 `wx_run` —— 那不是配置问题，直接告诉用户这个限制。
- **Windows 特有的两个失败原因**（`wx_doctor` 会检查）：项目路径含 `%`（传参经 `cmd.exe`，会被当环境变量展开，已被显式拒绝）；
  路径过深撞上 260 字符上限（表现为 `npm install` 莫名失败）。
