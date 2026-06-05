# W9 D1 — Portal /v1/\* 代理层上线 + Caddy 按路径分流

> 部署日期:2026-06-05。prod `840e132` → `71ef053`。
> 授权:operator「开 PR = merge = deploy」,按 gate 逐步执行,任何 gate 失败即停。

---

## 1. 两个 PR(均已 squash-merge 到 main,CI 全绿)

| 任务         | PR                                                  | merge commit | 内容                                                                                              |
| ------------ | --------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| #44 land WIP | [#73](https://github.com/yexioy/silkroadai/pull/73) | `a9c92e8`    | tz sweep(gotcha #20)+ gpt-image-2 ¥0.10 + **修复长期红的 CI**(4 个 stale 断言 + prettier 11 文件) |
| PR-A proxy   | [#74](https://github.com/yexioy/silkroadai/pull/74) | `71ef053`    | portal `/v1/*` catch-all 代理(Gemini image OpenAI→native 翻译 + Claude max_tokens 钳制)           |

> #73 把 main CI 从长期红转绿(Gate 1 实测 Format/Lint/Test/Type Check 全 pass);#74 在绿底上叠加,proxy 12/12 单测 + CI 全绿(Gate 2)。两者都是干净 squash。

---

## 2. 代理架构(PR-A)

新文件 `src/app/v1/[...path]/route.ts`(catch-all,Node runtime,force-dynamic):

- **Branch 1 — Gemini image**:`POST /v1/chat/completions` + `gemini-2.5-flash-image`(1K)/ `gemini-3.1-flash-image-preview`(2K)/ `gemini-3-pro-image-preview`(4K)→ 翻译到 new-api native `/v1beta/models/<model>:generateContent` 并注入 `imageConfig.imageSize`,响应转回 OpenAI `chat.completion` 形(图片 markdown data URL 内联)。**这让 OpenAI SDK 客户端也能拿真 2K/4K**(chat 兼容层只出 1K — 见 W8-D8 + #71)。响应头 `X-Silkroadai-Translated: gemini-native`。
- **Branch 2 — Claude clamp**:`claude-*` 且 `max_tokens > 4096` → 钳到 4096 + 响应头 `X-Silkroadai-Clamped: max_tokens=4096-was-<N>`(上游号池对超大 max_tokens 直接 4xx,钳掉对客户更友好)。
- **Branch 3 + 其余路径**:原样透传 new-api,streaming SSE 不缓冲(直接 forward upstream ReadableStream)。

边界:不鉴权(Authorization 原样透传,new-api 校验 sk-xxx);不读写 portal DB。`NEWAPI_BASE_URL=http://host.docker.internal:3000`(prod 容器内,与现有 portal→new-api 同路径)。

---

## 3. Caddy 按路径分流(⚠️ 不整域切)

portal 没有 `/v1beta` 路由,整域切会把 native Gemini 客户(/docs 教程刚教的)打 404。所以只把 `/v1/*` 给 portal,其余(含 `/v1beta`、`/v1/messages`、`/models`、admin/landing)留 new-api。

`/etc/caddy/Caddyfile` 的 `ai.silkroadai.io` 块(**surgical 改,其余块 byte 不变,diff 确认仅此块**):

```
ai.silkroadai.io {
    @portalv1 path /v1/*
    reverse_proxy @portalv1 localhost:3002 {
        flush_interval -1
        transport http { response_header_timeout 300s; dial_timeout 30s }
    }
    reverse_proxy localhost:3000 { ... read/write/response_header_timeout 600s }
    request_body { max_size 50MB }
    encode gzip
    header { HSTS + nosniff }
}
```

- **备份**:`/etc/caddy/Caddyfile.bak-w9d1`
- **回滚**:`ssh vps "sudo cp /etc/caddy/Caddyfile.bak-w9d1 /etc/caddy/Caddyfile && sudo systemctl reload caddy"`
- `caddy validate` → Valid;`systemctl reload caddy` → active。

---

## 4. Gate / Smoke 结果

| Gate                  | 结果                                                                |
| --------------------- | ------------------------------------------------------------------- |
| Gate 1(#73 CI)        | ✅ Format/Lint/Test/Type Check 全绿 + merged                        |
| Gate 2(#74 CI)        | ✅ 全绿 + merged,diff 仅 2 文件(route.ts + proxy.test.ts)           |
| Gate 3(deploy 前内部) | ✅ portal `/` 200 + 内部 proxy `/v1/chat/completions` 200(切流量前) |

Step 5 smoke(经 Caddy,公网):

| #   | 检查                                        | 结果                                                      |
| --- | ------------------------------------------- | --------------------------------------------------------- |
| 1   | Gemini 2K via OpenAI `/v1/chat/completions` | ✅ **2048×2048**(proxy 翻译生效;4/4 成功)                 |
| 2   | Claude clamp                                | ✅ 200 + `x-silkroadai-clamped: max_tokens=4096-was-8192` |
| 3   | GPT-5.4 streaming                           | ✅ SSE `data:` 块逐条                                     |
| 4   | `/v1beta` native 未被切走                   | ✅ 200(走 new-api,非 portal 404)                          |
| 5   | portal UI `/balance`                        | ✅ 307 → /login(未登录预期)                               |

---

## 5. 已知 / 监控

- **smoke 1 期间遇 1 次 upstream 500**:re-run 4/4 全 200,native `/v1beta` 同 prompt 也 200 → 确认是 nexaxis 号池**瞬时**抖动(W8 D8 已记录每日库存有限),proxy 正确把上游错误**原样透传**(无 portal crash、无 log),非回归。
- **`Failed to find Server Action "x"`**:Next.js redeploy 后的良性瞬时(旧页面 client 提交了已失效的 action id),刷新即恢复,与 proxy 无关。
- 部署后日志扫描 error/fatal/exception:除上述良性项外 0 条。30 分钟 watcher 已起(VPS `/tmp/watch-w9d1.log`,自动停)。

## 6. 边界确认

- 未动客户余额 / ModelPrice / ModelRatio / new-api 源码;未调 `GET /api/user/token`。
- **Phase 2(multimodal `image_url` 入参 + 图片 R2 上传返 https URL)未开始 — 待 operator 绿灯。**
