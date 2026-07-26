---
name: wx-api-troubleshoot
description: wx API 调用排查——请求失败、域名白名单、授权被拒、真机与模拟器表现不一致、存储、支付、分享。当某个 wx.xxx 调用"没反应"或只在真机上出问题时使用。
---

# wx API 排查

## 先确认 API 到底返回了什么

大部分"没反应"是因为 API 走了 `fail` 分支而代码没处理。直接问它：

```
wx_eval  "return new Promise(r => wx.getSetting({ success: s => r({ok:true, ...s}), fail: e => r({ok:false, err:e.errMsg}) }))"
```

这个模式适用于所有异步 wx API —— 把 `success`/`fail` 都接住再返回，就能看到真实结果，而不是猜。

## 请求失败

排查顺序：

1. **`wx_logs`** 看有没有报错，errMsg 通常直说了原因
2. **域名白名单**：`request:fail url not in domain list` —— 接口域名必须先在微信公众平台配置。开发者工具可以勾「不校验合法域名」绕过，**但真机不行**，这是模拟器能通、真机不通的头号原因
3. **协议**：必须 HTTPS，证书要有效
4. **超时**：默认 60s，AI 类长接口要显式设 `timeout`
5. **并发限制**：小程序同时最多 10 个请求，超了会排队

隔离网络因素：

```
wx_mock_wx_method  method="request"  result={statusCode: 200, data: {...}}
```

桩上去之后界面正常了，说明问题在网络/后端，不在前端逻辑。

## 授权类 API

**授权只能由用户点击触发**，不能在 `onLoad` 里自动调。

查当前授权状态：

```
wx_eval  "return new Promise(r => wx.getSetting({success: s => r(s.authSetting)}))"
```

**用户拒绝过一次之后，再调同一个 API 不会再弹窗，直接走 fail** —— 表现就是"点了没反应"。必须处理这个分支，引导用户去 `wx.openSetting`。这是最常见的授权 bug。

## 存储

```
wx_eval  "return wx.getStorageInfoSync()"                    # 看用了多少、有哪些 key
wx_eval  "return wx.getStorageSync('token')"                 # 读
wx_eval  "wx.removeStorageSync('token'); return 'removed'"   # 删，模拟登录态失效
wx_eval  "wx.clearStorageSync(); return 'cleared'"           # 清空，模拟首次进入
```

限制：单个 key 最大 1MB，总共 10MB。超了 `setStorage` 会失败——存大对象前先想清楚。

## 模拟器通过、真机不通

这类问题最费时间。**改完涉及以下能力的代码，一定要 `wx_preview` 出二维码在真机验一遍**：

| 领域 | 模拟器与真机的差异 |
|---|---|
| 网络 | 模拟器可跳过域名校验，真机严格校验白名单 |
| 支付 | 模拟器无法真实支付 |
| 定位/相机/蓝牙/录音 | 模拟器多为假数据或直接不支持 |
| 分享 | 转发卡片的真实效果只有真机能看 |
| 性能 | 模拟器跑在电脑上，掩盖真机的性能问题 |
| 基础库版本 | 用户手机可能低于开发者工具版本，新 API 要判断可用性 |

API 可用性判断：

```
wx_eval  "return { canUse: wx.canIUse('chooseMedia'), sdk: wx.getSystemInfoSync().SDKVersion }"
```

低版本要用 `wx.canIUse` 做兜底分支，不要直接调新 API 然后崩掉。

## 支付

链路：后端下单拿 `prepay_id` → 生成签名参数 → 小程序 `wx.requestPayment`。前端能查的只有最后一步：

```
wx_eval  "return new Promise(r => wx.requestPayment({ /* 参数 */ success: s => r({ok:true}), fail: e => r({ok:false, err: e.errMsg}) }))"
```

常见 errMsg：

- `fail cancel` —— 用户主动取消，**不是错误**，不该弹错误提示
- 签名错误 —— 后端签名算法或密钥问题，前端改不了
- 商户号未开通 —— 后台配置问题

## 分享

- `onShareAppMessage` 必须在页面里定义，否则菜单里没有「转发」
- `onShareTimeline`（朋友圈）要单独定义，且有限制
- 分享路径要带全参数，且**目标页面必须能处理无登录态的冷启动**——别人点开时是全新会话

验证冷启动路径：

```
wx_eval  "wx.clearStorageSync(); return 'cleared'"
wx_navigate  "/pages/xxx/index?id=123"  kind="reLaunch"
wx_screenshot
```

## 实在找不到原因

把调用整个包起来看它到底走到哪一步：

```
wx_eval  "return new Promise(r => { try { wx.someApi({ success: s => r({phase:'success', s}), fail: e => r({phase:'fail', e}) }) } catch (err) { r({phase:'throw', msg: String(err)}) } })"
```

`phase` 会告诉你是同步抛错、走了 fail、还是根本没回调（多半是参数格式不对）。
