---
name: wx-component-debug
description: 自定义组件调试——组件不更新、props 没传进去、事件传不出来、slot 不显示、组件样式不生效、元素点不到。当问题出在某个组件内部而不是页面上时使用。
---

# 自定义组件调试

## 页面 data 里看不到组件的状态

这是最容易卡住的地方：**组件有自己独立的 data 和 properties**，`wx_page_data` 只能看到页面的。组件"没更新"的问题，必须看组件内部。

```
wx_component  selector=".kn-sheet"  action="data"     # 读组件内部 data + properties
wx_component  selector=".kn-sheet"  action="call"  method="open"    # 调组件方法
wx_component  selector=".kn-sheet"  action="setData"  patch={visible: true}   # 直接构造状态
```

`action="setData"` 特别有用：不用一路点开，直接把组件设成你要调试的那个状态。

## 常见症状对照

### 「props 传了但组件没反应」

1. `wx_component action="data"` 看组件里到底收到了什么
2. 收到了但界面没变 → 组件内部没有监听变化。`properties` 的 `observer` 或 `observers` 写了吗？
3. **根本没收到** → 检查属性名。WXML 里必须用**连字符**，组件里声明的是**驼峰**：

```html
<!-- ✗ 传不进去 -->
<my-card userName="{{name}}" />
<!-- ✓ -->
<my-card user-name="{{name}}" />
```

4. 收到的是字符串而不是对象/数字 → `properties` 里的 `type` 声明错了

### 「组件里的事件传不到页面」

组件内部要 `this.triggerEvent('confirm', detail)`，页面上要 `bind:confirm` 或 `bindconfirm`。

验证链路：

```
wx_component selector=".xxx" action="call" method="触发事件的那个方法"
wx_page_data          # 看页面状态有没有跟着变
wx_logs               # 看组件和页面里的 console
```

页面没反应但组件方法确实执行了 → 多半是事件名不匹配（组件 `triggerEvent('confirm')` vs 页面 `bind:sure`），或者事件名用了驼峰（**事件名不要用驼峰**，`triggerEvent('myEvent')` 在页面上要写 `bind:myEvent`，容易出错，建议全小写）。

### 「组件不显示 / 显示了但看不见」

先分清是**没渲染**还是**渲染了但不可见**：

```
wx_snapshot           # 结构里有没有这个组件的标签？
wx_element_box selector=".xxx"    # 有标签的话，看它的实际尺寸
```

- 结构里没有 → `usingComponents` 没注册，或路径写错（uni-app 用 easycom 时检查组件文件名和目录规范）
- 有标签但 `width` 或 `height` 是 **0** → 元素在，只是没撑开。常见原因：组件根节点没设样式、父容器 `flex` 布局把它压没了
- 尺寸正常但看不见 → 被遮挡（z-index）、`opacity: 0`、颜色和背景同色

`wx_element_box` 返回宽高为 0 时会直接提示这一点。

### 「组件样式不生效」

小程序自定义组件**默认样式隔离**——页面的样式进不去组件，组件的样式也出不来。

- 想让页面样式影响组件：组件里设 `options: { styleIsolation: 'apply-shared' }`
- 想传特定样式：用 `externalClasses` 或 CSS 变量
- uni-app + scoped：`::v-deep` / `:deep()` 穿透

调试时先确认是不是隔离问题：`wx_component action="data"` 确认组件状态正确 + `wx_element_box` 确认尺寸正常，那基本就是样式没进去。

### 「slot 里的内容不显示」

- 组件必须声明 `options: { multipleSlots: true }` 才能用具名 slot
- slot 内容的**数据作用域属于页面**，不是组件——在 slot 里用组件的 data 是拿不到的

## 定位组件里的子元素

`wx_snapshot` 给的 selector 是页面视角的。要操作组件**内部**的元素，先确认它在不在快照的结构里（组件内部结构通常会展开显示）。拿不到就退回用 `wx_component action="call"` 调组件方法来触发。

## uni-app 特有

- **easycom**：组件放在 `components/组件名/组件名.vue` 会被自动注册，不用手动 `import`。路径不规范就是"组件不存在"
- **`uni_modules`** 里的组件同样走 easycom
- uni-app 编译后组件标签名会变（`<uni-icons>` → 编译产物里的形式），`wx_snapshot` 看到的是**编译后**的名字，按它给的 selector 用
