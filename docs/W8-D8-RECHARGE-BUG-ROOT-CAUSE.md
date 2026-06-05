# W8 D8 — executeRecharge numeric overflow + 重试 idempotency 双 bug 根因

> 阶段 A audit 输出(2026-06-03)。客户 `zhengyilong0421@gmail.com`(portal id
> `9b4d578d-266a-4069-93e3-1fc1ecfb1fa8`,newapi_user_id=40)付 ¥1000 拿到 ~¥13,200。

## 200 字总结

`executeRecharge` 把 **raw quota**(`getUser().quota`,生产环境 1–2 亿)直接塞进
`recharge_logs.balance_before` / `balance_after`,而这两列是 `numeric(12,4)`(上限
99,999,999.9999 ≈ 1 亿)。¥1000 充值换算 ≈1.43 亿 raw quota,`balance_after` 当场
overflow,`rechargeLog.create()` 抛 `numeric field overflow`。致命点在于这个
`rechargeLog.create()`(同时是二级 idempotency 去重行)与不可回滚的 `applyTopup`
HTTP 调用 **被包在同一个 interactive transaction 里**:applyTopup 已把 quota 打进
new-api → overflow 抛错 → 整个 tx 回滚 → 去重行没落库 → order 退回 FAILED →
confirmPayment 返回 false → 支付宝 webhook 自动重试 → 重复 ~13 次 = 13×。

## 哪个字段被塞了 raw quota / 哪行代码

| 字段                 | schema        | 写入行            | 写入值                                                 | 单位          | 结论                   |
| -------------------- | ------------- | ----------------- | ------------------------------------------------------ | ------------- | ---------------------- |
| `amount`             | numeric(12,4) | `service.ts:1221` | `cnyAmount.toFixed(4)`                                 | ¥CNY          | ✅ 正确                |
| `balance_before`     | numeric(12,4) | `service.ts:1222` | `balanceBefore`(= `getUser().quota`,`service.ts:1141`) | **raw quota** | ❌ overflow 源         |
| `balance_after`      | numeric(12,4) | `service.ts:1223` | `balanceAfter`(= `getUser().quota`,`service.ts:1205`)  | **raw quota** | ❌ overflow 源         |
| `newapi_quota_added` | BigInt        | `service.ts:1226` | `BigInt(totalQuota)`                                   | raw quota     | ✅ 正确(BigInt 不溢出) |

`NewApiUserSchema.quota` 是 `z.number().int()`(`client.ts:229`),即 new-api raw quota。
`balance_before/after` 是该值未经 `quotaToCny()` 换算就写进 numeric(12,4)。

## overflow 阈值(numeric(12,4) max ≈ 1 亿 raw quota)

- 生产常量(`QUOTA_PER_USD=1,000,000`, `USD_TO_CNY_RATE=7` — 与客户 ¥7,091 / ¥13,200 吻合):
  `cnyToQuota(1000)=142,857,143` > 1 亿 → **¥1000 充值第 1 次 attempt 的 `balance_after` 就 overflow**。
- 开发/测试常量(`500,000` / `7.2`):`cnyToQuota(1000)=69,444,444`,第 1 次 attempt fits,
  但第 2 次 attempt 的 `balance_before`(=69M)叠加后 `balance_after`=139M overflow。
- 结论:**任何累计 quota 余额 > ~$200(≈¥1,400)的用户做任何充值,或单笔 ≥ 阈值的充值,都会 overflow**。
  这是潜伏的全局 bug,不止这一个客户 —— 阶段 C 扫历史。

## 两个独立 bug

1. **numeric overflow**(失败的直接原因):raw quota 写进 numeric(12,4)。
2. **重试 idempotency 设计缺陷**(放大成 13× 的原因):二级去重行 `rechargeLog`(及其
   create)与不可回滚的 `applyTopup` HTTP 副作用同处一个 transaction。任何 applyTopup
   **之后** 的失败(overflow / commission hook throw / 任意 DB 抖动)都会回滚去重行而
   留下已生效的 applyTopup,webhook 重试就重复扣。**修 #1 能止住本次,但 #2 不修则下一个
   post-topup 失败点会复现同样的灾难。**

## 推荐修法(两个都改)

- **修 A(overflow)**:
    - schema:`balance_before` / `balance_after` / `amount` 拓宽到 `numeric(20,4)`(防御纵深)。
    - 代码:`balance_before/after` 改存 **¥CNY**(`quotaToCny(rawQuota)`),与 `amount` 同单位;
      raw quota 只留在 `newapi_quota_added`(BigInt)。这两列纯审计、**全仓无任何读取/展示点**
      (`/balance` 只 select `amount/source/order_id/created_at`),改单位零功能影响。
- **修 B(idempotency)**:把流程拆成 intent → execute → confirm 三段:
    1. **intent(独立 tx,commit)**:CAS-claim 首充 bonus + INSERT placeholder `rechargeLog`
       (`newapi_quota_added=NULL` 作"未确认"哨兵)。commit 后 applyTopup 对同一 order 永不二次执行。
    2. **execute(HTTP,在任何 tx 之外)**:`applyTopup`。`NewApiError`(new-api 明确拒绝 →
       未入账)→ 删 placeholder + 撤 bonus claim + order FAILED → 重试干净重扣;
       非 NewApiError(网络/超时,入账结果未知)→ 留 placeholder + order FAILED → 重试走人工复核。
    3. **confirm(tx,commit)**:回填 placeholder(`newapi_quota_added` 落值 + balances 存 CNY)+
       order COMPLETED + commission + 缓存清零。
    - 重试去重:placeholder 已 `newapi_quota_added != NULL` → 幂等 finalize COMPLETED;
      `== NULL` → 结果未知 → order FAILED + `RECHARGE_NEEDS_REVIEW` 审计,**不自动重扣**。
    - 附带收益:applyTopup 移出 transaction,不再 ~10s 持 DB 连接(消解 W6 D5 F1)。

## 关键数据(diagnose 已做)

```
portal recharge_logs : 0 条 ❌(应有 1 条 ¥1000)
portal orders        : 1 条 paid_at != null 但 status=FAILED,
                       failed_reason 含 "Value out of range for the type: numeric field overflow"
new-api user.quota   : 1,013,055,912 raw(≈¥7,091 剩余)
new-api used_quota   : 872,658,369 raw(≈¥6,108 已耗)
合计                 : 1,885,714,281 raw ≈ ¥13,200(≈13×)
应给值               : ¥1,000 + 20% 首充 = ¥1,200
operator 决策         : 不动客户余额、不退款、只修 bug 防下一个客户
```
