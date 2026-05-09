# W3 D7 — GitHub OAuth (OAuth2) Verification Report

**Date**: 2026-05-02
**Branch**: `feat/w3-d7-github-oauth`
**Base commit**: `62236ea`(D6 PR #7 merged 上 main)
**Verifier**: Cowork(strategist)+ Claude Code(executor),advisory-mode handoff
**Scope**: 标准档 — GitHub 原生 OAuth2(非 OIDC):helper(`fetch`,无新依赖)+ `/start`(state cookie + 302)+ `/callback`(state 校验 + token exchange + `/user` + `/user/emails` + 5-branch email 复用)+ 单测全套(浏览器真实登录由用户跑)

---

## TL;DR

GitHub OAuth(原生 OAuth2,非 OIDC)落地,**零新依赖**,与 D6 共用 `oauth_accounts` 表(`provider='github'`,`provider_account_id` 存 `/user.id` 字符串化)。**5-branch email 冲突逻辑抽出共用 helper** `src/lib/auth/oauth/account-link.ts`,GitHub callback 调用它;Google callback 因受 D7 brief "❌ 不动 google OAuth" 约束,**保留 inline 实现**(行为完全等价,helper 是按 D6 inline 逻辑 1:1 抄写),后续 sweep 可让 Google 也改用同一 helper。新增 39 单测全 PASS,**全套 vitest 389/390 PASS / 1 skip / 0 fail**(SSH 隧道 up,smoke 也过)。`tsc` 0 / `eslint` 0。**真实 GitHub 登录 smoke 由用户在浏览器手测**(同 D6 5 步 模式),见 §用户手测指引。

## 与 D6 的关键差异

| 项                              | D6 (Google OIDC)                           | D7 (GitHub OAuth2)                                                 |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `id_token` / JWKS / `jose` 验签 | ✅ 必须                                    | ❌ 没 id_token,直接调 REST API 拿身份                              |
| PKCE                            | ✅ S256 双 cookie                          | ❌ GitHub web flow 不支持,只剩 state cookie                        |
| email 来源                      | id_token claim(`email_verified=true` 已绑) | `GET /user/emails` → 挑 `primary && verified`;无则拒               |
| display name                    | id_token `name` claim                      | `/user.name`,无则 fallback `/user.login`                           |
| token endpoint Content-Type     | `application/x-www-form-urlencoded`        | JSON `Accept: application/json`(否则 GitHub 默认返回 form-encoded) |
| 共用代码                        | (none)                                     | 5-branch logic 走共用 `linkOrCreateOAuthUser`                      |

## 验证矩阵

| 项                                                                        | 期望                                                 | 实测                                                                                                                                                                              | 结果         |
| ------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Pre-flight: SSH 隧道 up(D6 教训)                                          | `curl /api/status` 200                               | 200                                                                                                                                                                               | ✅           |
| Branch off origin/main(D6 已 merge)                                       | `feat/w3-d7-github-oauth` from `62236ea`             | 一致                                                                                                                                                                              | ✅           |
| GitHub helper `src/lib/auth/oauth/github.ts`                              | 纯 fetch,无新依赖,typed `GitHubOAuthError`           | ~5KB,4 函数(`buildAuthorizeUrl` / `exchangeCodeForToken` / `fetchGitHubUser` / `fetchGitHubVerifiedPrimaryEmail`)+ state 生成                                                     | ✅           |
| 共用 5-branch helper `src/lib/auth/oauth/account-link.ts`                 | 1:1 抄 D6 inline 逻辑                                | `linkOrCreateOAuthUser({provider, providerAccountId, email, nameHint?})` 返回 `LinkOrCreateOutcome`                                                                               | ✅           |
| `/start` 端点                                                             | 302 + `oauth_github_state` cookie                    | scope=`read:user user:email` + `allow_signup=true` + state 64-hex + httpOnly+sameSite=lax+600s                                                                                    | ✅           |
| `/callback` 端点                                                          | state 校验 → token → /user + /user/emails → 5-branch | + GitHub-specific 错误码(token_exchange_failed / user_fetch_failed / email_fetch_failed / email_not_verified)+ 共用错误码(account_disabled / link_conflict / provisioning_failed) | ✅           |
| Tests: account-link helper(5 branch + 2 rollback + banned)                | 11 PASS                                              | 11 PASS                                                                                                                                                                           | ✅           |
| Tests: github helper(URL builder + token exchange + /user + /user/emails) | 13 PASS                                              | 13 PASS                                                                                                                                                                           | ✅           |
| Tests: github/start route                                                 | 4 PASS                                               | 4 PASS                                                                                                                                                                            | ✅           |
| Tests: github/callback route                                              | 11 PASS                                              | 11 PASS                                                                                                                                                                           | ✅           |
| Google OAuth 单测不回归                                                   | 15 D6 测试全过                                       | 15 PASS(在全套里跑过)                                                                                                                                                             | ✅           |
| 全套 vitest                                                               | 0 新 fail                                            | 389 PASS / 1 skip / **0 fail**(含 newapi smoke)                                                                                                                                   | ✅           |
| `tsc --noEmit`                                                            | 0 errors                                             | 0 errors                                                                                                                                                                          | ✅           |
| `eslint src/lib/auth/oauth src/app/api/auth/oauth`                        | 0 issues                                             | 0 issues                                                                                                                                                                          | ✅           |
| `.env.example` 加 3 行 GITHUB*OAUTH*\*                                    | + 注释引导                                           | 加在 GOOGLE*OAUTH*\* 下方                                                                                                                                                         | ✅           |
| 真实 GitHub 登录 smoke                                                    | 用户手测                                             | 见 §用户手测指引                                                                                                                                                                  | ⏳ User TODO |

**结论:核心信号 ✅,3 个 informational(F1-F3),1 个用户 TODO(浏览器手测)。**

## Findings

### F1 [info / 设计取舍] 5-branch helper 抽出但 Google callback 暂未改造

- **现状**:`src/lib/auth/oauth/account-link.ts` 是 D6 inline 逻辑的 1:1 抄写,GitHub callback 直接调用;Google callback 仍 inline。
- **理由**:D7 brief 明确 "❌ 不动 google OAuth 任何代码 / 单测",所以本批不做 Google 重构。helper 的存在为下一个 OAuth provider(或 Google sweep)铺好路。
- **重复代码风险**:5-branch 逻辑在两处实现,若需要修改(如新增 branch 或调整 banned 处理),必须同步两侧。已在 helper 头注释里标注"Google callback predates this helper, leave untouched per D7 brief"。
- **后续清理**:W4-W5 sweep PR 让 Google callback 也调用此 helper,delete inline 副本(预估 ~80 行收紧)。

### F2 [info] GitHub `email_verified=true` 政策与 Google 等价

- 与 D6 同款决策:`/user/emails` 必须有 `primary=true && verified=true` 那条,否则 `email_not_verified` 拒绝。
- 共用 helper 的 Branch 4(fresh signup)创建 user 时直接 `email_verified=true` + `email_verified_at=now`。
- Branch 3(bootstrap-unverified)对老 portal 用户也生效:user 之前没验证 email,只要他用 GitHub 登一次,我们 flip 过去 — 与 Google 一样"OAuth provider 已经做了验证,继承结论"。

### F3 [info] GitHub token endpoint 200 + `error` 字段陷阱

- GitHub `POST /login/oauth/access_token` 在 `code` 已用过 / 过期时返回 **200 OK**,body 是 `{error: "bad_verification_code", error_description: "..."}`,**不是** 4xx。
- helper 在拿到 JSON 后必须显式检查 `json.error || !json.access_token`,否则会把错误 body 当成 token 用,后面 `/user` 拿 401 才暴露问题。
- 已加单测覆盖(`exchangeCodeForToken throws on 200 + error field`)。
- 这是 GitHub-only 习性,不需要新 gotcha 条目(局限于 helper 内部,外人不会踩)。

## 用户手测指引

预先(D6 教训,**不省**):

- `curl localhost:3000/api/status` 应返回 200 — 否则 SSH 隧道 down,先 `ssh -fN -L 3000:localhost:3000 -o ServerAliveInterval=60 vps`

1. **`.env` 已配 3 个 GITHUB*OAUTH*\* 变量**(用户已确认)。GitHub OAuth App 的 Authorization callback URL 必须 = `http://localhost:3002/api/auth/oauth/github/callback`。

2. **`PORT=3002 pnpm dev`** 起本地。

3. **浏览器开 `http://localhost:3002/api/auth/oauth/github/start`**。
    - 期望:302 跳到 `https://github.com/login/oauth/authorize?...`,看到 GitHub 选账号 / Authorize 按钮。

4. **同意授权**后 GitHub 把你 302 回 `…/api/auth/oauth/github/callback?code=…&state=…`。
    - 期望(全新 GitHub 账号 / email 没注册过):302 → `http://localhost:3002/`(legacy 可能跳 `/pay`,正常),Cookie 里多 `silkroad_session=<jwt>`,DB:
        - `users` 多 1 行(`password_hash IS NULL`,`email_verified=true`,`nickname=<GitHub name 或 login>`)
        - `oauth_accounts` 多 1 行(`provider='github'`, `provider_account_id=<GitHub user.id 字符串>`)
        - `newapi_tokens` 多 1 行(`key_alias='default-<uuid8>'`,`newapi_token_value=sk-...`)
    - 期望(同 email 已存在,Google 或密码注册过):`users` 不变,`oauth_accounts` 多 1 行(silent link)。
    - 期望(已链接 GitHub,二次登录):`users.last_login_at` 更新,无新行。

5. **失败路径手测**(可选):
    - GitHub 授权页点 Cancel → 应回 `/?oauth_error=github_denied`
    - 直接访问 `/api/auth/oauth/github/callback`(无 query)→ `/?oauth_error=missing_code_or_state`

任一 happy path 失败 → 看 server log 中 `[oauth/github/callback]` 前缀诊断行,按 `oauth_error` code 反查 `route.ts` 内对应分支。

## 后续(W3 收口 → W4)

- **W3 收口**:三种登录方式齐备(密码 / Google / GitHub)+ 邮件验证 / 找回密码全通,W3 验收线达成。
- **W4 充值流改造**:portal 客户后台对接 new-api 充值(用 D6/D7 OAuth 创建的客户 id)。
- **W4-W5 cross-PR sweep**:① F1 让 Google callback 也调用共用 helper;② OAuth provider 列表 / 解绑 endpoint;③ `/?oauth_error=...` 前端 banner 渲染。

---

**Signed-off**:W3 D7 验证信号 ✅(单测 + 全套回归层面),用户手测 ⏳ pending。W3 阶段实质完成(D6+D7 是 W3 最后两个 todo)。
