# Seedance 大客户独立门户 — 运维 Runbook

> 2026-07-19 · P1+P2+P3 全部上线(PR #244/#245/#247/#249/#250)。
> 本文是 operator 日常操作手册:开户 / 入账 / 议价 / 对账 / 排障 / 客户接入速查。

---

## 0. 门户是什么(30 秒)

- **入口**:裸 IP `128.241.232.23`(HTTP :80;HTTPS :443 自签,客户需关证书校验)
    - `http://128.241.232.23/v1/*` — 客户 API(视频生成)
    - `http://128.241.232.23/api?Action=…` — 素材库 API(火山方舟形)
    - `http://128.241.232.23` — 客户控制台(浏览器打开自动跳登录)
- **架构**:与主站同代码同库,独立容器 `silkroadai-seedance-portal`(127.0.0.1:3003,`PORTAL_FLAVOR=seedance-enterprise`),Caddy 白名单反代。**全链路不碰 new-api**:自发 `sk-ent-` 密钥、每客户独立上游 key(AES 加密存库)、余额走 portal ¥ 账本、按上游真实 token 精确扣费。
- **admin 操作**:全部在 VPS 本机 curl `127.0.0.1:3003/api/admin/enterprise/*`(x-admin-token 守门,**不出公网**)。

**每次操作前的准备**(下文所有命令都假设已执行):

```bash
ssh vps
cd /opt/silkroadai-portal
AT=$(grep ^ADMIN_TOKEN .env | cut -d= -f2 | tr -d '"')
```

---

## 1. 给客户开账号

### 1.1 前置:拿该客户的独立上游 key

找上游(token.xinhankr)按客户开子 key 或新账户。目的:上游侧成本按客户天然分账 +
「余额<¥5 全 403」互不影响。⚠️ 应急时可先用现有共享渠道 key(`grep SEEDANCE_XHK_KEY .env`)
开户,后续换 key 需人工改库(见 §7.4)。

### 1.2 开户(一条命令:账号 + 上游key + 首把密钥 + 可选首笔入账)

```bash
curl -s -X POST http://127.0.0.1:3003/api/admin/enterprise/onboard \
  -H "x-admin-token: $AT" -H "content-type: application/json" \
  -d '{
    "email": "customer@example.com",
    "name": "客户名称",
    "upstream_key": "sk-xxxx(该客户上游key)",
    "upstream_note": "上游侧备注(哪个账户,对账用)",
    "credit_cny": 5000,
    "note": "首充,打款流水号xxx"
  }'
```

**响应里的 `key`(`sk-ent-…`)只显示这一次** —— 立即保存并发给客户。服务端只存
sha256,丢了不可找回,只能让客户在控制台重新创建一把。
`credit_cny`/`note` 可省略(先开户后入账)。邮箱已存在 → 409(不会重复建)。

### 1.3 设控制台登录密码

```bash
curl -s -X POST http://127.0.0.1:3003/api/admin/enterprise/set-password \
  -H "x-admin-token: $AT" -H "content-type: application/json" \
  -d '{"email":"customer@example.com","password":"初始密码至少8位"}'
```

重置密码也用这条(会自动踢掉客户已登录的旧会话)。

### 1.4 交付给客户的四样东西

| 项       | 值                                          |
| -------- | ------------------------------------------- |
| API 密钥 | `sk-ent-…`(1.2 响应里的 key)                |
| Base URL | `http://128.241.232.23/v1`                  |
| 控制台   | `http://128.241.232.23`(浏览器打开即登录页) |
| 登录凭据 | 邮箱 + 1.3 设置的密码                       |

---

## 2. 余额入账 / 冲正

客户对公打款确认到账后:

```bash
curl -s -X POST http://127.0.0.1:3003/api/admin/enterprise/credit \
  -H "x-admin-token: $AT" -H "content-type: application/json" \
  -d '{"email":"customer@example.com","amount_cny":10000,"note":"对公转账,流水号xxx"}'
```

- 响应返回 `balance_after`;客户控制台「概览/计费流水」**立即可见**这笔充值。
- `amount_cny` 传**负数** = 冲正/扣减(入错金额等)。`note` 必填(审计,建议写打款流水号)。
- 单笔上限 ±1,000,000;可用 `user_id` 替代 `email` 定位客户。
- 每笔都进 ¥ 账本(`ledger_entries`,带余额快照)—— 你和客户看到的是同一份账。

---

## 3. 大客户议价(费率覆盖)

默认费率 = 挂牌(见 §5 表)。谈了特殊价,按【客户 × 分辨率 × 是否含视频输入】覆盖:

```bash
# 例:给某客户 pro 720p 无视频档改成 ¥35/1M token(variant 可省略,默认 pro)
curl -s -X POST http://127.0.0.1:3003/api/admin/enterprise/rate-override \
  -H "x-admin-token: $AT" -H "content-type: application/json" \
  -d '{"user_id":"<用户uuid>","variant":"pro","resolution":"720p","has_video":false,"cny_per_m":35}'

# 取消覆盖(回落默认挂牌):cny_per_m 传 null
curl -s -X POST http://127.0.0.1:3003/api/admin/enterprise/rate-override \
  -H "x-admin-token: $AT" -H "content-type: application/json" \
  -d '{"user_id":"<用户uuid>","variant":"pro","resolution":"720p","has_video":false,"cny_per_m":null}'
```

- `variant`:`pro` / `fast` / `mini`(按变体分别议价,互不影响);`resolution`:`720p` / `1080p` / `4k`(fast/mini 无 4k)。
- 只影响**之后完成的任务**;已扣费任务不重算。
- `user_id` 查法:见 §6.1。

---

## 4. 密钥管理

- **客户自助**(控制台「API 密钥」页):创建(上限 10 把 active)/ 禁用 / 看最近使用时间。
- **admin 干预**(极端情况,直接 psql):

```bash
# 禁用某客户的某把 key(按前缀定位)
docker exec silkroadai-portal-db psql -U portal -d silkroadai_portal_prod \
  -c "UPDATE enterprise_keys SET status='disabled' WHERE key_prefix='sk-ent-xxxxx';"
# 重新启用同理 SET status='active'
```

禁用即刻生效(下一次请求 401)。密钥明文不可恢复 —— 只能新建。

---

## 5. 计费与对账

### 5.1 对客费率(默认挂牌 = 火山挂牌 × 0.85,元 / 1M token)

| 变体 | 分辨率       | 无视频输入(文生/图生/首尾帧/多图) | 含视频输入(参考视频) |
| ---- | ------------ | --------------------------------- | -------------------- |
| pro  | 720P         | ¥39.1                             | ¥23.8                |
| pro  | 1080P        | ¥43.35                            | ¥26.35               |
| pro  | 4K           | ¥22.1                             | ¥13.6                |
| fast | 720P / 1080P | ¥31.45                            | ¥18.7                |
| mini | 720P / 1080P | ¥19.55                            | ¥11.9                |

(fast/mini 2026-07-19 上线,上游 `artsdance2.0-{fast,mini}-260701`,无 4K 档;
成本 = 挂牌 × 0.75,毛利同 pro ≈ 13.3%。议价覆盖 §3 现在带 `variant` 字段。)

- 扣费 = 上游返回的真实 `usage.completion_tokens` ÷ 1e6 × 费率(轮询完成时自动扣,幂等)。
- 参考:720p 5s ≈ 108,872 token ≈ **¥4.26**。失败任务不计费。
- 提交时有余额门:估价 > 余额 → 402(客户请求被拒,不会透支)。
- 成本口径:挂牌 = 火山官方 × 0.85;上游给我们 0.75 → 毛利 ≈ 13.3%(议价时别击穿 0.75)。

### 5.2 查账(psql)

```bash
# 客户账本流水(充值/消费/调整,带余额快照)
docker exec silkroadai-portal-db psql -U portal -d silkroadai_portal_prod -c "
  SELECT le.created_at, le.kind, le.amount_cny, le.balance_after, le.note
  FROM ledger_entries le JOIN accounts a ON le.account_id=a.id
  JOIN users u ON a.user_id=u.id WHERE u.email='customer@example.com'
  ORDER BY le.created_at DESC LIMIT 30;"

# 客户视频任务明细(计费真相表)
docker exec silkroadai-portal-db psql -U portal -d silkroadai_portal_prod -c "
  SELECT t.created_at, t.model, t.duration, t.status, t.tokens, t.cost_cny, t.billed
  FROM seedance_video_tasks t JOIN users u ON t.user_id=u.id
  WHERE u.email='customer@example.com' AND t.tier='enterprise-portal'
  ORDER BY t.created_at DESC LIMIT 30;"
```

- `billed=true 且扣款失败`(日志有 `deduct FAILED`)= 极少数漏收,人工按 cost_cny 补一笔负 credit 对平。
- 与上游对账:上游后台按该客户独立 key 的消耗 ↔ 我们 `seedance_video_tasks` 的 token 合计。

---

## 6. 常用查询 / 快捷操作

### 6.1 查客户 user_id / 余额

```bash
docker exec silkroadai-portal-db psql -U portal -d silkroadai_portal_prod -c "
  SELECT u.id, u.email, a.balance_cny
  FROM users u LEFT JOIN accounts a ON a.user_id=u.id
  JOIN enterprise_upstream_keys k ON k.user_id=u.id;"
```

(带 `enterprise_upstream_keys` join = 只列企业门户客户。)

### 6.2 封禁客户(欠费/违规)

```bash
# 最快:禁用其全部 key(API 立即 401;控制台仍可登录看账)
docker exec silkroadai-portal-db psql -U portal -d silkroadai_portal_prod \
  -c "UPDATE enterprise_keys SET status='disabled' WHERE user_id='<用户uuid>';"
```

### 6.3 素材库配额调整(env,默认 500 个 / 5GB / 单文件 100MB)

`.env` 加 `ENTERPRISE_MAX_ASSETS` / `ENTERPRISE_MAX_ASSET_BYTES` / `ENTERPRISE_MAX_ASSET_FILE_BYTES`
后重启企业容器:`docker compose -f docker-compose.prod.yml up -d seedance-portal`

---

## 7. 故障排查

| 症状                            | 原因 → 处理                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 客户全部请求 401                | key 被禁用/填错。查 `enterprise_keys.status`;必要时重新启用(§4)                                           |
| 客户 402 余额不足               | 正常挡付。确认打款后 §2 入账                                                                              |
| 客户 403「账户余额不足5元」     | **上游**该客户 key 所在账户余额 <¥5 → 上游充值(与我们的 ¥ 账本无关)                                       |
| 客户 503 account_not_configured | 该客户没配上游 key 或解密失败 → 查 `enterprise_upstream_keys` 行 + `ENTERPRISE_UPSTREAM_ENC_KEY` env 未变 |
| 登录 200 但弹回登录页           | 企业容器 env 丢了 `BRAND_COOKIE_DOMAIN=''`+`SESSION_COOKIE_SECURE=false`(compose 里定义,别删)             |
| 素材上传失败                    | 查配额(§6.3)/ R2 env;CreateAsset 报 InvalidParameter 多为源 URL 不可抓(内网/超 100MB/非 http)             |
| 客户说视频链接打不开            | 火山直链约 24h 过期(设计如此)—— 让客户及时下载转存                                                        |

日志:`docker logs silkroadai-seedance-portal --tail 100`(关键字 `[enterprise-` )。

### 7.4 换客户的上游 key(上游 key 泄露/轮换)

上游 key 是 AES-256-GCM 加密存库,没有现成端点 —— 在企业容器里跑一次性 node:

```bash
docker exec silkroadai-seedance-portal node -e "
const {createCipheriv,randomBytes}=require('crypto');
const key=Buffer.from(process.env.ENTERPRISE_UPSTREAM_ENC_KEY,'hex');
const iv=randomBytes(12);const c=createCipheriv('aes-256-gcm',key,iv);
const ct=Buffer.concat([c.update(process.argv[1],'utf8'),c.final()]);
console.log(Buffer.concat([iv,c.getAuthTag(),ct]).toString('base64'));
" "新的上游key明文"
# 拿输出的 base64 更新:
docker exec silkroadai-portal-db psql -U portal -d silkroadai_portal_prod \
  -c "UPDATE enterprise_upstream_keys SET upstream_key_enc='<上面的base64>' WHERE user_id='<用户uuid>';"
```

---

## 8. 客户接入速查(可直接发给客户的技术对接人)

**鉴权**:所有请求带 `Authorization: Bearer sk-ent-…`

**视频生成**(OpenAI 视频规范):

```bash
# 提交(模型:seedance2.0-pro-{720p|1080p|4k} 文生;同名 -ref 档收图/视频参考)
curl -X POST http://128.241.232.23/v1/video/generations \
  -H "Authorization: Bearer sk-ent-…" -H "Content-Type: application/json" \
  -d '{"model":"seedance2.0-pro-720p","prompt":"一只猫在窗台上","duration":5}'
# → {"task_id":"cgt-…","status":"queued"}

# 轮询(completed 后 video_url = 火山直链,约 24h 过期请及时下载)
curl http://128.241.232.23/v1/video/generations/cgt-… -H "Authorization: Bearer sk-ent-…"
```

模型(3 个,2026-07-20 归一):**`seedance-2-0`(pro)/ `seedance-2-0-fast` / `seedance-2-0-mini`**。
分辨率走 **`resolution` 参数**:`720p`(默认)/ `1080p` / `4k`(4k 仅 seedance-2-0);
带参考图/视频/音频**自动识别**,无需换模型名。
(旧 14 个长名 `seedance2.0-pro-720p` 等仍兼容可调,但不再对外宣传。)
参数:`duration` 5/10;`ratio` 16:9/9:16/4:3/3:4/1:1/21:9;参考输入收
`images`(≤9,支持 role first_frame/last_frame)/ `first_frame` / `last_frame` /
`reference_videos`(≤3)/ `audios`(需配图);URL 或 base64 data URL 均可。

```bash
# 例:mini 档 1080p 图生视频
curl -X POST http://128.241.232.23/v1/video/generations \
  -H "Authorization: Bearer sk-ent-…" -H "Content-Type: application/json" \
  -d '{"model":"seedance-2-0-mini","resolution":"1080p","prompt":"…","images":["asset-…"]}'
```

**素材库**(对标火山方舟,`POST /api?Action=…&Version=2024-01-01&ns=asset_manager`):

```bash
# 注册素材(URL 需公网可抓;或直接在控制台「素材库」页上传本地文件)
curl -X POST "http://128.241.232.23/api?Action=CreateAsset&Version=2024-01-01&ns=asset_manager" \
  -H "Authorization: Bearer sk-ent-…" -H "Content-Type: application/json" \
  -d '{"AssetType":"image","URL":"https://…/ref.png","Name":"主角图"}'
# → Result.Id = "asset-…"
```

支持 Action:`CreateAsset / GetAsset / UpdateAsset / DeleteAsset / ListAssets /
CreateAssetGroup / GetAssetGroup / UpdateAssetGroup / DeleteAssetGroup / ListAssetGroups`。

**生成里引用素材**:把 `asset-…` 直接填进任意媒体字段;`group-…` 放进 `images`
数组会按加入顺序展开组内全部素材(多图参考):

```json
{"model":"seedance2.0-pro-720p-ref","prompt":"…","images":["asset-20260719153358-db513a"]}
{"model":"seedance2.0-pro-720p-ref","prompt":"…","images":["group-20260719153506-b945c6"]}
```

**控制台**:`http://128.241.232.23` — 余额/计费流水/调用日志/密钥/素材库自助管理。

---

## 9. 安全与备份注意

- `ENTERPRISE_UPSTREAM_ENC_KEY`(.env)**不可更换**(换了所有已存上游 key 解不开)——
  确认已存 1Password。`.env` 变更前先备份(`cp .env .env.bak-<date>`,现有备份
  `.env.bak-enterprise-p1`)。
- Caddyfile 变更前备份(现有 `Caddyfile.bak-enterprise-p1/-p2`);改完 `caddy validate` 再 reload。
- `ADMIN_TOKEN` 等价 superadmin,只在 VPS 本机使用,不进任何公网请求。
- 库表已在每日 4-DB 离线加密备份范围内(与主库同库)。
- 部署:`git pull && docker compose -f docker-compose.prod.yml up -d --build portal seedance-portal`;
  有新 migration 先 temp-DB 验证再 `migrate deploy`(容器内 `node node_modules/prisma/build/index.js migrate deploy`,standalone 镜像没有 npx prisma)。

---

**测试账号**(演示用):`enterprise-smoke-p1@silkroadai.io` / `HJVqZog0Ce1McDty`,
key `sk-ent-b0db8…`(active),余额 ¥1.49(演示前先 §2 补一笔)。
