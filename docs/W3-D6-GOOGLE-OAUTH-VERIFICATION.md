# W3 D6 — Google OAuth (OIDC) Verification Report

**Date**: 2026-05-02
**Branch**: `claude/busy-bardeen-1cb526`
**Base commit**: `014f984`
**Verifier**: Cowork(strategist)+ Claude Code(executor),advisory-mode handoff
**Scope**: 标准档 — Google OIDC 登录:DIY with `jose`(零新依赖)+ `oauth_accounts` 表 + `User.password_hash` 改 nullable + `/start` + `/callback` 两端点 + 5-branch 邮件冲突策略 + state CSRF + PKCE + 单测全套(浏览器真实登录由用户跑,见 §smoke 指引)

---

## TL;DR

Google OAuth via OIDC 全栈跑通。**零新依赖**(沿用 `jose`,与 `signSession` 同库,不引 `openid-client`)。新增 `OAuthAccount` 表,`(provider, provider_account_id)` 上 unique,User 上 `password_hash` 改 `String?`(OAuth-only 用户没密码)。两端点:`GET /api/auth/oauth/google/start`(state + PKCE + 302 到 Google)、`GET /api/auth/oauth/google/callback`(state 校验 + 换 token + 验 id*token + 5 分支 email 处理)。15 单测全 PASS,完整测试套 348/350 PASS(2 失败为 pre-existing newapi smoke,SSH 隧道未起,无关本批)。**真实 Google 登录 smoke 由用户在浏览器手测**(配好 GOOGLE_OAUTH*\* 后访问 `/api/auth/oauth/google/start`),见 §用户手测指引。

## 验证矩阵

| 项                                                 | 期望                                                      | 实测                                                                                                                   | 结果         |
| -------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------ |
| Schema migration `add_oauth_accounts`              | apply 成功,`oauth_accounts` 表 + `password_hash NULLABLE` | apply 成功,DB 验证表存在 + unique 索引在                                                                               | ✅           |
| `Prisma generate` 后 `prisma.oAuthAccount` 可用    | tsc 通过                                                  | tsc 0 errors                                                                                                           | ✅           |
| OIDC helper `src/lib/auth/oauth/google.ts`         | DIY with `jose`,无 `openid-client` 引入                   | 200 行,jose `createRemoteJWKSet` + `jwtVerify`,issuer/audience/exp 校验,typed `GoogleOAuthError`                       | ✅           |
| `/start` 端点                                      | 302 到 google authorize,scope/state/PKCE 全配 + 2 cookies | 302 + scope=`openid email profile` + S256 PKCE + `oauth_google_state` + `oauth_google_pkce` httpOnly+sameSite=lax 600s | ✅           |
| `/callback` 端点 5 分支                            | 见 §设计                                                  | 全部 covered + 单测断言                                                                                                | ✅           |
| Tests: oauth/start                                 | 4 PASS                                                    | 4 PASS                                                                                                                 | ✅           |
| Tests: oauth/callback                              | 11 PASS(分支覆盖 + 错误路径)                              | 11 PASS                                                                                                                | ✅           |
| Tests: 全套回归                                    | 0 新 fail                                                 | 348 PASS / 1 skip / 2 pre-existing fail(newapi smoke,SSH 隧道未起)                                                     | ✅           |
| `tsc --noEmit`                                     | 0 errors                                                  | 0 errors                                                                                                               | ✅           |
| `eslint src/lib/auth/oauth src/app/api/auth/oauth` | 0 issues                                                  | 0 issues                                                                                                               | ✅           |
| `.env.example` 加 3 行 GOOGLE*OAUTH*\*             | + 注释引导                                                | 加在 `# 易支付` 上方                                                                                                   | ✅           |
| 真实 Google 登录 smoke                             | 用户手测                                                  | 见 §用户手测指引                                                                                                       | ⏳ User TODO |

**结论:核心信号 ✅,4 个 informational(F1-F4),1 个用户 TODO(浏览器手测)。**

## 设计 — `/callback` 5 分支 email 冲突策略

按发现顺序判断,先看 `(provider=google, sub)` 链是否已存在,再 fall back 到 email 查找:

| 分支                         | 触发                                              | 处理                                                                                                                                                  | 备注                                                  |
| ---------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **1. 已链接(login)**         | `oauth_accounts(google, sub)` 行存在              | 加载该 user → 签 session                                                                                                                              | 最常见路径,`sub` 比 email 稳(用户能改 gmail,sub 不变) |
| **2. 链接已验证 user**       | 无链接 + email 找到 user + `email_verified=true`  | 静默 create `oauth_accounts` 行                                                                                                                       | 老用户首次接 Google,无需用户确认                      |
| **3. Bootstrap 未验证 user** | 无链接 + email 找到 user + `email_verified=false` | transaction:flip `email_verified=true` + create `oauth_accounts`                                                                                      | Google 已经验过邮箱,等价于点验证链接                  |
| **4. 全新 signup**           | 无链接 + email 没人                               | `prisma.user.create({ password_hash:null, email_verified:true, oauth_accounts:{create:...} })` + `provisionNewCustomer`(同 register/route) + 失败回滚 | 与 register/route 共用 `cleanupOrphanNewApiUser` 思路 |
| **5. Sub 冲突**              | `oauth_accounts.create` P2002                     | 302 → `/?oauth_error=link_conflict`                                                                                                                   | 同一 google sub 已链到不同 portal user — 不允许       |

附加错误路径(都走 302 → `/?oauth_error=<code>`):

