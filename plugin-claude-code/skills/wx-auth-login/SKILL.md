---
name: wx-auth-login
description: 微信小程序登录鉴权与授权调试——wx.login/code2session、获取手机号、用户信息授权、token 刷新、登录态失效。当涉及登录流程、授权弹窗、401、"登录不上"时使用。
---

# 登录鉴权与授权

## 小程序登录的标准链路

```
wx.login()  →  拿到 code（5 分钟有效，一次性）
     ↓ 把 code 发给自己的后端
后端调 code2session（带 appid + appsecret）
     ↓ 换到 openid / unionid / session_key
后端签发自己的 token（JWT 等）返回给小程序
     ↓
小程序存起来，后续请求带上
```

**关键点**：`appsecret` 和 `session_key` **只能待在后端**。小程序端出现 appsecret 就是严重安全问题，看到必须指出来。

## 调试流程

登录问题最麻烦的是"要点好几步才能复现"。用工具跳过手工操作：

```
1. wx_run
2. wx_navigate  "/pages/demo/form"      直接跳到登录页
3. wx_snapshot                            看清元素绑定（哪个框是密码、按钮调哪个方法）
4. wx_input / wx_tap  或  wx_call_method  执行登录
5. wx_logs                                看请求和返回
6. wx_page_data                           看 token 有没有存进去
```

**更快的办法**：`wx_call_method` 直接调 `onSubmit()`，跳过填表。

## 定位失败在哪一环

登录失败要先分清是**哪一段**出的问题：

```
wx_eval  "return new Promise(r => wx.login({success: res => r(res.code), fail: e => r('FAIL:'+e.errMsg)}))"
```

- 拿不到 code → 小程序端问题（开发者工具没登录、appid 不对）
- 有 code 但后端报错 → 看 `wx_logs` 里的接口响应；常见是后端 appid/appsecret 配错，或 code 被用过第二次（code 一次性）
- 后端返回了 token 但小程序没存 → `wx_page_data` 和 `wx_eval "return wx.getStorageSync('token')"` 对一下

## 存储里的登录态

```
wx_eval  "return { token: wx.getStorageSync('token'), userInfo: wx.getStorageSync('userInfo') }"
wx_eval  "wx.clearStorageSync(); return 'cleared'"      模拟首次进入 / 登录态失效
```

清掉 storage 再 `wx_navigate` 重进，是复现"新用户首次进入"最快的方式。

## 授权类 API 的坑

**必须由用户点击触发**，不能在 `onLoad` 里自动调：

| 能力 | 正确做法 |
|---|---|
| 获取手机号 | `<button open-type="getPhoneNumber" bindgetphonenumber="...">`，拿到的是加密数据，**必须后端解密** |
| 用户昵称头像 | `wx.getUserProfile` 已废弃；现在用「头像昵称填写能力」（`<button open-type="chooseAvatar">` + `<input type="nickname">`） |
| 位置、相机等 | `wx.authorize` 或直接调 API 触发弹窗；用户拒绝过就不会再弹，只能引导去 `wx.openSetting` |

**用户拒绝授权后**再调同一个 API 会静默失败（走 fail 分支且不弹窗）。必须处理这个分支，引导用户去设置页打开，否则表现就是"点了没反应"。

排查是否被拒绝过：

```
wx_eval  "return new Promise(r => wx.getSetting({success: res => r(res.authSetting)}))"
```

## 用打桩隔离后端

后端没跑、或者要测异常分支时，把网络层桩掉：

```
wx_mock_wx_method  method="login"    result={code: 'MOCK_CODE'}
wx_mock_wx_method  method="request"  result={statusCode: 401, data: {code: 40101, message: 'token 过期'}}
```

这样可以稳定复现「token 过期 → 自动刷新 → 重放请求」这类平时很难触发的路径。

## token 刷新与并发

401 自动刷新 token 是标配，但**并发请求下容易出问题**：多个请求同时 401，会同时去刷新，导致刷新接口被打多次、甚至互相把对方的新 token 覆盖掉。

正确做法是刷新期间把后续请求排队，刷新成功后统一重放。验证方式：

```
wx_mock_wx_method 让 request 返回 401
同时触发多个请求（wx_call_method 连续调几个加载方法）
wx_logs 看刷新接口被调了几次 —— 应该只有 1 次
```

## 真机与模拟器的差异

开发者工具里能登录不代表真机能：

- 模拟器不校验**服务器域名白名单**，真机会。接口域名必须先在公众平台配好
- 模拟器的 `wx.login` 走的是工具账号，真机是真实用户
- 有些授权弹窗在模拟器上表现不同

所以登录流程改完，用 `wx_preview` 生成二维码在真机上验一遍。
