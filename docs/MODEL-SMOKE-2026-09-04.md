# 生产模型真实 Smoke（2026-09-04）

## 结论

本轮只通过公网 `https://api.llmroute.club` 和生产专用测试 Key 发请求，没有修改 Portal 代码、new-api
源码、渠道配置或模型价格。生产计费口径为：

- `NEWAPI_QUOTA_PER_USD=500000`
- `USD_TO_CNY_RATE=1`
- `REAL_USD_TO_CNY_RATE=7.2`（只用于美元展示）
- 因此 **500,000 quota = ¥1**，不能再用 7.2/7.3 把 quota 二次换算成人民币。

按 new-api 消费日志最终审计，本轮专用测试 Key 共写入 18 条消费日志，总扣费
`2,513,106 quota = ¥5.026212`。18 个日志 ID 和 Request ID 全部唯一；没有发现“同一个 Request ID
写两条消费日志”的重复计费。

## GPT-特惠反代（channel 6）

测试协议：`POST /v1/chat/completions`，compact 型号另补测 `POST /v1/responses`。

| 模型                     | 结果                   | 耗时 | quota | 备注                                                                                           |
| ------------------------ | ---------------------- | ---: | ----: | ---------------------------------------------------------------------------------------------- |
| `gpt-5.4`                | 通过                   |   4s |   145 | 返回 `OK`，1 条消费日志                                                                        |
| `gpt-5.4-openai-compact` | 失败                   | 1–2s |     0 | Chat 和 Responses 均 503                                                                       |
| `gpt-5.5`                | 通过                   |  27s |   101 | 返回 `OK`，1 条消费日志                                                                        |
| `gpt-5.5-openai-compact` | 失败                   |  <1s |     0 | 两种协议均提示无可用渠道                                                                       |
| `gpt-5.6-sol`            | 服务端通过、客户端超时 | 208s |   101 | 测试客户端 120s 断开后服务端仍完成并计费，Request ID `202609040138108157786908268d9d6CukifLgH` |
| `gpt-5.6-terra`          | 通过                   | 123s |   116 | 返回 `OK`，1 条消费日志                                                                        |
| `codex-auto-review`      | 通过                   |   5s |    18 | 返回 `OK`，1 条消费日志                                                                        |

部分成功响应回报约 4,391 个 prompt token，来自上游内部请求包装；new-api 实扣与消费日志一致，
不是 Portal 重复累加。

## Kimi（channel 10）

`kimi-k3` 路由和计费正常：

- `max_tokens=16` 时 16 个输出 token 被截断，`content` 为空，扣 490 quota。
- `max_tokens=128` 复测 6 秒返回 `OK`，`finish_reason=stop`，扣 1,205 quota。
- 两次是两个有意测试请求，各自只有一条消费日志；功能判定为通过。

## GPT-Pro20x 企业级（channel 5）

| 模型                     | 结果 | 耗时 | quota | 备注       |
| ------------------------ | ---- | ---: | ----: | ---------- |
| `gpt-5.4`                | 通过 |   5s |    84 | 返回 `OK`  |
| `gpt-5.4-openai-compact` | 失败 |  <1s |     0 | 503        |
| `gpt-5.5`                | 通过 |  17s |   484 | 返回 `OK`  |
| `gpt-5.5-openai-compact` | 失败 |  <1s |     0 | 无可用渠道 |
| `gpt-5.6-sol`            | 通过 |  22s |   169 | 返回 `OK`  |
| `gpt-5.6-terra`          | 通过 |   5s |   193 | 返回 `OK`  |

两个 compact 型号在 channel 5 和 channel 6 都失败，但仍出现在 `/v1/models`，属于模型清单与真实
可用性不一致。

## CCMax（channel 9）

普通 OpenAI/Anthropic curl 均返回 403“只允许 Claude Code 客户端”。随后按 Anthropic 官方 gateway
配置使用真实 Claude Code `2.1.260`，设置 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，以非交互
print mode 测试 `claude-haiku-4-5`。

真实客户端等待 195 秒并按自身退避策略多次重试，channel 9 每次都返回 503
`No available accounts: no available accounts`；最终 input/output token 均为 0，无消费日志、无扣费。
这是渠道账号池级故障，因此没有继续逐个撞另外 9 个 Claude 型号，不能把它们误报为单模型故障或已通过。