- `state_mismatch` — cookie 缺失或与 query 不匹配(CSRF 抗性)
- `google_denied` — 用户在 consent screen 点 deny
- `missing_code_or_state` — 直接 hit /callback(bookmark)
- `oauth_not_configured` — 缺 env
- `email_not_verified` / `id_token_*` / `token_exchange_failed` — `GoogleOAuthError.code` 直接传出
- `account_disabled` — 已链接但 user.status≠active
- `provisioning_failed` — Branch 4 new-api 调用失败,portal user 已回滚

## Findings

### F1 [info] DIY with `jose` 而非 `openid-client`

- 决策:沿用项目已有 `jose`(`signSession`/`verifySession` 同款),不引第三个 OIDC 依赖。
- 取舍:`openid-client` 自动 discovery + 大社区,但本仓库只对接 Google 一家固定 provider,认证流程 200 行写得清。`createRemoteJWKSet` 已经把 JWKS fetch+cache+rotation 全包,等同于 openid-client 的核心。
- 风险:Google 改 issuer/audience/JWKS URL 时(罕见)需要手改;`ALLOWED_ISSUERS` 已经覆盖 Google 当前两种拼写。
- W4-W5 加 GitHub OAuth 时:GitHub 是 OAuth2 不是 OIDC,流程更简单,本助手代码不复用,但 `oauth_accounts` 表 schema 一样可用。

### F2 [info] OAuth-only user `email_verified=true` 立即生效

- Branch 4 创建 user 时直接 `email_verified=true` + `email_verified_at=now`。理由:Google 已经做 email 验证,我们继承这个结论。
- 与 W3 D5 register flow 不同(register 需要用户点验证邮件)— 这是 OAuth 的天然优势,文档化决策已经在 D5 doc §"后续(W3 D6+)" 里写过推荐 yes。
- 影响:Branch 3(Bootstrap)的存在意义 — 老 portal 用户即使没验证 email,只要他用同 email 的 Google 账号登一次,我们就把他从未验证状态 flip 过去。

### F3 [info] State + PKCE cookies 必须在 callback 出口清掉

- 出口(成功 / 失败 / state mismatch)都走 `buildResponse()`,内部 `clearOAuthCookies()` 设置 maxAge=0。
- 不清的话,二次访问 callback URL 还能再尝试一次(虽然 query 里的 code 已经被 Google 一次消费,但 cookie 留着是 CSRF 攻击面 widening)。
- 相关 gotcha:见 CLAUDE.md gotcha #17(本批新增)。

### F4 [User TODO] 真实 Google 登录端到端 smoke

- 单测覆盖:state mismatch / google_denied / id_token_invalid / 5 个 email 分支 / provision rollback / banned account。**业务逻辑全 covered**。
- **缺**:浏览器真发起 OAuth 流的 e2e — 这要求真实 Google client_id/secret 和 redirect URI,Cowork 没有也不应该有。
- 用户操作步骤见 §用户手测指引。

## 用户手测指引

1. **配 .env**(三个变量):

    ```
    GOOGLE_OAUTH_CLIENT_ID=<在 cloud.google.com 创建 OAuth 2.0 Client>
    GOOGLE_OAUTH_CLIENT_SECRET=<同上>
    GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3002/api/auth/oauth/google/callback
    ```

    并把 `Authorized redirect URIs` 在 Google Cloud console 里设成完全相同的 URL。

2. **起本地 dev**:`pnpm dev`(默认 `http://localhost:3002`)。

3. **触发登录**:浏览器打开 `http://localhost:3002/api/auth/oauth/google/start`。
    - 期望:302 跳到 `accounts.google.com/o/oauth2/v2/auth?...`,看到 Google 选账号 / consent screen。

4. **同意授权**后 Google 把你 302 回 `…/api/auth/oauth/google/callback?code=…&state=…`。
    - 期望(全新 email):302 → `http://localhost:3002/`,带 `silkroad_session=<jwt>` cookie,DB `users` 表多 1 行(`password_hash IS NULL`,`email_verified=true`),`oauth_accounts` 表多 1 行(provider=google, provider_account_id=Google sub)。
    - 期望(已存在 email):静默链接 — `users` 行不变,`oauth_accounts` 多 1 行。
    - 期望(已链接,二次登录):`users` 行 `last_login_at` 更新,无新行写入。

5. **失败路径手测**(可选):
    - 在 Google consent screen 点"取消" → 应回到 `/?oauth_error=google_denied`。
    - 直接访问 `/api/auth/oauth/google/callback`(无 query)→ `/?oauth_error=missing_code_or_state`。

如果任一 happy path 失败,优先看 server log:routes 全部用 `console.warn` / `console.error` 打了带 prefix 的诊断行(`[oauth/google/callback] ...`),按 error code 反查 `route.ts` 内对应分支。

## 后续(W3 D7+)

- **D7**:GitHub OAuth(原生 OAuth2,不走 OIDC)— `oauth_accounts` 表 schema 复用,但需要不同的验证逻辑(GitHub 不发 id_token,需要用 access_token 调 `GET /user` + `GET /user/emails`)。
- **W4 客户后台**:加"已绑定登录方式"列表 + 解绑 / 加绑 endpoint(同 email 的 portal user 可以绑定多个 OAuth 来源)。
- **W4-W5 cross-PR**:`/?oauth_error=...` 的前端 banner 渲染(目前 homepage 不读这个 query)。

---

**Signed-off**:W3 D6 验证信号 ✅(单测层面),用户手测 ⏳ pending。Unblock D7 GitHub OAuth。
