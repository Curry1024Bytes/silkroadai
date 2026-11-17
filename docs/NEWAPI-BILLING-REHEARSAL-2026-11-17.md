# new-api 官方 rc.51 计费离线演练（2026-11-17）

## 结论

- 四条现有视频表达式在相同、有效的 usage facts 下，旧版与官方 rc.51 的计算结果一致。176 组直接 usage 向量全部一致，并通过独立费率与 Decimal 舍入公式核对。
- 官方视频插件增加模型能力约束和按模型上限预扣，不能把“表达式不变”等同于“所有请求的预扣不变”。不支持的分辨率会被拒绝；缺省时长或分辨率的部分预扣会增加。
- 活动模型 `gpt-6-astra` 当前依赖内置表达式。官方区分 `cc12h` 并按旧短缓存写入单价的两倍计价，直接替换镜像会改变现行价格。即使原样复制旧表达式，官方归一化仍会将未单列的 12h 写入按两倍合入 `cc`，不能保价。
- 显式用 `(cc + cc12h)` 沿用旧单价可保留旧计费行为：120 组同一 `dto.Usage` JSON 经两版原始归一化、表达式、quota 转换后，cost、quota、tier 全部一致；官方内置和原样旧表达式均有 72/120 组 quota 变化。
- 官方缺少 fork 专用的分组用户倍率查询接口，Portal 需要显式 `NEWAPI_DISTRIBUTION=official` 能力配置。候选兼容已由主任务另行实现，不能吞掉 fork 模式下任意 404。

本报告记录无收费演练、代码审阅及主任务后续提供的克隆验收结果。报告作者未修改生产或克隆数据库，未创建 PAT，未调用模型生成接口；克隆中的安装、恢复与在线契约验证由主任务执行，结果补充于文末。生产切换仍由主任务负责。

## 数据与方法

配置读取自隔离克隆 `newapi-rc51-rehearsal-pg`；活动目录和报价读取自 Portal 克隆 `newapi-rc51-rehearsal-portal-pg`。读取限于计费 options、channels 和模型价格，未输出凭据。查询 Portal 表结构时另做过生产 `information_schema.columns` 只读查询。

旧版使用 `new-api-custom-full` 的计费源码，对照生产 SHA `8c02661`：`plugins/tasks/doubao/plugin.js`、`pkg/billingexpr`、`common/quota_math.go`、`service/tiered_settle.go`、`relaykit/dto/openai_response.go`、内置表达式无差异；`GetBillingMode()` 访问器也逐字一致。该源码目录的其他部分有后续改动，未把整个 HEAD 当作生产版本。

官方使用下载的 `v1.0.0-rc.51` 源码。离线 harness 原文使用两版 `pkg/billingexpr` 非测试 Go 文件和 `common/quota_math.go`；归一化 harness 另原文使用两版 DTO 声明、`CacheCreationTokensTotal()` 和 `BuildTieredTokenParams()`，官方增加其原始缓存归一化实现。日志、未使用的 `BillingUsage` 类型及 `MaxImageN` 仅提供编译 stub；12h 倍率常数按官方原值 2。

视频用两版原始插件的 `native.createTask()`、`buildSubmitRequest()`、`extractUsage()` 产生 facts，再交给各自原始表达式引擎。所有 URL 为 `fixture.invalid`，Key 为离线占位值；未发送网络请求。

复现材料在本机临时目录 `/tmp/newapi-billing-harness/`：

- `generate.mjs`、`fixtures.json`、`old-cases.jsonl`、`official-cases.jsonl` 与两版 results。
- `summary.json`、`independent-assertions.json`。
- `prepare_normalization.py`、`check_normalization.py`、`normalization-summary.json`、`normalization-examples.json`。
- `preserve-astra-expression.txt` 与 `old-normalizer`、`official-normalizer`。

这些是本次执行证据，未作为永久测试套件提交。临时目录清除后不能仅凭本报告重跑二进制；公式、矩阵和源码入口已记录如下。

## 克隆中的现行视频配置

