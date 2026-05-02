# Silk Road AI Portal Bootstrap Pack

> 给 `yexioy/silkroadai`(从 `touwaeriol/sub2apipay` fork)项目的启动套件。
> 包含改造路线图、setup 脚本、新数据库 schema、LiteLLM client 第一版、第一周任务卡。

---

## 包含的文件

```
litellm-portal-bootstrap/
├── README.md                          ← 本文件
├── CLAUDE.md                          ← ⭐ Claude Code 项目上下文(必拷到 fork 根目录)
├── docs/
│   ├── PROJECT-PLAN.md                ← 完整改造路线图(三阶段,3-6 周)
│   └── WEEK1-CHECKLIST.md             ← 第一周每天具体任务(D1-D7)
├── scripts/
│   ├── 01-rename-project.sh           ← 项目重命名(sub2apipay → silkroadai-portal)
│   └── 02-local-dev-setup.sh          ← 本地 Mac 开发环境一键 setup
├── src/lib/litellm/
│   └── client.ts                      ← LiteLLM Admin API 客户端封装
└── prisma/
    └── schema.diff.prisma             ← 新增 User、LiteLLMKey、RechargeLog 三张表的 Prisma 模型
```

---

## 怎么用

### 步骤 1:Clone 你的 fork 到本地 Mac

```bash
cd ~/Code      # 或你常用的代码目录
git clone git@github.com:yexioy/silkroadai.git
cd silkroadai
```

### 步骤 2:把 bootstrap 拷进去作为辅助

```bash
cp -r ~/Documents/"silk road ai"/litellm-portal-bootstrap ./_bootstrap
```

### 步骤 3:跑重命名脚本

```bash
bash _bootstrap/scripts/01-rename-project.sh
```

### 步骤 4:按照 WEEK1-CHECKLIST 一天天推进

打开 `_bootstrap/docs/WEEK1-CHECKLIST.md`,按 D1-D7 逐天执行。

---

## 整体路线图速览

| 阶段 | 周数 | 核心任务 | 输出 |
|---|---|---|---|
| **阶段 1** | W1 | 项目脚手架 + 数据库 + LiteLLM client | `pnpm dev` 跑起来,注册 API 端到端通 |
| **阶段 2** | W2-3 | 用户系统(注册/登录/邮箱)+ 充值流程 | 一个客户能完整走完"注册→充值→拿 Key"流程 |
| **阶段 3** | W4-6 | 客户后台 + 服务条款 + 部署 + 灰度 | portal.silkroadai.io 上线,5-10 个种子客户 |

详见 `docs/PROJECT-PLAN.md`。

---

## 关键设计决策

1. **架构 A**:LiteLLM 一字不改(避免 Fork 维护负担),Portal 在前面套一层
2. **Portal 是 LiteLLM 的"客户层"**:注册/支付/Key 管理/余额展示都在 Portal
3. **每客户一 Key 模式(模式 X)**:每个 portal user 对应 LiteLLM 一个 user + 一个 default key
4. **Portal 有自己的 User 表**(原 Sub2ApiPay 没有)
5. **充值 → max_budget**:Portal 维护累计充值,每次充值后 PUT `max_budget = SUM(recharges)` 到 LiteLLM
6. **复用所有支付逻辑**:easypay / wxpay / alipay / stripe 完全保留

---

## 关键技术 gotcha 提醒(开发时务必注意)

1. **`/key/update` 的 max_budget 是替换不是增加** — 必须算累计充值再 PUT
2. **LiteLLM 缓存 key state 60 秒** — 充值后立即调一次 `/key/info` 强制刷新
3. **流式请求会小额超支** — UI 显示余额 `clamp(0, max - spend)`
4. **退款让 max_budget < spend** → 同步 reset_spend 政策
5. **时区 UTC** — 客户端时间转 UTC 再查 spend logs

详见 `docs/PROJECT-PLAN.md`「关键技术 gotcha 速查」。

---

## 还没解决的问题(待后续处理)

1. **Sub2API admin key 没有"无限额度"** — 需要写 cron 监控告警
2. **LiteLLM master key 已泄露** — 必须先 rotate 才能上生产
3. **LiteLLM UI 主题色还是紫色** — 上线前可以补一个 sed CSS hex 替换

---

## 文件之间的关系

```
开发起点:scripts/01-rename-project.sh (一次性运行)
              ↓
开发参考:docs/WEEK1-CHECKLIST.md (每天看一次)
              ↓
代码模板:src/lib/litellm/client.ts (复制到 fork 里)
              ↓
DB 模板:prisma/schema.diff.prisma (合并到 fork 的 schema.prisma)
              ↓
战略参考:docs/PROJECT-PLAN.md (大方向不清楚时看)
```

---

**版本**: 1.0
**生成时间**: 2026-05-01
