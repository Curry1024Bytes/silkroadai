# W9 D3 — 客户自定义 OSS 配置(image generation)

> 部署日期:2026-06-05。prod `4a0bb85` → `89545c5`(PR [#76](https://github.com/yexioy/silkroadai/pull/76))。
> Phase 3 of the /v1/\* proxy。**含 W9 首个 DB migration + 新必需 env `PORTAL_OSS_ENC_KEY`。**

---

## 1. 功能

客户在 `/settings/storage` 配置自己的 S3 兼容对象存储(`r2` / `aliyun-oss` / `tencent-cos` / `s3` / `s3-custom`);proxy 生图时:

- **有 active OSS 配置** → 图片传客户自己的 bucket,`content` 返客户配置的公网前缀 URL(自定义域名 / CDN)。
- **无配置 / 配置 inactive / 任何故障(DB 读不到、解密失败、客户 OSS 上传失败)** → **三级降级**回平台 R2(`images.silkroadai.io`),客户请求**不失败**(降级时带响应头标记)。

凭证安全:`secret_access_key` 用 **AES-256-GCM** 加密落库(key = `PORTAL_OSS_ENC_KEY`);`GET /api/portal/oss` **永不回显** secret(只返 masked / 元数据)。

新增面:`src/lib/oss/{schema,encryption,client,store}.ts` · `GET/PUT/DELETE /api/portal/oss` · `POST /api/portal/oss/test-connection` · 页面 `/settings/storage` + sidebar 入口 · proxy `route.ts` 集成。

---

## 2. ⚠️ DB migration + 新 env(本次两个硬 gate)

### Step 0a — migration 本地验证(非破坏性)

migration SQL(`20260605140000_add_user_oss_configs`)是 Cowork 沙箱**手写**、`prisma generate` 没跑过的。Mac 上验证:

- Prisma 的 **AI-agent 安全 guard 挡住了 `migrate reset`**(破坏性,需用户显式同意)。且本地 dev DB 还有遗留 orphan migration(`pr_g2_payment_global`,仅本地,prod 无)。
- 改用**非破坏性**验证:建 throwaway temp DB → `migrate deploy` 全 36 migration(含 OSS)**干净 apply, exit 0** → `\d user_oss_configs` 实测表结构与 schema 模型**逐列一致**(15 列 / PK / `user_id` unique / FK `ON DELETE CASCADE`)→ 删 temp DB。
- `prisma generate` ✓ · `tsc --noEmit` ✓ · **vitest 1225 PASS**。

### Step 0b — prod `PORTAL_OSS_ENC_KEY`

- 发现 prod `.env` 已有**遗留占位符** `PORTAL_OSS_ENC_KEY=<64字符>`,与本次 `openssl rand -hex 32` 生成的真 key **重复 2 行** → dotenv 解析有歧义,必须修。
- **停下报告 operator**(密钥不可逆 + 安全敏感,不擅自决定)→ operator 拍板:**留真 key、删占位符**。已 `sed` 删占位符行(备份 `.env.bak-w9d3`),剩 1 行 64-hex。
- ⚠️ **`PORTAL_OSS_ENC_KEY` 投产后不可更换**(换了已存客户 secret 全解不开)。**operator 请把它存进 1Password**:`ssh vps 'grep PORTAL_OSS_ENC_KEY /opt/silkroadai-portal/.env'`。

### Step 2 — prod migration apply

启动日志:`Applying migration 20260605140000_add_user_oss_configs` → `All migrations have been successfully applied` → `✓ Ready in 266ms`。`\d user_oss_configs` 确认表已建。

---

## 3. Smoke 结果

| #   | 检查                                | 结果                                                                                   |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | 无 OSS 配置用户生图 → 平台 R2(回归) | ✅ `![image](https://images.silkroadai.io/gen/…png)`,无 `X-Silkroadai-OSS-Fallback` 头 |
| 2   | OSS API 未登录                      | ✅ `GET /api/portal/oss` 401 · `POST /api/portal/oss/test-connection` 401              |
| 3   | `/settings/storage` 未登录          | ✅ 307 → /login                                                                        |
| 4   | Claude clamp + GPT 透传(回归)       | ✅ 200 + `x-silkroadai-clamped` / gpt-5.4 200                                          |
| 5   | **真实 R2 e2e**                     | ⏳ **待 operator 手动**(见下)                                                          |

部署后日志扫 `[oss]` / `[v1-proxy]` / error / fatal:**0 条**(无关的 `[balance-alert]` 邮件退信 2 条 = 2 个客户邮箱失效,W6 调度器,与本次无关)。

### Smoke 5 — operator 手动 e2e(feature 真正 ready 前必做)

1. 登录 portal → `/settings/storage` → 填一个真实 R2 测试 bucket → **测试连接** ✅ → 保存。
2. 用该账号的 sk 调 Gemini image → 返回 URL 应是**客户配置的前缀**(不是 images.silkroadai.io)。
3. 故意填错凭证 → 测试连接应 ❌ + 友好 message。
4. 清除配置 → 再生图 → 回 `images.silkroadai.io`。

---

## 4. 已知边界 / 后续

- 密钥安全:secret AES-256-GCM 加密,GET 永不回显;**`PORTAL_OSS_ENC_KEY` 投产后不可换**(请存 1Password)。
- proxy 对 DB / 客户 OSS 的所有故障**静默三级降级**平台 R2,客户请求不失败。
- **`/docs` 客户 API guide 的「自定义 OSS」章节**:待 operator 跑通 smoke 5(确认真实客户 bucket 流程 OK)后再补上线 —— 不提前给客户文档一个未 e2e 验证的流程。
- 未动 Caddy / 客户余额 / ModelPrice / new-api 源码;未调 `GET /api/user/token`。
- (沿用 W9 D2)平台 R2 `gen/` 前缀不在 image-cleanup cron 管辖 → 建议 R2 lifecycle rule。