`billing_setting.billing_mode` 与 `billing_setting.billing_expr` 都仅有下列四条模型；模式均为 `tiered_expr`，`billing_setting.plugin_billing_expr` 为空。单价单位为每百万 usage tokens，`none/video` 分别表示无视频输入/有视频输入。

| 模型                              | 480p none/video | 720p none/video | 1080p none/video | 4k none/video |
| --------------------------------- | --------------: | --------------: | ---------------: | ------------: |
| `doubao-seedance-2-0-260128`      |       4.6 / 2.8 |       4.6 / 2.8 |        5.1 / 3.1 |     2.6 / 1.6 |
| `doubao-seedance-2-0-fast-260128` |       3.7 / 2.2 |       3.7 / 2.2 |            0 / 0 |         0 / 0 |
| `doubao-seedance-2-0-mini-260615` |       2.3 / 1.4 |       2.3 / 1.4 |            0 / 0 |         0 / 0 |
| `doubao-seedance-2-5-260628`      |         7 / 4.2 |         7 / 4.2 |        7.7 / 4.6 |         0 / 0 |

`GroupRatio` 中 `SD官转=7.5`，`GPT特惠-不降智=0.09`。两版 `QuotaPerUnit=500000`，无数据库覆盖。

视频表达式的 `cost = tokens × 单价 / 1000000`，quota 按 `cost × 500000 × GroupRatio` 舍入。独立断言使用 Decimal、半远离零舍入及原始 int32 上限验证。

## 视频矩阵与结果

矩阵为 4 模型 × 5 分辨率（480p/720p/1080p/4k/缺省）× 8 时长（1/5/10/12/15/30/缺省/-1）× 2 输入类型，共 320 组。

| 检查                         | 结果                                  | 边界                                                                         |
| ---------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| 显式正时长、显式受支持分辨率 | 132/132 usage、cost、tier、quota 一致 | 其中 116 组在模型最大时长内；16 组仅验证超出时长后的离线算术，不代表上游接受 |
| 官方不支持的分辨率           | 80/80 拒绝                            | 旧版均接受，包括零价分支                                                     |
| 缺省分辨率或缺省/-1 时长     | 108 组中 48 组 facts 改变             | 与官方各模型 profile 的上限有关                                              |
| 直接给定 usage facts         | 176/176 两版一致                      | 含 0、1、1000000、1000000000 tokens 与倍率 1/7.5                             |
| 独立公式核对                 | 两版各 176/176 通过                   | 各有 29 项为预期 int32 饱和，不可当普通价格样本                              |

所有有效视频表达式均无 compile/runtime 错误。旧版唯一错误来自故意验证 `cc12h` 支持的合成表达式，该变量在旧引擎不存在，与生产视频表达式无关。

5 秒、480p、`GroupRatio=7.5` 的 quota：

| 模型     | 无视频输入，旧版=官方 | 有视频输入，旧版=官方 |
| -------- | --------------------: | --------------------: |
| 2.0 full |                828647 |                504394 |
| 2.0 fast |                666520 |                396309 |
| 2.0 mini |                414323 |                252197 |
| 2.5      |               1260984 |                756591 |

两版显式参数使用同一估算公式：`seconds × width × height × 24 / 1024`。这里的 token 是预扣估算，不能代替最终上游 usage。

### 缺省参数的预扣变化

以下请求同时省略分辨率和时长、无视频输入，倍率 7.5：

| 模型     | 旧版预扣 facts                | 官方预扣 facts                 |     quota 旧 → 官方 |
| -------- | ----------------------------- | ------------------------------ | ------------------: |
| 2.0 full | 15 秒 / 1080p / 729000 tokens | 相同                           | 13942125 → 13942125 |
| 2.0 fast | 15 秒 / 1080p / 729000 tokens | 15 秒 / 720p / 324000 tokens   |         0 → 4495500 |
| 2.0 mini | 15 秒 / 1080p / 729000 tokens | 15 秒 / 720p / 324000 tokens   |         0 → 2794500 |
| 2.5      | 15 秒 / 1080p / 729000 tokens | 30 秒 / 1080p / 1458000 tokens | 21049875 → 42099750 |

