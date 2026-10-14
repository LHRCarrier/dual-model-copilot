# 取回方案方（ChatGPT 网页版）的回答

方案方 = ChatGPT 网页版，走**应用内置浏览器**（`iab`）。

> ⚠️ **不要为了它去拉起带调试端口的浏览器。** 那类命令会被本机安全策略拦下；
> 联想浏览器那类定制版还会在人机校验时把 WebSocket 升级挂死 —— HTTP 接口照样秒回，看着像能用，实际连不上。

## 第 0 步：把 ChatGPT 打开

**先找，找不到再开。** 标签页 id 和浏览器 id 每台机器、每次会话都不一样 —— **别照抄示例里的数字**。

```js
// ① 发现：看有哪些浏览器、各自开了什么标签页
const st = await cua.getState();
// 内置浏览器的 type === "iab"；它 tabs 里若已有 chatgpt.com，直接用那个 tab.id

// ② 已经有就直接绑定
// const t = await cua.getTab("<tab id>", { browser: "<iab 的 id>" });

// ③ 没有就开一个（visible:true 让用户也能看见）
const t = await cua.createBrowserTab("<iab 的 id>", "https://chatgpt.com/", { visible: true });
```

**确认登录**：页面上没有"登录"按钮、并且能看到"新聊天"或资料菜单 → 已登录。
看见登录按钮就是没登录 —— **登录是用户的手动步骤，不要代填账号密码**，直接告诉用户「请在内置浏览器里登录一次 ChatGPT」。

**选对话**：

- 开新对话（推荐，避免污染用户已有对话）：`await t.goto("https://chatgpt.com/")`
- 继续某条已有对话（追问轮、或新会话接续时按 `00-状态.md` 里记的 URL）：`await t.goto("https://chatgpt.com/c/<id>")`

## 第 1 步：发需求

```js
const c = t.playwright.locator('div[contenteditable="true"]').last();
await c.fill(需求文本);
try { await t.playwright.getByRole("button", { name: "发送消息" }).click({ timeoutMs: 8000 }); }
catch { await c.press("Enter"); }
```

## 第 2 步：等它答完（另起一次调用）

轮询 `document.body.innerText.length`，连续三次不变即认为结束：

```js
const lenOf = () => t.playwright.evaluate("document.body.innerText.length");
```

## 第 3 步：取回正文

```js
const txt = String(await t.playwright.evaluate("document.body.innerText"));
const i = txt.lastIndexOf("【");                 // 需求第一段的开头标记
const answer = i >= 0 ? txt.slice(i + 需求长度) : txt.slice(-9000);
```

把需求第一行的前几个字当锚点，定位到"回显"之后就是回答。收尾 `await t.markDeliverable()`，让标签页留到下一轮，用户也能自己回看。

## 追问轮（同一对话里续问）

同一个对话里再发一条即可，上下文免费；**不要为了追问另开新对话** —— 那样它会把上一轮忘掉。

```js
const c2 = t.playwright.locator('div[contenteditable="true"]').last();
await c2.fill(追问包);
await c2.press("Enter");                          // 或用 getByRole("button", { name: "发送消息" })
```

判完成、取正文的办法与第一轮完全一样。追问包里**不要替它补全前提后直接要结论** —— 那等于你自己写方案。

## 踩过的坑（都是实测出来的）

- **别在一次工具调用里等太久。** 调用有约 300 秒上限。绑定标签页和长轮询**分两次调用**，轮询按 6 秒一次、不超过 30 次。
- **不要用 URL 判断是否发送成功。** 发送后地址栏会变成 `/c/<新 id>`，但读取时可能还是 `chatgpt.com/`（跳转还没发生），这时消息其实已经发出去了。
- **输入框只认 `div[contenteditable="true"]`**（ChatGPT 用 ProseMirror）。`#prompt-textarea` 不一定存在，别依赖它。
- **`button[data-testid="send-button"]` 在这套页面上不存在**；发送按钮靠 `getByRole("button", { name: "发送消息" })` 找，找不到就按 Enter。
- **回答很长时无障碍树会被截断** —— 要正文就老老实实 `evaluate` 取 `body.innerText`，别指望 AX 快照。
- **超时会导致内核重置**，先前绑定的 tab 全部失效；重新 `getTab` 即可，不是页面坏了。
- **每次绑定标签页都会把整页内容回显出来**（很长）。尽量一次绑定、把剩下的读取在同一次调用里做完。
- **页面卡在"请稍候…"**是 Cloudflare 人机校验；把标签页切到前台（`goto`，或让用户点一下）通常就过去了。

## 隐私

ChatGPT 网页端是**外部服务** —— 发过去的内容等于离开本机。需求里不写密钥、`.env`、真实凭证、用户原话、内部域名与账号，只给最小必要上下文。