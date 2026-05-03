# W3 D2 — Portal e2e Verification Report

**Date**: 2026-05-03
**Branch**: `feat/w3-d2-e2e-verify`
**Base commit**: `cb2895a`
**Verifier**: Cowork(strategist)+ Claude Code(executor),advisory-mode handoff
**Scope**: 标准档 — tsc + lint + smoke + register e2e + 三种格式真实模型调用 + 用量回查

---

## TL;DR

LiteLLM 在 W3 D1(2026-05-02 晚)关停后,portal 注册 → new-api 拿 sk-xxx → 真实调用 ai.silkroadai.io 三种格式模型 → 用量回查的整条链路 **全程 200**。W3 D2 验证信号绿,可以推进 D3 — **但 D3 启动前必须先清掉 Finding F1(SiliconFlow 短名回归)**,否则任何 W1 客户在用 `deepseek-v4-flash` 等短名的请求会持续 503。

## 验证矩阵

| 项 | 期望 | 实测 | 结果 |
|---|---|---|---|
| feat 分支 + working tree clean | yes | yes | ✅ |
| SSH 隧道 + new-api `/api/status` 200 | 200 + new-api envelope | 200 + `data.{HeaderNavModules,api_info,...}` | ✅ |
| `pnpm tsc --noEmit` | exit 0,0 errors | exit 0 | ✅ |
| `pnpm lint` | exit 0,error=0 | exit 0,errors=0,warnings=51(历史遗留) | ✅(F4) |
| `pnpm vitest run src/lib/newapi` | all PASS | 1 file / 3 tests / 1.51s | ✅ |
| `POST /api/auth/register` | 200 + sk-xxx | 200,user_id=8,sk-prefix=`e0QdAg2nQQnK` | ✅ |
| Prisma User+NewApiToken + new-api user 一致 | 三处对得上 | 对得上,access_token 32 chars 不为空 | ✅ |
| `addQuota(8, 500000)` | quota 0→500000 | 0→500000 实测 | ✅ |
| `claude-opus-4-7` via ai.silkroadai.io | 200 + content | 200,3.01s,channel=2(sub2api-claude) | ✅ |
| `gpt-5.4` via ai.silkroadai.io | 200 + content | 200,2.97s,channel=3(sub2api-openai) | ✅ |
| `deepseek-v4-flash` via ai.silkroadai.io | 200 + content | **503 model_not_found**(F1) | ❌ → fallback ✅ |
| `deepseek-ai/DeepSeek-V4-Flash` via ai.silkroadai.io | n/a(fallback) | 200,3.82s,channel=1(SiliconFlow) | ✅ |
| `/api/log/?user_id=8` 回查 | ≥3 条调用 | 4 条(3 调用 + 1 add_quota event) | ✅ |
| `/api/log/?username=c-8a6901f3` filter | ≥3 条 | 0 条(F2 — filter quirk) | ⚠️(F2) |
| 后台进程清理 | 都关 | dev server + next-server 子进程都关,/tmp 清 | ✅ |

**结论:核心信号 ✅。3 个非阻塞观察(F2/F3/F4)+ 1 个语义 ⚠️(F1,deepseek-v4-flash 短名 — D3 前置 blocker)+ 1 个情境变化(F5,模型规模翻倍)。**

## Findings

### F1 [P0 / D3 前置 blocker] SiliconFlow 短名 `deepseek-v4-flash` 503

- **症状**:`POST https://ai.silkroadai.io/v1/chat/completions` model 字段填 `deepseek-v4-flash` → `503 model_not_found "no available channel for model deepseek-v4-flash under group default"`。canonical 名 `deepseek-ai/DeepSeek-V4-Flash` 路由到 SiliconFlow channel=1 正常 200。
- **影响**:任何 W1 时代用过短名(`deepseek-v4-flash` 等)的客户 / 前端代码 / 文档示例,从 W3 D1 切到 new-api 后 → **持续 503**。可能是静默漏(没看到投诉但流量在掉)。
- **根因假设**(待 Batch D 实查):SiliconFlow 渠道的 `model_mapping` 在 W3 D1 配置或后续 SiliconFlow 扩容到 291 模型的过程中丢失或未生效。silkroadai-project-memory.md 明确写了 W3 D1 配过短名 mapping。
- **修复方案**(待 Batch D 落地):
  - (a) admin UI 给 SiliconFlow 渠道补上 `model_mapping`,把所有 W1 时代公开过的短名重新映射到 canonical 名 — **推荐**,在 admin 改一下,客户接口最稳
  - (b) 前端 / 文档全切到 canonical 名,接受短名失效 — 客户面破坏性,不推荐
  - (c) portal 层做名称映射 — 脏(把上游知识泄到 portal),不推荐
