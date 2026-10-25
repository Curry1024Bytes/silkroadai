# new-api rc.22 → rc.44 升级方案(2026-10-14 评估)

> 状态:**portal 前置改造 #521 已合并部署(server1);new-api-3 预演 rc.44 完成(§5);主实例升级未执行。** 原计划 2026-10-14 12:30 直切被叫停,原因见 §1。

## 1. 为什么不能直接切

对 rc.22 → rc.44 共 22 个版本的 release notes 和 rc.44 源码(`middleware/auth.go`、`model/user_access_token.go`、`controller/access_token.go`、`controller/user.go`、`middleware/access_token_routes.go`、`service/security_verification.go`)逐条核对:

| 项                                                   | 影响                                                                                                                                 | 结论                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| rc.41 `GET /api/user/token` 删除                     | portal 开户第 3 步 404/301 → 注册 + OAuth 首登全挂(同 2026-08-03 rc.22 事故)                                                         | **阻断**,PR 已把第 3 步改成版本分流(gotcha #24)                         |
| rc.41 legacy access_token 升级后 30 天作废、不能再生 | `.env` 的 `NEWAPI_ADMIN_TOKEN` + 689 个客户的 `newapi_access_token`                                                                  | **阻断**,需 admin PAT + 存量迁移脚本                                    |
| portal 未存客户 new-api 密码                         | 存量客户无法直接登录发 PAT                                                                                                           | 走 admin 重置密码路径(`scripts/migrate-newapi-legacy-access-tokens.ts`) |
| rc.26 quota 字段扩 bigint,启动检查表结构             | 我们库 `users/tokens/logs/...` 的 quota 列已全是 bigint                                                                              | 空操作                                                                  |
| rc.27 起「必须重配视频模型价格」                     | 只影响 new-api 原生任务型渠道;我们启用的渠道类型只有 1/3/14/24,视频走 portal 适配器                                                  | 不受影响                                                                |
| GORM 模型 DDL(rc.22 vs rc.44)                        | `logs`(2.05 亿行 / 167 GB)**无变化**;`users` +`access_token_created_at`;`tokens` +`auto_groups`;若干新表                             | 秒级,无需预建                                                           |
| rc.34 登录流重做                                     | `POST /api/user/login` 仍返 `data.access_token` JWT + `data.user`;无 2FA 用户不出 challenge                                          | portal `loginAsUser` 兼容,待预演验证                                    |
| rc.41 admin 敏感操作需一次性校验                     | `PUT /api/user/` 改密码/权限、`manage` 的 disable/enable/delete/promote 需 `X-Security-Proof`;**`add_quota` 不需要**(代码里先行分支) | 充值入账不受影响;portal 若有 disable/enable 用户的调用需补校验          |
| rc.38 请求策略(会话与重试 / 渠道健康)                | 后台可配,可能用来限制 10-14 害了 Booker 的 Codex 渠道亲和                                                                            | 升级动因之一                                                            |

PAT 的硬约束(rc.44 源码):每用户最多 20 个;`expires_at: 0` = 永不过期;scope 只能是持有人本来就有的权限;**只能在 dashboard 登录会话上创建**(PAT 不能再生 PAT),且必须带密码一次性校验的 `X-Security-Proof`。

## 2. 顺序

1. **portal PR 合并 + 部署**(本 PR):`issueCustomerAccessToken` 版本分流、`call()` `redirect:'manual'`、迁移脚本、文档。部署后在 rc.22 上行为不变(auto 探测到 rc.22 → 旧 rotate)。
2. **rehearsal**:在 server2 的 `new-api-3`(独立实例,无客户流量)切 rc.44,验证:
    - `POST /api/user/login` 响应形态;`POST /api/verify` + `POST /api/user/access_tokens` 真实返回(`nap_` 前缀、scope 校验);
    - root 建 PAT 后用它打 portal 用到的全部 admin 端点:`/api/user/{id}`、`/api/user/manage add_quota`、`/api/log/`、`/api/data/`、`/api/channel/`、`/api/channel/models_enabled`、`/api/option/`、`/api/token/*`(渠道路由走 Casbin 权限派生 scope,PAT 要勾对资源);
    - 迁移脚本对 1 个测试用户 `--user` 跑通。
3. **主实例切换**(低峰):`docker-compose.yml` 钉 `v1.0.0-rc.44`,`up -d new-api`。预期中断 ~10 s(logs 表无 DDL)。
4. **切后 30 分钟内**:root 在后台「安全与访问」建具名 PAT(永不过期,scope 全选:预演验证 36 个 scope 的 PAT 能打 portal 用到的全部 admin 路由)→ 替换 server2 十个 api 实例 + server1 portal 的 `.env` `NEWAPI_ADMIN_TOKEN` → 滚动 `--no-deps` 重启;`.env` 加 `NEWAPI_ACCESS_TOKEN_MODE=pat`。注册 smoke:`src/lib/newapi/__tests__/rc44-access-token.live.smoke.test.ts`(需 root 密码,会建一个 throwaway 客户)。
   ⚠️ **切换前把 `CRITICAL_RATE_LIMIT: "5000"` 加进主实例 compose env**(默认 20 次 / 20 分钟 / 每 IP;登录、`/api/verify`、建 PAT 都算「critical」。迁移脚本每个客户要 4 次,默认值下 689 个客户要跑 46 小时;portal 所有调用来自同一个 docker 网关 IP)。和升级同一次重启生效,迁移完可改回。
5. **切后 30 天内(2026-11-15 06:02 北京前)—— 存量客户 legacy token → PAT 迁移**。✅ 2026-10-17 已完成前置:root PAT「portal-admin」已建(全 36 scope、永不过期,由 operator 在 server2 跑 `/root/make-root-pat.sh` 交互生成,token 落 `/root/.newapi-root-pat` 0600,**四处** `.env` 的 `NEWAPI_ADMIN_TOKEN` 已换 + `NEWAPI_ACCESS_TOKEN_MODE=pat`:server1 portal/seedance 已重建生效;server2 与 api3 的十副本各挂了一次性定时器 21:40 / 21:55 UTC 逐个 `--force-recreate`)。迁移脚本**不能在 portal 容器里跑**(镜像没有 scripts/ 和 tsx),在本机 repo 检出里跑,打隧道:
    ```bash
    ssh -fN -L 15432:10.88.0.2:5432 -L 14001:127.0.0.1:3000 -o ServerAliveInterval=60 vps2   # portal-db + new-api master
    DATABASE_URL='postgresql://portal:<pw>@127.0.0.1:15432/silkroadai_portal_prod?sslmode=disable' NEWAPI_BASE_URL=http://127.0.0.1:14001 \
      pnpm dlx tsx@4 scripts/migrate-newapi-legacy-access-tokens.ts                  # dry-run:2026-10-17 = 669 linked / 668 pending
    …                                                             --apply --limit 20  # 终端提示输 root 密码;先小批
    …                                                             --apply             # 全量,约 2.5 s/客户 ≈ 30 min
    ```
    `pnpm dlx tsx` 需要 `node_modules/server-only/` 本地 stub(空 `index.js`,vitest 之外没人提供这个包)。root 密码只在 `--apply` 时要,`promptRootCredentials` 终端不回显;dry-run 不要凭据。单客户失败(new-api 用户已删 / 被禁)会 `FAILED` 记一行继续,CAS 写回保证不覆盖并发改动。完成标准:再跑一次 dry-run `pending=0`。到期日:`SELECT value FROM options WHERE key='LegacyAccessTokenRetireAt'`。迁移完可删两节点 compose 的 `CRITICAL_RATE_LIMIT` 两行。
6. 后台请求策略里评估关闭/收窄 `codex cli trace` 渠道亲和;自动禁用关键字加「用户额度不足」「预扣费额度失败」。

## 3. 回滚

rc.44 对 `users`/`tokens` 只加列,不改旧列,`logs` 不动 → 把 compose 钉回 rc.22 重启即可回滚(新表/新列留着无害)。注意:一旦 rc.44 启动过,`LegacyAccessTokenRetireAt` 已写入 options;回滚到 rc.22 不读它,无影响;再次升级时沿用首次写入的日期(不会重置 30 天)。

## 4. 已知未验证项(预演后)

- `New-Api-User` 头在 rc.44 源码里已不再被引用,继续发送无害(预演:带与不带都 200)。
- 主实例 2.05 亿行 logs 表的实际启动时长(预演库只有 204 行,9 秒就绪;源码 diff 显示 logs 无 DDL,预期同样秒级)。

## 5. new-api-3 预演记录(2026-10-14,server2 `/opt/new-api-3`,rc.22 → rc.44)

- 备份 `backup-pre-rc44-20261014-0555.dump` + `docker-compose.yml.bak-rc22-20261014`;`up -d` 后 **9 秒**就绪,迁移日志无报错;首启写入 `LegacyAccessTokenRetireAt = 2026-11-13 13:55 北京`(= 启动时刻 + 30 天)。
- **legacy 32 字符 root token 在 rc.44 上照常工作**(`/api/user/:id`、`/api/channel/`、`/api/user/manage add_quota` 全 200),直到 retire 日。
- `POST /api/user/login` 响应:`data.{access_token, token_type:"Bearer", access_expires_at, session{sid,…}, user}`,无 2FA 的 root 不出 challenge,portal `loginAsUser` 直接兼容。
- root PAT catalog:personal(profile/api_key/usage/wallet/account_security)+ admin(user/billing/model/deployment/log/redemption/group/audit/channel[read,operate,write,sensitive_write,secret_view]/task_plugin)+ system(option/plugin/ops),max 20,默认 30 天,`expires_at:0` 永不过期。**全 scope 的 root PAT 打 portal 用到的 16 条 admin 路由全部 200**(含 `/api/channel/`、`/api/channel/models_enabled`、`/api/log/`、`/api/data/`、`/api/option/`、`/api/user/manage add_quota`)。
- **portal 真实代码 e2e 通过**(`rc44-access-token.live.smoke.test.ts`,admin 凭据分别用 PAT 与 legacy 各跑一遍):`provisionNewCustomer` auto 模式识别 rc.44 → 发 `nap_` 47 字符 PAT → act-as 建 key / 列 key / 取 sk 正常(~1.5–2.2 s);`reissueCustomerAccessTokenViaAdminReset`(root 登录 → `admin.user.update` 证明 → 重置密码 → 客户登录 → 新 PAT)通过,旧 PAT 不被密码重置吊销。
- **预演抓出的 bug**:portal 写的校验 scope 是 `admin_user.update`,rc.44 真名是 `admin.user.update`(点分);已改。另外 `GET /api/user/:id` 回显非空 `admin_permissions` 映射,原样 PUT 回去会被当成「改权限」要求证明 —— helper 现在剔掉它再 PUT。
- 需要证明的 admin 操作(PAT/legacy 都绕不过):`manage` 的 disable/enable/delete/promote、`PUT /api/user/` 带 password 或 admin_permissions、`DELETE /api/user/:id`。**PAT 身份拿不到 `admin.user.*` 证明**(verify 回 SCOPE_MISMATCH),只有 root 登录会话可以 → 迁移脚本必须 root 登录,不能用 admin PAT。`add_quota`、改 group/remark 不需要证明(portal 现网只用 add_quota)。
- 证明语义:context 不匹配 → 403 `SECURITY_PROOF_CONTEXT_MISMATCH` 且**证明不被消耗**;密码错 → 200 体 `SECURITY_VERIFICATION_FAILED`;PAT 不能再建 PAT(`AUTH_SESSION_REQUIRED`)。
- **碰到 `CRITICAL_RATE_LIMIT`**:第二轮 e2e 在 `POST /api/user/access_tokens` 吃 429(同 IP 20 次 / 20 分钟),见 §2 第 4 步。
- 顺带:new-api-3 `SECRETS.txt` 里的 root token 与密码都已失效(与 DB 不一致),本次已重置 root 密码并把 token 从 DB 回填到 SECRETS.txt(备份 `SECRETS.txt.bak-20261014`)。预演留下的 throwaway 用户(uid 3–6、`rc44p*`)未删(rc.44 删用户需 root 证明,无害)。
