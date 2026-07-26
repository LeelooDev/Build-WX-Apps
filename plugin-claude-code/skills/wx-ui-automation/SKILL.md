---
name: wx-ui-automation
description: 驱动微信小程序界面——找元素、点击、输入、走完整流程、断言结果、做回归测试。当用户要"帮我点一下""走一遍登录流程""测试这个页面""自动跑一遍"时使用。
---

# 小程序 UI 自动化

## 铁律：先快照，再操作

**永远不要猜 selector。** 每次要操作页面之前先 `wx_snapshot`，它返回三样东西：

1. **结构轮廓**——页面骨架
2. **可操作元素清单**——带可直接使用的 selector
3. **页面运行时数据**——当前 `data`

清单长这样，信息已经足够决定点哪里：

```
.input-field[0]  input   placeholder="账号"                → data.account
.input-field[1]  input   placeholder="密码" type=password  → data.pwd
.submit-btn      button  "提交"                            → tap:onSubmit()
.wechat-alt      view    "微信快捷登录"                    → tap:handleWechatLogin()
```

箭头后面是从编译产物的 `data-event-opts` 解析出来的**真实绑定关系**：哪个输入框对应哪个 data 字段、点这个元素会调哪个方法。据此决策，不要靠 placeholder 文案猜。

## selector 规则

automator 只支持简单形式，**不支持复杂 CSS 选择器**：

- `#id` —— 最稳
- `.class` —— 常用
- `标签名`
- `.class[n]` —— **同一个 class 匹配多个元素时必须带下标**（下标从 0 开始）

登录页两个输入框都是 `.input-field` 是极常见的情况。不带下标就永远只能操作第一个，第二个框永远填不进去。快照给出的 selector 已经自动带好下标了，照抄即可。

## 基本操作

| 目的 | 工具 |
|---|---|
| 点击 | `wx_tap` |
| 填输入框 | `wx_input` |
| 自定义组件事件 | `wx_trigger`（指定事件名和 detail） |
| 等元素出现 / 等一会儿 | `wx_wait` |
| 跳转页面 | `wx_navigate`（tabBar 页面用 `switchTab`） |
| 直接调页面方法 | `wx_call_method` |

## 断言：看 data，不要看像素

判断一步是否成功，**优先读 `wx_page_data`**：

```
填用户名 → wx_page_data 应看到 data.account === "..."
填好账号 → data.account === true
提交后   → data.loading 从 true 回到 false
```

这比对比截图快、稳、且不受样式变化影响。截图用来做最终的视觉确认，不用来做逐步断言。

## 跑完整流程的标准套路

1. `wx_run` 把小程序跑起来
2. `wx_navigate` 直接跳到起始页（省掉一路点击）
3. `wx_snapshot` 拿当前页元素
4. `wx_input` / `wx_tap` 执行一步
5. `wx_wait` 等界面响应（点击后立刻断言常常拿到旧状态）
6. `wx_page_data` 断言这一步的结果
7. 页面变了就回到第 3 步重新快照——**页面跳转后旧 selector 全部失效**
8. 流程结束 `wx_screenshot` 做视觉确认，`wx_errors` 确认没有静默报错

## 让测试可控

- **隔离后端**：`wx_mock_wx_method` 打桩 `wx.request` / `wx.login` 等，让流程不依赖后端是否可用、数据是否存在。
- **跳过繁琐前置**：登录态、引导页这类前置，用 `wx_call_method` 直接调方法或 `wx_eval` 直接改状态，比每次都点一遍快得多。
- **别忘了查静默失败**：流程"看起来跑完了"不等于没问题，收尾一定要 `wx_errors` 看一眼有没有被 catch 掉的异常。

## 多步流程留证据

需要给用户回放操作过程时用 `wx_record`：连续截图并合成 GIF。适合演示 bug 复现、验收一个交互流程。
