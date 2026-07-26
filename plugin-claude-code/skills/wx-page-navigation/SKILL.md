---
name: wx-page-navigation
description: 页面路由与生命周期——跳转失败、tabBar 跳不过去、页面栈溢出、返回后数据不刷新、参数传不过去、onLoad/onShow 执行时机。当问题涉及页面之间的跳转或页面生命周期时使用。
---

# 页面路由与生命周期

## 五种跳转，用错就跳不动

| API | 用途 | 页面栈 | 常见错误 |
|---|---|---|---|
| `navigateTo` | 打开新页面 | +1，**最多 10 层** | 用它跳 tabBar 页面 → 静默失败 |
| `redirectTo` | 替换当前页 | 不变 | 同样不能跳 tabBar |
| `switchTab` | 跳 tabBar 页面 | 清空到 1 | **URL 不能带参数** |
| `reLaunch` | 关掉所有页面重开 | 重置为 1 | —— |
| `navigateBack` | 返回 | -1 | 已经是第一页时会失败 |

**「跳转没反应」的两大原因**：

1. 用 `navigateTo` 跳 tabBar 页面 —— 必须用 `switchTab`
2. 页面栈已经 10 层 —— `navigateTo` 会直接失败

先看页面栈：

```
wx_navigate 前后各跑一次：
wx_eval  "return getCurrentPages().map(p => p.route)"
```

栈很深（接近 10）说明有地方在反复 `navigateTo` 而不返回，属于逻辑 bug，不是加大限制能解决的。

## switchTab 不能带参数

```js
// ✗ 参数会被丢掉
wx.switchTab({ url: '/pages/tree/index?id=123' })
```

要传数据给 tabBar 页面，只能：

- 存 storage / 全局变量，目标页 `onShow` 里读
- 用事件总线
- （uni-app）用 `uni.$emit` / `uni.$on`

## onLoad 与 onShow 的区别

这是"返回后数据不刷新"的根源：

- **`onLoad`** 只在页面创建时执行一次，参数从这里拿
- **`onShow`** 每次页面显示都执行 —— 包括**从其他页面返回时**

所以：

- 只在 `onLoad` 里加载数据 → 从详情页返回列表页，列表还是旧的
- 需要每次回来都刷新的数据，放 `onShow`
- 但要小心 `onShow` 里无条件请求会造成重复加载，通常要加个标记位

验证生命周期实际执行了几次，直接在代码里 `console.log` 然后：

```
wx_navigate 到目标页 → wx_navigate 走开 → 再返回
wx_logs        # 看 onLoad / onShow 分别打了几次
```

## 参数传递

```js
wx.navigateTo({ url: '/pages/detail/index?id=123&type=a' })
// 目标页
onLoad(options) { console.log(options.id, options.type) }
```

要点：

- 参数值必须 `encodeURIComponent`，中文和特殊字符不转会截断
- **参数都是字符串**，`options.id` 是 `"123"` 不是 `123`，比较时注意
- 传对象要 `JSON.stringify` + encode，但 URL 有长度限制，大数据用 storage 或事件

查目标页实际收到什么：

```
wx_navigate  "/pages/detail/index?id=123"
wx_page_data      # 看有没有正确解析进 data
wx_logs           # 看 onLoad 里打的日志
```

## 用工具跳过手工点击

调试深层页面时不用一路点过去：

```
wx_navigate  "/pages/member/detail?id=1"          直接跳
wx_navigate  "/pages/tree/index"  kind="switchTab"  跳 tabBar
wx_navigate  ""  kind="navigateBack"               返回
wx_eval  "return getCurrentPages().map(p => p.route)"   看栈
```

**注意**：直接跳转会跳过前置页面的初始化逻辑（比如列表页给详情页设的全局变量）。如果目标页依赖这些，直接跳可能出现"只有这样跳才报错"的假象——这时要么按正常路径走一遍，要么先用 `wx_eval` 把依赖的状态构造好。

## 自定义 tabBar

`pages.json` / `app.json` 里 `"custom": true` 时，tabBar 是你自己的组件：

- `switchTab` 仍然要用（路由归框架管），但高亮状态要自己维护
- 常见 bug：`switchTab` 之后自定义 tabBar 的选中态没跟着变 —— 要在每个 tab 页的 `onShow` 里同步

用 `wx_component` 直接读自定义 tabBar 组件的 data，就能确认选中态对不对。

## uni-app 差异

- API 前缀是 `uni.` 而不是 `wx.`（`uni.navigateTo`），但 `wx.` 也能用
- 页面路径在 `pages.json` 里配置，编译后才生成 `app.json`
- `onLoad`/`onShow` 写在 Vue 的 `methods` 同级（Options API 里直接作为选项），不是 `mounted`
- 用 `uni.$emit` / `uni.$on` 做跨页通信，记得在 `onUnload` 里 `$off`，否则重复监听