官方 profile：full 最长 15 秒、480p/720p/1080p/4k；fast/mini 最长 15 秒、仅 480p/720p；2.5 最长 30 秒、480p/720p/1080p。fast/mini 旧预扣选到表达式零价分支，官方修正为有效分辨率。

官方 `extractUsageOnComplete()` 优先有效正数 `completion_tokens`，再取 `total_tokens`，并可覆盖实际受支持分辨率。因此上表是预扣变化，不能据此认定最终扣款翻倍。若实际响应没有有效 usage，不能保证估算被覆盖；真实终态行为尚未做收费验收。

任务状态还有协议差异：旧版接受 `pending`/`processing`，官方该插件返回 `UNKNOWN`；`queued`/`running` 与成功失败终态一致。真实供应商当前使用的状态词未在本次离线演练中确认。

## Astra 活动报价与 12h 写入兼容

克隆 new-api 的 channel 2、15、16、18 均为启用的 type 1，声明 `gpt-6-astra` 且映射同名。`ModelRatio`、`ModelPrice`、`ImageResolutionPrice`、`billing_setting.task_billing_pricing`、显式 billing mode 和 expression 中均没有该模型，因此原配置使用内置表达式。

Portal 的 `gpt-6-astra` 为 enabled、未 archived；当前 `upstream_map` 仅为 `gpt-7d591d9dfa → channel 2 / gpt-6-astra`。该 live tier 最新有效价格时间为 `2026-11-17T03:17:54.089Z`，单位为人民币/百万 tokens：

| 上下文  | 输入 | 输出 | 缓存读取 | 缓存写入 |
| ------- | ---: | ---: | -------: | -------: |
| ≤272000 |  0.9 |  4.5 |     0.09 |    1.125 |
| >272000 |  1.8 | 6.75 |     0.18 |     2.25 |

这些值与旧 builtin 原始费率乘 group 0.09 一致，无独立 12h 报价、无当前 request multiplier。其他历史 tier 价格仍有行，但未在当前 upstream_map 中，不能当活动报价使用。

旧 builtin 对短/长缓存写入统一使用 `cc*12.5` 或 `cc*25`。官方 builtin 将 `cc12h` 单列为 25 或 50；若表达式不引用 `cc12h`，官方归一化也会将该计数乘 2 合入 `cc`。兼容时必须显式引用两个变量，以旧费率相加：

```text
len <= 272000 ? tier("standard", p * 10 + c * 50 + cr * 1 + (cc + cc12h) * 12.5) : tier("long_context", p * 20 + c * 75 + cr * 2 + (cc + cc12h) * 25)
```

在 `billing_setting.billing_expr` 中只合并这一个模型 entry，并显式合并 `billing_setting.billing_mode["gpt-6-astra"]="tiered_expr"`。四条现有视频表达式应保持原样。该配置用于保持现行价格，不涉及修改官方源码。

同一 `dto.Usage` JSON 矩阵：prompt `[0,272000,272001,1000000]` ×（短/12h 写入）`[(0,0),(1000,0),(0,1000),(3000,4000),(0,300000)]` × 两种旧版已识别 alias `cache_write_tokens/cached_creation_tokens` × group `[0.09,1,7.5]`，共 120 组；completion 固定 500、cached read 固定 400。

| 官方模式                                 | 与旧版比较                                                |
| ---------------------------------------- | --------------------------------------------------------- |
| 官方 builtin                             | 72/120 quota 变化                                         |
| 原样照抄旧表达式                         | 72/120 quota 变化                                         |
| 同时显式引用 `(cc + cc12h)` 的保价表达式 | 120/120 cost、quota、tier 一致，独立 Decimal 公式全部通过 |

同 wire 示例：prompt 272000、completion 500、cache read 400、cache write 1000，1000 个写入全部为 12h，group 0.09：

