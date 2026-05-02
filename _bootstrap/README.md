# Silk Road AI — B3 路线 Bootstrap 包

> 决策日期:2026-05-02
> 取代:`litellm-portal-bootstrap/`(W1 完成,归档)

---

## 路线总览

**B3 = new-api 后端 + silkroadai 前端继续用 + Chat UI**

详见 `docs/PROJECT-PLAN-B3.md`。

## 你今天就能做的事(W2 D1)

```bash
# 1. 在 Mac 上把脚本上传到 VPS
cd ~/Documents/"silk road ai"/b3-bootstrap
scp scripts/deploy-new-api.sh root@23.27.113.88:/tmp/

# 2. SSH 到 VPS 跑
ssh root@23.27.113.88
bash /tmp/deploy-new-api.sh

# 3. 等脚本提示完成,然后:
#    - 立即把 /tmp/new-api-credentials.txt 内容存 1Password
#    - 删掉这个文件:rm /tmp/new-api-credentials.txt
#    - 去 Namecheap 加 admin.silkroadai.io 的 A 记录(指向 23.27.113.88)
#    - 等 5-15 分钟 DNS 生效
#    - 浏览器打开 https://admin.silkroadai.io 用 root 密码登录
```

## 包内容

```
b3-bootstrap/
├── README.md                          ← 本文件
├── docs/
│   ├── PROJECT-PLAN-B3.md             ← 完整 6 周路线图
│   ├── WEEK2-CHECKLIST.md             ← W2 D3-D7 day-by-day 任务卡
│   └── SILKROADAI-README-NEW.md       ← silkroadai 仓库新 README(W2 D7 替换)
├── scripts/
│   └── deploy-new-api.sh              ← VPS 部署 new-api 一键脚本(D1)
├── src/lib/newapi/
│   └── client.ts                      ← new-api admin API 完整 TypeScript 封装
└── prisma/
    └── schema-b3.diff.prisma          ← W2 D4 schema 改造指引
```

## 与 W1 工作的关系

W1 完成的 7 个 commit 在 silkroadai repo 主分支保留。B3 路线在此基础上演进:
- 70% W1 代码可复用(JWT auth、易支付集成、订单流程、Prisma 框架)
- 30% 重写(LiteLLM client → new-api client、schema 微调、register 逻辑改造)

W1 路径不浪费,作为基础设施继续用。

## 为什么改路线

W1 完成后,用户列了 13 项核心需求,Cowork 评估发现其中 8 项是 to-C SaaS 标配,
new-api 已经全部实现且活跃维护(25.4K stars, 791 commits / 4 个月)。
继续 LiteLLM Portal 等于重新发明 new-api,B3 借用 new-api 后端 + 自写前端
是工时和品牌差异化的最优解(Topology B3,详见 PROJECT-PLAN-B3.md)。

## 关键技术决策

1. **不修改 new-api 源码** — 保护 AGPL 不触发,法律最稳
2. **silkroadai 仓库继续用** — W1 工作 70% 可复用,从已有基础推进
3. **Chat UI 用 fork LibreChat** — MIT 协议,品牌差异化空间大
4. **LiteLLM 暂留** — W2 D3 验证 new-api 完全可用前不关停,作 fallback

## 下一步

1. 用户:跑 deploy-new-api.sh,部署 new-api 到 VPS
2. 用户:在 admin.silkroadai.io 配置全部上游渠道
3. Cowork 帮你:生成 W2 D4-D7 的详细 checklist + new-api client.ts 模板 + Prisma schema 调整 diff
4. Claude Code 接手:在 silkroadai 仓库执行 W2 D4-D7 改造

---

**版本**: 1.0
**生成时间**: 2026-05-02
