# W8 D8 — Reseller commission 缺失审计

> 阶段 A audit(2026-06-04,prod `silkroadai_portal_prod`,只读 SQL)。
> 客户报告某 reseller 在 `/reseller` 看不到被邀请人充值 / 分佣。

## 结论:**无 commission 写漏 bug。无需 backfill。系统正常。**

## 数据(prod 实测)

```
paid_orders=31  recharge_logs=29  commissions=9  resellers=13  users_with_inviter=18
```

22 个「已付但无 commission」订单的 4 分类:

| 分类  | 含义                                                        | 数量  | ¥ 合计  |
| ----- | ----------------------------------------------------------- | ----- | ------- |
| A     | 无 inviter + 无 recharge_log(overflow-FAILED)               | 1     | 1000.00 |
| B     | 无 inviter,有 recharge_log(**正常,本就不该有 commission**)  | 20    | 531.00  |
| C     | 有 inviter,**无** recharge_log(overflow 受害,inviter 损失)  | 1     | 1000.00 |
| **D** | **有 inviter + 有 recharge_log,缺 commission(真 bug 嫌疑)** | **0** | —       |

**D = 0**(明细查询 0 行)。**真·backfill 候选**(recharge_logs.invitee 有 inviter_reseller_id 且无 commission)= **0 行**。

## 系统实际工作正常

每个 reseller 的 invitee 充值 → commission 对账(只 arisyem8 有活动):

| reseller           | 状态          | invitees | invitee 已付单 | invitee recharge_logs | commissions  |
| ------------------ | ------------- | -------- | -------------- | --------------------- | ------------ |
| arisyem8@gmail.com | active/bronze | 12       | 10             | 9                     | **9**(1:1 ✓) |
| 2112582653@qq.com  | active        | 4        | 0              | 0                     | 0            |
| yc016899@gmail.com | active        | 2        | 0              | 0                     | 0            |
| 其余 10 个         | active        | 0        | 0              | 0                     | 0            |

9 条 commission 全归 arisyem8,rate 0.1000(bronze 10%):**6 pending**(hold_until 至 2026-06-17)+ 3 confirmed,合计 ¥95。每一笔成功的 attributed 充值都生成了 commission。

## 客户投诉的真实原因(非 bug)

1. **6/9 commission 仍是 `pending`**(在 14 天 hold 窗口内,最晚 2026-06-17 才 confirm)→ reseller 看 dashboard 以为「没拿到」,其实是正常持有期。
2. **arisyem8 在 bingleyou 的 ¥1000 单上少赚 ¥100**:该单(`cmpshsc12000m01p74inaasm1`,2026-05-30 FAILED,failed_reason = `numeric field overflow`)正是 PR #69 的病灶 —— overflow 让 recharge_log 没生成 → 无法挂 commission。这是 **C 类**唯一一例,属 PR #69 bug 的下游,**不是 commission 逻辑 bug**。bingleyou 的 ¥100/¥300 成功单 commission(¥10+¥30 pending)都在。

## 推荐

- **阶段 B:跳过** —— D=0,commission 写逻辑无 bug。`writeCommissionInTx` / `isAttributionActive` 对所有 attributed 成功充值都正确触发。
- **阶段 C:backfill 候选 = 0** —— 仍按 brief 交付 `scripts/backfill-missing-commissions.mjs`(只读 dry-run + `--apply`)作为**核验 + 未来工具**;今天跑 dry-run 报告 0 条。
    - 唯一的 attributed 损失(arisyem8 在 bingleyou ¥1000 上的 ¥100)**无法 backfill**(无 recharge_log 可挂,brief §4.3 明令跳过)。是否人工补偿 arisyem8 这 ¥100 由 operator 决策(脚本不碰)。
- **阶段 D**:无代码改动 → 单独脚本 + audit 文档 PR(不动 executeRecharge,与 PR #69 独立)。
