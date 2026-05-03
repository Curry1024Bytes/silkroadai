# W3 D3 — Login Endpoint Verification Report

**Date**: 2026-05-03
**Branch**: `feat/w3-d3-login`
**Base commit**: `87eb5f1` (PR #3 merged)
**Verifier**: Cowork(strategist)+ Claude Code(executor),advisory-mode handoff
**Scope**: 标准档 — `POST /api/auth/login` 实现 + 单测 + 真实 e2e + cookie 反解 + apiKey 真打公网

---

## TL;DR

`POST /api/auth/login` 端点上线,**6/6 单测 GREEN + 4 条 e2e 状态码全对 + cookie 签名反解 userId 一致 + login 返回的 apiKey 真打 ai.silkroadai.io 短名 200**(顺手验 W3 D2.5 SiliconFlow `model_mapping` 修复仍稳)。Cookie session(JWT,httpOnly,SameSite=Lax,7d)+ 不区分"邮箱不存在"和"密码错"的统一 401 都按设计落地。W3 D3 信号绿。

## 验证矩阵

| 项 | 期望 | 实测 | 结果 |
|---|---|---|---|
| Branch + 起点 untracked 状态 | working tree 有 login dir | yes(`route.ts` + `__tests__/route.test.ts`)| ✅ |
| dev server `pnpm next dev -p 3002` ready | 30s 内 ready | ready in 2.9s | ✅ |
| Reset fixture user(`newapi_user_id=8`)password | hash_len=60 + email/id 对得上 | hash_len=60,id=`8a6901f3-...`,email=`w3d2test-1777777442@silkroadai-internal.test` | ✅ |
| Unit test: `POST /api/auth/login` | 6/6 PASS | 6/6 PASS / 280ms | ✅ |
| E2E happy(正确密码)| 200 + Set-Cookie + body含 user+apiKey | 200, cookie 207 chars, apiKey prefix `e0QdAg2n`, user.id `8a6901f3-...` | ✅ |
| E2E wrong-pass | 401 invalid_credentials, no cookie | 401, 0 cookie, error=`invalid_credentials` | ✅ |
| E2E no-such-email | 401 invalid_credentials, no cookie(timing 防御)| 401, 0 cookie, error=`invalid_credentials` | ✅ |
| E2E bad-format(`email: "not-an-email"`)| 400 invalid_input + zod issues | 400, 0 cookie, error=`invalid_input`, issues.email present | ✅ |
| Cookie JWT 反解 → fixture userId | match `8a6901f3-0054-42b2-87fc-edb24148440a` | match=true | ✅ |
| Login response.apiKey → `https://ai.silkroadai.io/v1/chat/completions deepseek-v4-flash` | 200 + content | 200, 3.76s, model=`deepseek-ai/DeepSeek-V4-Flash`, content="OK! I'm here and ready to help. What can" | ✅ |
| 后台进程 + 敏感临时文件清理 | 都清 | dev server + next-server 子进程都关,`/tmp/d3-creds.env` + `/tmp/d3-happy.http`(含 cookie + apiKey)用 `rm -P` shred,其余 tmp 普通 rm | ✅ |

**结论:核心信号 ✅,3 条非阻塞观察(F1-F3)+ 1 条命名约定声明(F4)。**

## Findings

### F1 [P3 / scope-defer] register 与 login 响应 shape 不对称

- `register` 返回 flat shape `{ user_id, token, newapi_user_id, newapi_token_value, portal_user: {...} }`
- `login` 返回 nested shape `{ user: {...}, apiKey }`
- **影响**:前端要写两套解构,DX 略差。
- **行动**:scope 外。W4 客户后台前端从零写时统一审 — 倾向把 `register` 也改成 nested,但要等前端真正开始用接口时一并改,避免双向破坏。

### F2 [P3 / 不需对称] login 加了 `status='banned'` 拒绝路径,register 没这检查

- `login` 在 `bcrypt.compare` 通过后还检查 `user.status !== 'active'`,banned/disabled 一律 401(不泄露,统一 invalid_credentials)。
- `register` 不需要这条检查 —— 它只创建 `active` 用户,banned 是后续运营操作产生的。
- **行动**:不对齐,这是设计上正确的不对称。

### F3 [P3 / W6 待定] login 暂未捕获 `last_login_ip`

- `User.last_login_at` 已 fire-and-forget 更新(登入热路径不被审计字段写阻塞)。
- `User.last_login_ip` 字段已存在 schema,但暂时 null。
- **原因**:需要确定信任哪个 reverse-proxy header(`X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP`),取决于 W6 上线后 Caddy / Cloudflare 的最终配置。
- **行动**:延 W6 监控 / 审计模块统一定 reverse-proxy header 策略。

### F4 [info] `apiKey` 字段命名 vs Prisma `newapi_token_value`

- 客户面对外:`response.apiKey`(短、好读、不暴露后端品牌)。
- 内部存储:`NewApiToken.newapi_token_value`(明确指向上游 new-api 的 token 字段)。
- 这是有意区分的命名,**不是 bug**。register response 的 `newapi_token_value` 字段在 W4 前端审 shape 时也会一并改成 `apiKey`(见 F1)。

## 测试遗留资源

W3 D2 测试客户继续保留(W3 D4 forgot-password + W4 充值流仍要用),但密码已 reset:

- portal user email: `w3d2test-1777777442@silkroadai-internal.test`
- portal user id (UUID): `8a6901f3-0054-42b2-87fc-edb24148440a`
- new-api user id (int): `8`
- new-api username: `c-8a6901f3`
- sk-xxx 前 12 字符:`e0QdAg2n`(apiKey,Prisma `newapi_token_value`,W2 D6 注册时拿到的值,**未变**)
- W3 D3 reset 后的密码前 12 字符:`W3D3KnownPas`(完整密码已 shred,需要时下次再 reset 一次,流程在脚本里 60 秒能跑完)
- 末尾 quota 余额:~497515 raw quota(W3 D2 充 500000,中间 D2 + D2.5 + D3 三批 e2e 共消耗 ~2485 quota)

## 后续(W3 D4+)

- **D4**:forgot password — `POST /api/auth/forgot-password` 颁发 `User.reset_password_token`(已有字段)+ 邮件发链接(QQ SMTP),`POST /api/auth/reset-password` 凭 token 改密
- **D5**:邮箱验证流程(注册时发激活链接,`User.email_verify_token` 已有字段)
- **D6-D7**:Google OAuth(via OIDC)+ GitHub OAuth(原生)

---

**Signed-off**:W3 D3 验证信号 ✅,Batch B 收尾 PR 进入 review。
