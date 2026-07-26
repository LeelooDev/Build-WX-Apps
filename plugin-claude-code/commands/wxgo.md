---
description: 微信小程序开发统一入口 —— 跑起来 / 看界面 / 调试报错 / UI 自动化 / 工程配置 / 发布
argument-hint: "[run|debug|ui|init|release] 可选意图，后接自由描述"
---

# 微信小程序开发入口

你是 `wx-agent` 插件的总调度。根据用户输入（`$ARGUMENTS`）判断意图，**加载并遵循对应 skill**，不要自己另起一套流程。

底层能力分工（始终遵守）：

- **编译 / 打开开发者工具 / 截图 / 结构快照 / 点击输入 / 日志 / 报错映射** → wx-agent MCP 工具（`wx_*`）。工具在会话里可能带命名空间前缀，**按功能名从已加载的工具列表里匹配，不要硬编码前缀**。
- **代码导航与修改** → 常规文件工具。
- **绝不靠读代码猜界面**：任何"改动是否生效""现在长什么样"的判断，都必须以 `wx_screenshot` / `wx_snapshot` 的实际结果为准。

## 分诊表

| 用户意图（关键词） | 加载的 skill |
|---|---|
| 跑起来 / run / 编译运行 / 看界面 / 报错 / 白屏 / 调试 | `wx-debugger-agent` |
| 点击 / 输入 / 走一遍流程 / 自动化测试 / 回归 / 断言 | `wx-ui-automation` |
| 卡 / 慢 / 掉帧 / 滑不动 / setData / 包太大 / 超过 2M / 分包 | `wx-performance` |
| 登录 / 授权 / token / openid / 手机号 / 401 / 登录不上 | `wx-auth-login` |
| 组件 / props 没传进去 / 组件不更新 / slot / 样式不生效 / 点不到 | `wx-component-debug` |
| wx.xxx 没反应 / 请求失败 / 域名白名单 / 真机不一样 / 支付 / 分享 | `wx-api-troubleshoot` |
| 跳转 / 路由 / tabBar / 页面栈 / 返回不刷新 / onLoad onShow / 传参 | `wx-page-navigation` |
| 编译不了 / HBuilderX / package.json / 依赖报错 / 工程配置 | `wx-uniapp-pitfalls` |
| 预览 / 二维码 / 上传 / 体验版 / 发布 | `wx-release` |

多个 skill 可能同时相关（比如"登录页卡"同时涉及 `wx-auth-login` 和 `wx-performance`），
按**主要症状**选一个进入，需要时再加载另一个。

## 流程

1. **判定意图**：从 `$ARGUMENTS` 或上下文识别上表中的一类；不明确就用一句话确认。
2. **先体检**：任何运行类任务，第一步先 `wx_doctor`。它会直接告诉你缺什么（没登录 / 没依赖 / 是 HBuilderX 工程编译不了 / 产物没编），比盲目试错快得多。
3. **加载对应 skill** 并严格执行其中的工作流。
4. **验证后再下结论**：运行类任务必须截图确认界面真的渲染出来了，而不是"命令返回成功"就算完成。

无参数时，先问用户要做哪一类（给出上表选项），再进入对应 skill。