- **行动**:Batch D(D3 前置 blocker)走 (a),并跑全 W1 短名清单回归。

### F2 [P3 / 跟踪] `/api/log/?username=` filter 返回 0

- **症状**:`/api/log/?user_id=8` 返回 4 条,`/api/log/?username=c-8a6901f3` 返回 0。
- **怀疑**:new-api 对 `c-` 前缀字符串的 filter 处理 bug,或 query string urlencoding。
- **影响**:portal 后台用量页如果将来用 username filter 会拿不到数据,改用 user_id 即可。
- **行动**:不阻塞 D2/D3。W4 写客户后台用量页时再实查,届时如果还是这样就用 user_id filter。

### F3 [P3 / 已知] new-api `user.email` 字段空串

- W2 D6 已发现,W3 没动。cosmetic,不影响功能。
- **行动**:不阻塞。客户后台展示客户信息时如果要显示 email,从 portal 自己的 User 表读,不依赖 new-api 这边的字段。

### F4 [P3 / 技术债] 51 lint warnings

- 全部继承自 W1 / Sub2API 期。分布:18× react-hooks/exhaustive-deps,8× @next/next/no-img-element,5× @typescript-eslint/no-unused-vars,余 20+ 散在 `src/app/admin` `subscriptions` `provider` 等。
- W3 D2 这一轮没新增 warning。
- **行动**:W4 / W5 客户后台 + LibreChat 改造时一并清。

### F5 [info / 情境变化] SiliconFlow 渠道 117 → 291 模型

- W3 D1 后 SiliconFlow 模型扩到 291,新增 GPT-4o / o1 / o3 / o4-mini / sora-2 / dall-e / whisper / tts / embedding 等大量 OpenAI 系 + 多模态 + audio + embedding 模型。
- silkroadai-project-memory.md 里写的「117 模型」需要在下次更新时改成 291。
- **UX 后果**:客户从 portal 选 model 时面对 291 个选项会混乱,而且 `zai-org/*` `deepseek-ai/*` `netease-youdao/*` 等带斜线的厂商前缀混排不友好 — 模型选择 UI 在 W3 D6-D7 OAuth 后或 W5 LibreChat fork 时务必按厂商 / 类型(chat/image/audio/embedding)分组。
- **行动**:不阻塞 D2/D3。在 W4-W5 设计客户后台 + Chat UI 模型选择器时纳入。

## 测试遗留资源

W3 D2 Batch B 留下一个测试客户(没删,W4 充值流验证 + D3 login/forgot 测试复用):

- portal user email: `w3d2test-1777777442@silkroadai-internal.test`
- portal user id (UUID): `8a6901f3-0054-42b2-87fc-edb24148440a`
- new-api user id (int): `8`
- new-api username: `c-8a6901f3`
- sk-xxx 前 12 字符:`e0QdAg2nQQnK`(完整值已 shred)
- 末尾 quota 余额:~497532 raw quota(500000 充值 - ~2468 三次调用消耗)

## 后续(W3 D3+)

- **必须先做**:Batch D(F1 短名 model_mapping 修复 + W1 短名清单回归)— D3 前置 blocker
- **D3-D5**:login / forgot password / 邮箱验证(QQ SMTP)
- **D6-D7**:Google OAuth(via OIDC)+ GitHub OAuth(原生)

---

**Signed-off**:W3 D2 验证信号 ✅,Batch C 收尾 PR 进入 review。
