---
name: wx-performance
description: 小程序性能与体积优化——setData 卡顿、滚动掉帧、长列表、包体积超限、首屏慢。当用户说"卡""慢""掉帧""滑不动""包太大""超过 2M"时使用。
---

# 小程序性能与体积

## 先测，再改

小程序的性能问题九成集中在两处：**setData** 和 **包体积**。两者都有工具能直接测出来，**不要靠读代码猜**。

## 卡顿 / 掉帧 / 输入卡手 → 查 setData

小程序的逻辑层和渲染层是两个线程，`setData` 要把数据 JSON 序列化后跨线程传输。调用太频繁、或单次传太大，都会直接卡住渲染。

### 诊断流程

```
1. wx_run                                  跑起来
2. wx_setdata_monitor  action="start"      开始监控当前页面
3. 复现卡顿场景                              滚动 / 快速输入 / 加载数据
4. wx_setdata_monitor  action="report"     看结论
```

报告长这样：

```
监控 8.2s，共 147 次 setData，合计 3.2MB
频率 17.9 次/秒 · 单次平均 22.3KB · 100ms 内最多连续 23 次

按字段（数据量降序）：
   2.9MB    31 次  [list]
   ...

发现的问题：
  ⚠️ 存在 100ms 内连续 23 次 setData 的突发 —— 这是掉帧的典型原因
  ⚠️ 字段 [list] 单次平均 95KB —— 长列表要用局部更新，不要整个数组重设
```

**关键是「按字段」那一段**：它直接指出是哪个 data 字段在吃性能，你去代码里搜这个字段就能定位。

### 三类典型问题与改法

**1. 整个数组重设（最常见）**

```js
// ✗ 每次都把整个列表序列化一遍
this.data.list[3].checked = true
this.setData({ list: this.data.list })

// ✓ 只传变化的那一项
this.setData({ 'list[3].checked': true })
```

**2. 高频调用没合并**

滚动、输入、倒计时里的 `setData` 要节流，或者把多次调用合并成一次：

```js
// ✗ 三次跨线程通信
this.setData({ a: 1 }); this.setData({ b: 2 }); this.setData({ c: 3 })
// ✓ 一次
this.setData({ a: 1, b: 2, c: 3 })
```

**3. 往 data 里塞了渲染用不到的东西**

`data` 只应该放模板真正要渲染的字段。原始接口响应、大对象、图片 base64 一律放在 `this.xxx` 普通属性上，不要进 `data`。

### 长列表

超过几百条就不要靠 `setData` 全量渲染了。按代价从低到高：

1. **分页 / 触底加载**，配合 `wx.createIntersectionObserver`
2. **只渲染可视区**（`recycle-view` 或自行实现虚拟列表）
3. 列表项抽成自定义组件，让更新范围局限在组件内

## 包体积超限 → `wx_analyze_size`

直接给出主包/分包各自的体积、对照官方限制、最大的文件、按类型占比：

```
❌ 主包           2.31 MB / 2.00 MB  (115%, 142 个文件)
✅ pages/mall      890 KB / 2.00 MB
```

官方限制：**主包 2MB、单个分包 2MB、合计 20MB**。

### 按报告里的大头对症下药

- **图片占大头** → 静态图片不要放进包里，传 CDN；小图标用 SVG 转 base64 或字体图标；确实要打包的先压缩
- **`.js` 占大头** → 先看是不是把整个 UI 库全量引入了（按需引入 / uni-app 用 easycom）；检查有没有把 `node_modules` 里的大依赖打进来
- **某个页面模块特别大** → 挪进分包
- **字体文件** → `.ttf` 动辄几百 KB，只用几个图标的话换 SVG

### 分包

```json
{
  "pages": ["pages/index/index"],
  "subPackages": [
    { "root": "pages/mall", "pages": ["list", "detail"] }
  ],
  "preloadRule": {
    "pages/index/index": { "network": "all", "packages": ["pages/mall"] }
  }
}
```

要点：

- **主包只放 tabBar 页面和真正的启动路径**，其余全进分包
- 分包之间不能互相引用；公共代码放主包，或用「分包公共依赖」
- 配 `preloadRule` 预下载，避免用户进分包时白等

## 首屏慢

排查顺序：

1. `wx_setdata_monitor` 看 `onLoad`/`onShow` 里是不是一上来就灌了大量数据
2. `wx_logs` 看接口请求耗时——首屏串行请求是常见原因，能并行的用 `Promise.all`
3. 检查 `onLoad` 里有没有同步的重计算
4. 骨架屏不解决慢，只改善观感；但对首屏体验确实有效

## 改完要复测

改完之后重新走一遍 `wx_setdata_monitor` 或 `wx_analyze_size`，**用数字证明改进有效**，不要只说"应该快了"。