| 结果        |          旧版 | 官方 builtin | 官方保价 |
| ----------- | ------------: | -----------: | -------: |
| p           |        270600 |       270600 |   270600 |
| cc / cc12h  | 1000 / 不存在 |     0 / 1000 | 0 / 1000 |
| 表达式 cost |       2743900 |      2756400 |  2743900 |
| quota       |        123476 |       124038 |   123476 |

prompt 改为 272001、其余不变时，旧版/官方 builtin/官方保价 quota 分别为 246389/247514/246389，长上下文分支也匹配。

`deploy/newapi-official/pricing_compat.py` 的 `EXPRESSION` 已与上述实际 120 向量候选逐字比较，完全一致；`tiered_expr` 与官方枚举一致。SQL 审阅确认同一事务锁定两条 options 字典，以 JSONB `||` 仅合并 Astra entry，保留四视频 entry；已有不同 Astra override 会拒绝。本节离线检查确认常量和 SQL 语义，当时尚未执行数据库安装；后续主任务的克隆安装验收见文末。

验证范围止于内部 DTO JSON 解码 → 原始归一化 → 表达式 → quota。未覆盖完整 HTTP `/responses` 协议解码、真实上游、流式/断线时序；官方新识别的 `cache_creation_input_tokens` alias 不属于旧版已识别输入，本次 120 项未覆盖它，不能声称所有新增 alias 都与旧版计费等价。

## fork-only 分组用户倍率接口

官方 `/api/group/` 仅提供分组列表，没有 fork 的 `/api/group/:group/user-ratios`。Portal `listGroupUserRatios()` 的调用者是 `src/lib/pricing-rules/resolve.ts` 的 `checkUserOverrides()`；原逻辑访问官方会失败，给成员添加 `group_check_failed` 并 hold，影响后续售卖规则或客户折扣发布。

候选修复采用显式发行版能力：`NEWAPI_DISTRIBUTION=official` 时返回空覆盖列表；默认 `fork` 继续请求专用接口并 fail closed；无效配置报错。不能通过捕获所有 404 来“兼容”，否则会掩盖 fork 服务或路径配置故障。

候选实现与 `official-client-contract.test.ts` 由主任务负责。本报告作者只审阅调用关系，未运行这部分测试；完整验证结果以主任务报告为准。

## 主任务后续验收状态

1. **克隆与生产均已安装并读回确认**：Astra 使用保价表达式与显式 `tiered_expr`，五条表达式齐全，四条视频原值保留。生产最终审计核对两条 options 与其余配置不变量，未重新定价。
2. **生产兼容验收通过**：20 客户和 1 管理员已迁移 scoped PAT，客户 60 次读取、20 次管理接口拒绝及管理员 6 次读取通过。Portal 84 项 HTTP 检查通过，临时 Key 已清理且零用量；生产已设置 `NEWAPI_DISTRIBUTION=official`。完整证据见[迁移报告](NEWAPI-OFFICIAL-MIGRATION-2026-11-17.md)，不能仅以版本接口成功替代这些检查。
3. **克隆与生产渠道迁移已完成**：channel 13 的 type 65 转为官方 type 61，模型映射、其余渠道和历史任务保留；克隆侧 capability、模型映射和任务兼容检查通过。该结果不代表真实供应商生成及最终结算已验收。
4. **双库回滚演练已通过**：主任务在隔离环境恢复 new-api 与 Portal 两库；第二次回滚克隆还将 Portal dump 的 `users` COPY 数据与恢复后重新 `pg_dump` 的数据逐行比较，25 条记录完全相同，包含旧凭据。证据为 VPS 迁移任务目录内的 `rollback-rehearsal/credential-restore.json`；未将凭据写入本报告。
5. **生产已放流**：2026-11-17 19:07:12（北京时间），官方 `v1.0.0-rc.51` 与兼容 Portal 恢复公网。最终 7 张 new-api / 21 张 Portal 保护表审计通过，原客户余额、现行价格和既有 Key 保留；公网 curl 19 项通过。本次生产及隔离验收均未发起收费推理。
6. **仍待真实链路验收**：真实供应商 status、终态 usage、无 usage fallback 及最终客户账单。本次无收费演练不能替代这些检查。
