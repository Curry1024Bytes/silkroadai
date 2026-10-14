# new-api rc.22 → rc.44 升级方案(2026-10-14 评估)

> 状态:**评估完成,portal 侧前置改造已出 PR,升级本身未执行。** 原计划 2026-10-14 12:30 直切被叫停,原因见 §1。

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
4. **切后 30 分钟内**:root 在后台「安全与访问」建具名 PAT(永不过期)→ 替换 server2 六个 api 实例 + server1 portal 的 `.env` `NEWAPI_ADMIN_TOKEN` → 滚动 `--no-deps` 重启;`.env` 加 `NEWAPI_ACCESS_TOKEN_MODE=pat`。注册 smoke。
5. **切后 30 天内**:`NEWAPI_ROOT_USERNAME=root NEWAPI_ROOT_PASSWORD=… pnpm tsx scripts/migrate-newapi-legacy-access-tokens.ts --apply`(先 `--limit 20` 观察),直到 `pending=0`。到期日 = `SELECT value FROM options WHERE key='LegacyAccessTokenRetireAt'`(unix 秒)。
6. 后台请求策略里评估关闭/收窄 `codex cli trace` 渠道亲和;自动禁用关键字加「用户额度不足」「预扣费额度失败」。

## 3. 回滚

rc.44 对 `users`/`tokens` 只加列,不改旧列,`logs` 不动 → 把 compose 钉回 rc.22 重启即可回滚(新表/新列留着无害)。注意:一旦 rc.44 启动过,`LegacyAccessTokenRetireAt` 已写入 options;回滚到 rc.22 不读它,无影响;再次升级时沿用首次写入的日期(不会重置 30 天)。

## 4. 已知未验证项

- `New-Api-User` 头在 rc.44 源码里已不再被引用,继续发送无害。
- PAT 是否能调渠道管理路由(Casbin 派生 scope)——预演中确认。
- `POST /api/user/login` 若对 root 账号触发了 2FA/legal consent challenge,迁移脚本的 root 登录需要补 challenge 处理。
