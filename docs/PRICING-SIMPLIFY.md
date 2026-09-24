# 定价管理简化方案(2026-09-17)

> 目标:管理员只调两处(模型基础价、档次倍率)就能正确定价。扣费以 new-api 为准,Portal 目录与实际扣费保持一致。

## 1. 价格公式(唯一公式)

```
客户价(¥) = 基础价($) × USD_TO_CNY_RATE × 档次倍率 [× 客户专属倍率 ÷ 档次倍率]
```

生产环境 `USD_TO_CNY_RATE=1`,所以档次倍率可以直接读成「该档卖多少 ¥ 换基础价 $1」。

- **基础价**:每个上游模型一份,与档次无关。三种形态:
    - **按 Token**:输入、输出、缓存读、缓存写,单位 $/1M。
    - **阶梯**:按完整输入长度分档(如 `< 272000` 一档,以上一档),每档有输入/输出/缓存价,单位 $/1M。
    - **按次**:$/次,用于图片和视频。
- **档次倍率**:new-api 的 `GroupRatio[档次对应分组]`。
- **客户专属倍率**:new-api 的 `GroupGroupRatio`,沿用客户详情页现有功能,本方案不改。

不支持「某模型在某档单独定价」。确实需要不同价格时,新建分组或使用别名 SKU。

## 2. 写入 new-api 的映射

`CHAT_FX = 1M ÷ NEWAPI_QUOTA_PER_USD × USD_TO_CNY_RATE`,生产环境为 2。

| 形态     | 写入的 option                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 按 Token | `ModelRatio = 输入$ × FX ÷ CHAT_FX`、`CompletionRatio = 输出/输入`、`CacheRatio = 缓存读/输入`、`CreateCacheRatio = 缓存写/输入`;同时删除该模型的 `ModelPrice` 和阶梯配置 |
| 阶梯     | `billing_setting.billing_mode = tiered_expr`,`billing_setting.billing_expr = len < N ? tier(...) : tier(...)`(系数即基础价 $/1M);同时删除 `ModelPrice`                    |
| 按次     | `ModelPrice = 基础价$/次`;同时删除阶梯配置                                                                                                                                |
| 档次倍率 | `GroupRatio[分组]`;若 `group_ratio_setting.group_ratio` 中已有该分组,同步写入                                                                                             |

- 只写发生变化的 key。
- new-api 内置锁定输出倍率的模型(`CompletionRatioMeta.locked`):目标输出倍率与锁定值不一致时拒绝保存,提示改用阶梯形态。
- 缓存价留空,表示删除该模型的缓存倍率。此时 new-api 按默认规则计费。

## 3. 保存流程(同步执行,不走队列)

1. 在数据库事务内加定价互斥锁(`assertPricingCatalogWritable`)。有旧发布任务或分组删除任务时拒绝保存。
2. 读取 new-api 当前值,与页面打开时看到的值比对。不一致就要求刷新(乐观锁,替代旧的预览签名)。
3. 写入发生变化的 key。
4. 回读 option 逐项核对。不一致则报错,不更新 Portal 目录。
5. 写入 `CatalogPrice` 快照:每个受影响的模型 × 档次一行,供 `/pricing`、`/models`、`/v1/models` 展示。同时写 `AdminAuditLog` 历史。
6. 查询 new-api 运行视图 `/api/pricing`(可能有约 1 分钟缓存),报告「已生效」或「待刷新」,不阻断保存。

## 4. 页面(`/admin/pricing` 三个标签)

- **档次**:列出启用档次、new-api 分组、当前倍率、在用 Key 数、专属倍率客户数、模型数。修改倍率后先预览全部受影响模型的新旧价格,确认后保存。
- **模型**:每个模型一行,显示基础价形态和价格。编辑时可从 LiteLLM 官方价目录带入。先预览各档次新旧客户价,确认后保存。
- **价格总览**:模型 × 档次的只读矩阵,状态分三种:
    - 🔴 new-api 无价格
    - 🟡 Portal 目录与实际扣费不一致
    - 🟢 一致

    可以「按 new-api 现价重写目录」,只改展示,不改扣费。下方列出最近的定价操作历史。

## 5. 接口

- `GET /api/admin/pricing/simple`:一次返回档次、模型、总览和历史。
- `POST /api/admin/pricing/simple`,`action` 可选值:
    - `preview_tier` / `save_tier`
    - `preview_model` / `save_model`
    - `resync_catalog`
    - `verify_runtime`

## 6. 下线清单

以下内容下线:

- 旧定价页的 4 个工作台标签
- 异步发布队列、预览签名、目录指纹
- 成本规则与积分倍率
- `batch-cost`、`group-workbench`、`global-model`、`cost-rules`、`publish` 这几个接口

数据库表(`pricing_publish_jobs`、`pricing_cost_rules` 等)保留,只是不再写入。发布任务调度器保留,用于收尾已有任务。

## 7. 已知数据差异(需运营拍板,本方案不自动改价)

以下来自 2026-09-16 的生产审计:

- `claude-sonnet-5`:Portal 目录三档都是实际扣费的 1.5 倍。目录按输入 $3 计,new-api 实际为 $2。
- `gpt-5.6-sol` 企业档:目录 0.64,实际 0.8。
- `gpt-6-astra` 企业档:目录 12,实际 1.6。
- 分组 `GPT-特惠反代`:new-api 没有倍率,也未登记为档次。
- `Nano Banana 2`、`Nano Banana Pro`、`gpt-5.5-openai-compact`:没有 Portal 目录价格。

这些在「价格总览」里显示为 🟡 或 🔴:

- 目录类差异:用「按 new-api 现价重写目录」修正展示。
- 扣费类差异:在「模型」页修改基础价。
