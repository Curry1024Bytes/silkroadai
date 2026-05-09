# W3 D4 — Forgot / Reset Password Flow Verification Report

**Date**: 2026-05-03
**Branch**: `feat/w3-d4-forgot-password`
**Base commit**: `2b59d80` (PR #4 merged)
**Verifier**: Cowork(strategist)+ Claude Code(executor),advisory-mode handoff
**Scope**: 标准档 — `forgot-password` + `reset-password` 端点 + 邮件基础设施(腾讯企业邮箱)+ JWT session_token_version 踢登机制 + reset UI 页面 + 单测 + 真实 e2e

---

## TL;DR

`POST /api/auth/forgot-password` 和 `POST /api/auth/reset-password` 上线,**14 新单测 + 6 jwt 单测 PASS,5 条主 e2e + 2 条次 e2e 状态码全对**。改密 transaction 同时 `bcrypt rehash + session_token_version++ + token.used_at = now`,JWT 反向比对 tv → 旧 token 即时失效(踢登所有设备)。Throttle、无存在性泄露、banned 跳过、invalid token 单一错误格式、reset 复用拒绝 — 都按设计落地。**SMTP 真实送达需用户用真实邮箱手工 smoke 一次**(本批次 SMTP 凭据返回 535 Login fail,但 `EMAIL_DEBUG_LOG` 机制让 e2e 仍能拿到 token 验完整流程)。W3 D4 信号绿,**SMTP 凭据 + 真实送达** 是 W3 D4 后置 / W3 D5 前置 blocker。

## 验证矩阵

| 项                                                  | 期望                                                         | 实测                                                                              | 结果 |
| --------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---- |
| Branch + 起点 untracked                             | Batch A 留下 4 个 untracked dir + 9 modified files           | 一致                                                                              | ✅   |
| `.env` SMTP\_\* + NEXT_PUBLIC_APP_URL 已 set        | 5 个 SMTP\_\* + APP_URL                                      | 全 set(APP_URL 是 prod 值,不影响 e2e — token 走 regex 提)                         | ✅   |
| `EMAIL_DEBUG_LOG` 机制                              | env 设置时 append `to\tresetUrl` 到文件,prod 不启用          | sendPasswordResetEmail 末尾 try/catch + appendFile;SMTP 失败也写                  | ✅   |
| `/reset-password` UI 页面                           | server `?token=` + client form 调 `/api/auth/reset-password` | page.tsx 60 行 + reset-password-form.tsx 100 行,inline style,品牌色 `#0a1535`     | ✅   |
| Reset fixture user 密码                             | `session_token_version` 涨 1 + hash 更新                     | stv 1 → 2,hash_prefix `$2b$10$` len=60                                            | ✅   |
| Dev server with `EMAIL_DEBUG_LOG`                   | ready < 30s                                                  | ready in 1.8s                                                                     | ✅   |
| Unit tests: forgot + reset + jwt + register + login | 30 files / 320 tests / 0 fail                                | 30 files / 320 tests / 1 skip / 0 fail                                            | ✅   |
| E2E `forgot-happy`                                  | 200 + token 写 debug log                                     | 200 + 1 行 debug log,token 64 hex                                                 | ✅   |
| E2E `reset-happy`                                   | 200 `{ok:true}`                                              | 200 `{ok:true}`                                                                   | ✅   |
| E2E `login-new`                                     | 200 + `set-cookie` + body 含 `user`+`apiKey`                 | 200, cookie 207 chars, apiKey prefix `e0QdAg2n`                                   | ✅   |
| E2E `reset-replay`(用过的 token 再用)               | 400 `invalid_or_expired_token`                               | 400 `invalid_or_expired_token`                                                    | ✅   |
| E2E `login-old`(改密前的旧 pass)                    | 401 `invalid_credentials`                                    | 401 `invalid_credentials`                                                         | ✅   |
| E2E forgot 不存在 email                             | debug log 不增                                               | 1 → 1(0 增)                                                                       | ✅   |
| E2E throttle: 5 次连发同 email                      | debug log +1                                                 | +1                                                                                | ✅   |
| 后台进程 + 敏感临时文件清理                         | 都清,带 secret 的用 `rm -P`                                  | dev server + next-server 子进程都关,creds/token/cookie 文件 `rm -P`,其余普通 `rm` | ✅   |

**结论:核心信号 ✅,1 条 P1 blocker(F1 — SMTP 凭据 535)+ 4 条 informational(F2-F5)。**

## Findings

### F1 [P1 / W3 D5 前置 blocker] SMTP 凭据 535 Login fail

- **症状**:Batch B 真实调 `getMailer().sendMail({...})` → throws `Error: Invalid login: 535 Login fail. Account is abnormal, service is not open, password is incorrect, login frequency limited, or system is busy.`
- **影响**:邮件根本发不出去。本 batch 的 e2e 靠 `EMAIL_DEBUG_LOG` 机制拿到 token,逻辑路径全通,但客户实际收不到邮件。**W3 D5 邮箱验证流程**也会同样发不出激活邮件,得先修这个。
- **根因可能**(没排查到位):
    - SMTP_PASS 是过期的客户端授权码(腾讯企业邮箱授权码定期会过期)
    - SMTP_USER 拼写问题(`noreplay@silkroadai.io` vs `noreply@silkroadai.io` — 但 Cowork 已确认是 `noreplay@`,所以这不是问题)
    - 企业邮箱后台 "客户端授权码" 功能没开
    - IP 频率限制(腾讯有时会临时 ban IP,等等再试)
- **修复**:用户去 admin.exmail.qq.com 后台:
    1. 确认 `noreplay@silkroadai.io` mailbox 还活着(没过期 / 没被 disable)
    2. 重新生成客户端授权码,写回本地 `.env` 的 `SMTP_PASS`
    3. 用真实邮箱跑 F2 提到的 smoke
- **行动**:用户做。Cowork 这边 Claude Code 没法登 admin.exmail.qq.com。

### F2 [P1 / 等用户] SMTP 真实送达 smoke

本 batch 的 e2e 全是发到 `w3d2test-1777777442@silkroadai-internal.test`(虚构 domain,根本不存在),所以即便 SMTP 凭据修好了,邮件也会被退信。要验证"客户能真正收到邮件",必须发到一个真实的能收件的邮箱:

```
1. 用户提供一个真实邮箱地址(给 Claude Code 或自己跑)
2. 在 Prisma 临时建一个 user(email = 你的真实邮箱)
3. curl POST /api/auth/forgot-password { email: "<你的真实邮箱>" }
4. 打开你的真实邮箱收件箱 + spam 文件夹,确认从 noreplay@silkroadai.io 来的"重置密码"邮件到达
5. 邮件确认到达后,清掉那个临时 user(prisma.user.delete({where:{email:<你的邮箱>}}))
```

- **行动**:用户在 PR #5 review 时单独跑,或把真实邮箱告诉 Claude Code(下个 batch 完后即弃)。

### F3 [P3 / 已知,W4-W5 cleanup] W1 D2 留下的 4 个 stale User 字段

`User.{reset_password_token, reset_password_expires, email_verify_token, email_verify_expires}` — sub2apipay 时代继承的 scaffolding,从未实装。本 batch 走独立 `PasswordResetToken` 表(更可控,token 只存 hash),那 4 列暂留 schema 不动。

- **行动**:W3 D5 引入独立 `EmailVerificationToken` 表后,跨 PR drop 这 4 列。

### F4 [P3 / W4-W5 sweep] verifySession 每次 +1 DB read

为支持 session_token_version 踢登机制,`getCurrentUser` 每次 auth 路径多查一次 `User` 表读 `session_token_version`(`getCurrentUser` 本来就要查 user,所以等于换了个 select)。`signSession` 因为同样原因也内部查一次 user(写路径,不在请求热路径)。

- **缓解**:W4-W5 加 redis 缓存 `User.session_token_version`,失效策略 = bcrypt rehash(reset)/ 主动 logout 时主动 bust。
- **行动**:W4-W5 性能优化时纳入。Gotcha #16 已记。

### F5 [P3 / W6 可选] forgot-password throttle 应用层 race

5 分钟节流走 `prisma.passwordResetToken.findFirst({where:{user_id, used_at:null, expires_at:gt:now, created_at:gt:now-5min}})` + 后续 `create`。两个并发请求都看到"无 recent token" → 都创建 → user 收到 2 封邮件。

- **概率**:低(用户毫秒级双连点 + 上行同时到达)。
- **缓解**:W6 上线前可加 redis lock(per-user)。可选。
- **行动**:W6 上线 checklist 上加这条,日常不阻塞。

## 测试遗留资源

W3 D2 测试客户继续保留(W4 充值流仍要用),密码状态:

- portal user email: `w3d2test-1777777442@silkroadai-internal.test`
- portal user id (UUID): `8a6901f3-0054-42b2-87fc-edb24148440a`
- new-api user id (int): `8`
- new-api username: `c-8a6901f3`
- sk-xxx 前 12 字符:`e0QdAg2n`(apiKey,Prisma `newapi_token_value`,W2 D6 注册时拿到的值,**未变**)
- W3 D4 reset 后的密码(NEW_PASS)前 12 字符:`W3D4New!b4bf`(完整密码已 shred,需要时下次 reset 一次,流程在脚本里 60 秒能跑完)
- `session_token_version`:**3**(W3 D2 register 时 1 → W3 D4 B3 reset 1→2 → W3 D4 B5.2 reset 通过 reset-password endpoint 2→3)

## 后续(W3 D5+)

- **D5**:register 邮箱验证流程,复用本 batch 的 `src/lib/email/{client,templates,send}.ts` + `EMAIL_DEBUG_LOG` 基础设施;独立 `EmailVerificationToken` 表(对称 D4 的 PasswordResetToken)
- **D5 后跨 PR**:drop W1 stale 4 列(F3)
- **D6-D7**:Google OAuth(via OIDC)+ GitHub OAuth(原生)
- **W4-W5**:redis 缓存 `session_token_version`(F4)
- **W6**:SMTP 监控 / Sentry(F1+F5)

---

**Signed-off**:W3 D4 验证信号 ✅(逻辑路径)/ ⚠️ SMTP 凭据待修(F1 P1 blocker, 用户操作)。Batch B 收尾 PR 进入 review。
