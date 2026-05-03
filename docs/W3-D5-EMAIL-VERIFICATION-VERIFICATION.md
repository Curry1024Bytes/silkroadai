# W3 D5 — Register Email Verification Flow Verification Report

**Date**: 2026-05-03
**Branch**: `feat/w3-d5-email-verification`
**Base commit**: `8fd2a64` (PR #5 merged)
**Verifier**: Cowork(strategist)+ Claude Code(executor),advisory-mode handoff
**Scope**: 标准档 — register-time verification token issuance + `verify-email` + `resend-verification` 端点 + 复用 D4 邮件基础设施 + `/verify-email` UI 页 + 单测 + 真实 e2e

---

## TL;DR

新用户注册后 `email_verified=false` + `email_verified_at=null`,自动收 verification 邮件,点链接(`/verify-email?token=`)即时验证。**Soft-block** 设计 — login + 拿 sk-xxx 不阻塞,只在 user 字段上标记;敏感操作 enforcement 留 W4 客户后台。同 migration 一并 drop W1 sub2apipay-era 4 个 stale 字段。**21 新单测 + 6 真实 e2e 步骤全过**;1 行 backfill 让 fixture user_id=8 视为预验证;新 ephemeral fixture user_id=9 留作 D6+ 测试复用。W3 D5 信号绿,unblock D6/D7 OAuth。

## 验证矩阵

| 项 | 期望 | 实测 | 结果 |
|---|---|---|---|
| Branch + 起点 untracked / modified | Batch A 留 5 modified + 3 untracked dir | 一致 | ✅ |
| `/verify-email` UI 页(auto-POST on load + StrictMode guard)| page.tsx + verify-email-runner.tsx | 60 + 78 lines,inline style,品牌色 #0a1535,fired ref 防 React 19 dev double-mount 重复消耗 token | ✅ |
| Dev server with `EMAIL_DEBUG_LOG` | ready < 30s | ready in 1.7s | ✅ |
| Unit tests:auth 全套 + smoke + 其他 | 32 files / 335 tests / 0 fail | 32 files / 335 tests / 1 skip / 0 fail / 2.87s | ✅ |
| E2E 1: register fresh ephemeral user | 200 + apiKey + `email_verified:false` + log +1 | id=`99a9d7e5-...`, newapi=9, sk-prefix=`olGVezvR`, log +1 | ✅ |
| E2E 2: resend on unverified user(throttle)| 200 + log unchanged | log 1→1(throttle reused existing token)| ✅ |
| E2E 3: verify-email with token | 200 `{ok:true}` + DB `email_verified=t` + `email_verified_at` 非 null | 200 + DB row 双字段都对 | ✅ |
| E2E 4: replay used token | 400 `invalid_or_expired_token` | 400 invalid_or_expired_token | ✅ |
| E2E 5: resend after verify(silent noop)| 200 + log unchanged | log 1→1 | ✅ |
| E2E 6: resend on fixture user_id=8(backfill verified)| 200 + log unchanged | log 1→1 | ✅ |
| 后台进程 + 敏感临时文件清理 | 都清,带 secret 用 `rm -P` | dev kill,creds/token/register-response(含 apiKey)`rm -P`,其余普通 `rm` | ✅ |
| Fixture retention | 不删 user_id=8 + 不删本批 ephemeral | DB 中 2 行,均已 verified | ✅ |

**结论:核心信号 ✅,4 个 informational(F1-F4)。**

## Findings

### F1 [P3 / W4-W5 sweep] User 表 dual fields:`email_verified` Boolean + `email_verified_at` DateTime

- 决策详情见 Batch A 报告 / commit message。Boolean 沿用 W1 D2,login / user/route 已经在读;新 `email_verified_at` 是 source of truth + ops 审计。
- 写时同步:register / verify-email / migration backfill 三处都成对写。
- **风险**:外部直接 `prisma.user.update({email_verified: true})` 会绕过 timestamp 同步。本仓库内只有 verify-email 在写,审计简单;W4-W5 加客户后台 admin 接口时强制走 helper(或合并字段)。
- **行动**:W4-W5 sweep 时跨 PR 合并字段(改 read-side 用 `email_verified_at !== null`,删 Boolean)。

### F2 [info] Migration backfill:fixture user_id=8 视为已验证

- W1/W2/W3 已有 user 都是预验证时代,backfill `email_verified=TRUE, email_verified_at=created_at`。
- 实测影响 1 行(就是 fixture user_id=8)。
- E2E step 6 验证了 backfill 后 fixture resend 走 silent-noop 路径 ✓。
- **行动**:无,这是 migration 设计的预期行为。

### F3 [info / 已完成] W1 stale 4 列已 drop

- `User.{reset_password_token, reset_password_expires, email_verify_token, email_verify_expires}` — sub2apipay 时代继承,从未实装。
- W3 D4 引入 PasswordResetToken 表后这 4 列变完全废,本 D5 migration 一并 drop。
- 确认无代码引用(grep ↦ 0 hit in src/)。

### F4 [info / 用户自决] SMTP 真实送达 smoke 没在本 batch 跑

- D4 已确认整套 SMTP infra 通(`verify=true` + 真实送达到 1226627765@qq.com)。
- D5 verification 邮件走完全相同的 transporter + EMAIL_DEBUG_LOG 路径,只是模板文案不同。所以"register → verify 邮件能不能真到"的可信度继承自 D4 验证。
- 想严格 smoke 一次真实送达,告诉 Claude Code 一个真实邮箱地址,流程同 W3 D4 F2(register-with-real-email → 收件 → cleanup)。**非阻塞 D5 通过**。

## 测试遗留资源

W3 D5 后总共 2 个 fixture user:

| 字段 | fixture A(W2 D6 起,backfill verified)| fixture B(本 batch ephemeral)|
|---|---|---|
| email | `w3d2test-1777777442@silkroadai-internal.test` | `w3d5test-1777790808@silkroadai-internal.test` |
| portal user id | `8a6901f3-0054-42b2-87fc-edb24148440a` | `99a9d7e5-73cb-4c32-aaf3-4e6addd513ab` |
| new-api user id | `8` | `9` |
| new-api username | `c-8a6901f3` | `c-99a9d7e5` |
| sk-xxx prefix | `e0QdAg2n` | `olGVezvR` |
| email_verified | `t`(backfill)| `t`(real verify-email 跑通)|
| email_verified_at | `~2026-05-02T06:11`(= created_at)| `~2026-05-03T06:47`(verify 时刻)|
| password 状态 | W3 D4 reset 后 NEW_PASS(已 shred) | W3 D5 register 时随机(已 shred) |
| 用途 | W3 D2/D3/D4 e2e + 充值 W4 复用 | D5 verified 状态参照 + W4 充值复用 |

两个 user 都不删,W4 充值流回归测试 + W3 D6/D7 OAuth e2e 都可能复用。

## 后续(W3 D6+)

- **D6**:Google OAuth(via OIDC)— 需要决策:OAuth-only user 是否 `email_verified=true` 立即(Google 已经验过邮箱)?推荐 yes
- **D7**:GitHub OAuth(原生)— 同上决策
- **W4-W5 cross-PR sweep**:F1 dual fields 合并 + 改 login/user/route 读侧

---

**Signed-off**:W3 D5 验证信号 ✅。Batch B 收尾 PR 进入 review,unblock D6/D7。