官方配置参考：

- <https://code.claude.com/docs/en/llm-gateway-connect>
- <https://code.claude.com/docs/en/cli-usage>

## 图片模型（channel 12）

| 模型                 | 结果 | 耗时 | 输出                   |       实扣 |   日志 |
| -------------------- | ---- | ---: | ---------------------- | ---------: | -----: |
| `gpt-image-2-1k`     | 通过 |  22s | 1024×1024 PNG          |      ¥1.00 |      1 |
| `gpt-image-2-2k`     | 通过 |  42s | 2048×2048 PNG          |      ¥1.50 |      1 |
| `gpt-image-2-4k`     | 通过 |  34s | 3840×2160 PNG          |      ¥2.00 |      1 |
| `gpt-image-2-cf`     | 通过 |  30s | 1254×1254 PNG          |      ¥0.12 |      1 |
| `grok-imagine-image` | 通过 |   8s | 1 个 URL               |      ¥0.16 |      1 |
| `Nano Banana 2`      | 失败 | 601s | 无                     |         ¥0 |      0 |
| `Nano Banana Pro`    | 异常 |  29s | HTTP 200，但 `data=[]` | ¥0.12/请求 | 1/请求 |

关键事实：

- 三个固定分辨率 SKU 的实际尺寸和价格与 Portal `CatalogPrice`（¥1/¥1.5/¥2）逐项一致。
- `gpt-image-2-cf` 的本轮 Request ID 为 `202609040234266414110378268d9d6AuHPhCxH`，只写入日志
  `17925` 一条并扣 ¥0.12，未复现单请求重复扣费。
- `Nano Banana 2` 的 channel 12 上游单次 300 秒超时，new-api 重试同一渠道一次，总计约 10 分钟
  后 503；无消费日志和扣费。
- `Nano Banana Pro` 返回 HTTP 200 且扣费，但标准 Images `data` 为空，客户拿不到图片，不能判通过。
- `Nano Banana Pro` 在最终账单中有两条不同 Request ID：第一条是批次脚本在 `Nano Banana 2` 超时后、
  操作员中断前已经启动的请求（日志 `17924`，¥0.12）；第二条是显式单项复测（日志 `17927`，¥0.12）。
  两条是两个真实请求，不是同一请求重复记账；第一条客户端已断开但服务端仍完成并计费。
- 目前只有三个固定分辨率 SKU 写有 Portal `CatalogPrice`。另外四个模型只在 new-api `ModelPrice`
  中有价格（乘图片组 `GroupRatio=0.2` 后分别为 ¥0.10/¥0.12/¥0.12/¥0.16），因此会出现在
  `/v1/models` 并可扣费，却不会出现在 Portal 公开价格页。

## 上线判定与后续动作

### 可继续对客户开放

- `kimi-k3`（需要给推理输出留足 token）
- GPT 基础型号：`gpt-5.4`、`gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`
- `codex-auto-review`
- `gpt-image-2-1k`、`gpt-image-2-2k`、`gpt-image-2-4k`、`gpt-image-2-cf`
- `grok-imagine-image`

### 应先下架或修好再开放

1. 两个 `*-openai-compact`：模型清单仍宣传，但两个 GPT 渠道都不可用。
2. CCMax 全档：真实 Claude Code 已满足协议限制，但账号池无可用账号。
3. `Nano Banana 2`：单请求会占用约 10 分钟后 503。
4. `Nano Banana Pro`：200 空图片仍扣费；至少应在渠道恢复前下架，不能只把空 `data` 归一成成功。

### 必须保留的运行规则

- 对模型测试按 Request ID 查账；“两条日志”只有 Request ID 相同才可能是重复计费。
- 客户端超时/断开不代表服务端取消。`gpt-5.6-sol` 和第一条 `Nano Banana Pro` 都证明服务端可能继续
  完成并扣费；测试脚本不能在超时后自动进入下一个收费请求。
- 生产人民币换算必须读取 `USD_TO_CNY_RATE`，当前值为 1；`REAL_USD_TO_CNY_RATE` 不能用于余额扣费换算。
