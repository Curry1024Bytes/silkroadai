# W9 D2 — Proxy `image_url` 入参 + 自动 R2 上传返 URL

> 部署日期:2026-06-05。prod `71ef053` → `4a0bb85`(PR [#75](https://github.com/yexioy/silkroadai/pull/75))。
> Phase 2 of the /v1/\* proxy。**不动 Caddy**(D1 已分流)。回滚 = `git revert` + 重 build portal。

---

## 1. 改了什么(`src/app/v1/[...path]/route.ts`,Branch 1 扩展)

### 入参 — OpenAI multimodal `image_url`

`/v1/chat/completions` 的 `content` 现支持数组形,`image_url` 项两种来源:

- **data URL**(`data:image/...;base64,...`)→ 直接解 base64。
- **外部 http(s) URL** → portal fetch 后转 base64,翻译成 Gemini `inlineData`。
    - **SSRF 基础守门**:协议白名单(仅 http/https)+ 拒 `localhost` / `*.local` / `*.internal` / IPv6 字面量 / 私网 IPv4 字面量(0/10/127/169.254/172.16-31/192.168)。
    - **15s 超时 + 20MB 上限**。
    - fetch 失败 / 非 2xx / 超限 → **400 `invalid_request_error`**(不是 500)。

### 出图 — R2 公网 URL(不再内联 base64)

Gemini 出图后上传 R2(`gen/{uuid}.{ext}`,复用 `src/lib/r2/client.ts` 的 `uploadImage`,immutable cache),`content` 返 `![image](https://images.silkroadai.io/gen/<uuid>.<ext>)`。

- R2 不可用 → **降级**回 data URL 内联 + 响应头 `X-Silkroadai-R2-Fallback: yes`(客户请求不因存储故障而失败)。
- 响应头 `X-Silkroadai-Translated: gemini-native` 不变。

仅 2 文件改动(route.ts + proxy.test.ts);`r2/client.ts` 未改(其 `uploadImage(key, body, contentType)` 早已返 public URL)。

---

## 2. Smoke 结果(全过,prod 公网)

| #   | 检查                             | 结果                                                                         |
| --- | -------------------------------- | ---------------------------------------------------------------------------- |
| 1   | `image_url` 入参 + R2 出图       | ✅ data URL + picsum 外部 URL 两路均返 R2 https URL,无 base64,无 fallback 头 |
| 2   | 返回的 R2 URL 真实可访问 + 2K    | ✅ `curl` 200 / **2048×2048** / 623 KB                                       |
| 3   | text-only 出图也走 R2(D1 回归)   | ✅ `![image](https://images.silkroadai.io/gen/...jpg)`                       |
| 4   | 坏 `image_url` → 400(不是 500)   | ✅ 400                                                                       |
| 5   | Claude clamp + GPT 透传(D1 回归) | ✅ 200 + `x-silkroadai-clamped` / gpt-5.4 200                                |

R2 URL 样例:`https://images.silkroadai.io/gen/bf8f127f-ce8c-40d6-bbb9-da83648c03d6.jpg`(2048×2048)。
portal log 扫 `R2 upload failed` / error / fatal:**0 条**(`[v1-proxy]` fallback 日志 0)。

### ⚠️ 关于 brief 原 smoke 1 的 wikimedia fixture

brief 给的 `upload.wikimedia.org/.../1024px-Cat03.jpg` 从 **VPS egress IP 直接 400**(空 UA 403、浏览器 UA 也 400、node fetch 400)—— wikimedia 对数据中心 IP 的反盗链/policy,**不是 proxy bug**。proxy 行为正确:外部 URL 拉取失败 → 干净 400。故改用 VPS 可达的 `picsum.photos` + 自造 data URL 验证,核心功能完整跑通(R2 2K 出图)。
**客户提示**:`image_url` 指向对数据中心 IP 严格的站点(wikimedia 等)会拿 400;建议用宽松 CDN 或先自行下载传 data URL。

---

## 3. 已知边界 / 后续

- **`gen/` 前缀不在 image-cleanup cron 管辖**(cron 按 `ImageGeneration` DB 行删 `image-gen/`)→ 会累积。建议 operator 在 Cloudflare R2 配 lifecycle rule(如 90 天)或后续 PR 接管。
- **SSRF 守门是基础版**(协议 + IP 字面量);DNS rebinding(域名解析到私网)防护留 **Phase 3**。
- image_url 外部拉图:**15s 超时 / 20MB 上限**。
- 未动客户余额 / ModelPrice / ModelRatio / new-api 源码 / Caddy;未调 `GET /api/user/token`。
- **Phase 3(自定义 OSS,9–11h)待 operator 绿灯,未开始。**
