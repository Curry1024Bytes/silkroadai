# SD特惠视频验收记录

2026 年 11 月 21 日，北京时间。通过 `api.llmroute.club` 的「SD特惠」Key 提交、查询和下载。对客文档入口为 `/docs#sd-special-video` 和 `/workspace/docs#sd-special-video`。

## 费用与覆盖

- 本轮上游采购预算 ¥50。充值后钱包基线 ¥55.00。31 个按秒型号按当前配置的最短时长各生成一次，预计 ¥45.64；统一跑 5 秒预计 ¥55.225。
- 渠道 21 和分组能力接口均列出 31 个型号。31 条按秒公式与上游模型卡的价格字段一致。`sd-2.5-720P-限时特价` 的上游描述显示 ¥0.68/秒，价格字段显示 ¥0.72/秒，4 秒成片两边均实扣 ¥2.88，实际单价为 ¥0.72/秒。
- 测试 Key 的 `GET /v1/models` 返回空数组。显式传入相应模型 ID 可以提交，客户可从模型广场或对客文档复制 ID。
- 账单单位为人民币，生产换算为 500000 quota = ¥1。客户侧按任务、消费日志和余额核对，上游按任务账单的最终实扣核对。视频时长取视频轨，费用按真实账单记录。

## 出片与账单

已验证 31/31 个型号。客户与上游实扣各 ¥45.64。采购预算剩余 ¥4.36，上游钱包实查余额 ¥9.36。

| 模型 ID                    | 场景                   | 请求秒数 | 成片规格            | 客户实扣 | 上游实扣 | 客户任务 ID                             |
| -------------------------- | ---------------------- | -------: | ------------------- | -------: | -------: | --------------------------------------- |
| `sd-2-mini-480`            | 480p 文生              |        5 | 864×496，5.042 秒   |    ¥0.40 |    ¥0.40 | `task_x0ADvVSyYWmKqfywMpAhgPF8Pventbz1` |
| `sd-2-mini-480-novideo`    | 480p 文生              |        4 | 864×496，4.042 秒   |    ¥0.40 |    ¥0.40 | `task_UJStTZDO95jJ7gLpb2ZwA3hqkkF2Wz0l` |
| `sd-2-mini-720`            | 720p 普通参考图        |        4 | 1280×720，4.042 秒  |    ¥0.48 |    ¥0.48 | `task_g1mEi92kUfvH8yHVngWclP8FQPS9TcqL` |
| `sd-2.5-1080P`             | 文生 1080p             |        4 | 1920×1080，4.042 秒 |    ¥3.52 |    ¥3.52 | `task_ItCi4yp5bjIasNjAHkII3FhpSvpy3Ruv` |
| `sd-2.5-720P`              | 参考视频               |        4 | 1280×720，4.042 秒  |   ¥1.592 |   ¥1.592 | `task_V13tEV4eCSgl0ZdHlRQmotcZvlmAYRFs` |
| `sd-2.5-flash-480P`        | 参考音频               |        4 | 854×480，4.042 秒   |     ¥0.8 |    ¥0.80 | `task_bS8N5tVZmWmqLjkIJ1zGYiXaMIJjfAbm` |
| `sd-2-vip-480`             | 图／视频／音频混合参考 |        4 | 864×496，4.042 秒   |     ¥0.8 |    ¥0.80 | `task_etxfomJn3ZwtMpMVIMIYnwWD4IoluZRv` |
| `sd-2-fast-480`            | 文生                   |        4 | 864×496，4.042 秒   |     ¥0.6 |    ¥0.60 | `task_25NhEZjerUcWlYbYOR146mF8Y2xOWyVb` |
| `sd-2-fast-720`            | 文生                   |        4 | 1280×720，4.042 秒  |     ¥0.8 |    ¥0.80 | `task_osx3wP8TuRmosdrS1SocBnhoi8hJXDuf` |
| `sd-2.5-480P`              | 文生                   |        4 | 854×480，4.042 秒   |   ¥1.192 |   ¥1.192 | `task_dUGMCPKKnWfO27Z4YecHcGiQN7gagw0v` |
| `sd-2-fast-480-novideo`    | 文生                   |        4 | 864×496，4.042 秒   |    ¥0.44 |    ¥0.44 | `task_F0fbbucmjXeVkeepK7naooBFZQvwUAXH` |
| `sd-2.5-480P-novideo`      | 文生                   |        4 | 854×480，4.042 秒   |   ¥0.944 |   ¥0.944 | `task_0h0UxnFAqCMrPWMb2j85luiOIquxMJ7v` |
| `sd-2-vip-720`             | 文生                   |        5 | 1280×720，5.042 秒  |     ¥1.2 |    ¥1.20 | `task_Bc2DpA3DITfkESIoE9Y8HlgadCZqPJ5d` |
| `sd-2.5-flash-720P`        | 文生                   |        4 | 1280×720，4.042 秒  |     ¥1.2 |    ¥1.20 | `task_z3vwzuZo3iJJdy9XehPnkPNKWpj6vn22` |
| `sd-2-mini-720-novideo`    | 文生                   |        4 | 1280×720，4.042 秒  |     ¥0.4 |    ¥0.40 | `task_8jVSruYIfmgx5mDyahLXQwR3jP88otpm` |
| `sd-2-fast-720-novideo`    | 文生                   |        4 | 1280×720，4.042 秒  |    ¥0.64 |    ¥0.64 | `task_E97EhQAPERSOkg1GhdmvduyzZ87ZD9cM` |
| `sd-2-vip-480-novideo`     | 文生                   |        4 | 864×496，4.042 秒   |    ¥0.74 |    ¥0.74 | `task_m5El5gytsJIqZmk7HGz4DoJbQgvBv61e` |
| `sd-2-vip-720-novideo`     | 文生                   |        4 | 1280×720，4.042 秒  |    ¥0.88 |    ¥0.88 | `task_AUBB7fLrZHW2vwHi3w2dFVXA0QWvaH5Q` |
| `sd-2.5-720P-novideo`      | 文生                   |        4 | 1280×720，4.042 秒  |    ¥1.38 |    ¥1.38 | `task_9mpwymXc39w9aIUtXVEOfWmCZ56ilNVC` |
| `sd-2.5-flash-480-novideo` | 文生                   |        4 | 854×480，4.042 秒   |     ¥0.9 |    ¥0.90 | `task_Bq1qrgw3wgpZx9jjXMZ3wd7kCxibZWCe` |
| `sd-2.5-flash-720-novideo` | 文生                   |        4 | 1280×720，4.042 秒  |   ¥1.072 |   ¥1.072 | `task_ZotjdvxN0MmYGiN1BP8ToU2QRU1iMev4` |
| `sd-2.0-官方版-720p`       | 文生                   |        4 | 1280×720，4.042 秒  |     ¥3.4 |    ¥3.40 | `task_Ga2zBdBubZDsaWeQcmxRQ5OZi1uOfcsO` |
| `sd-2.0-fast-官方版-480p`  | 文生                   |        5 | 864×496，5.042 秒   |     ¥2.1 |    ¥2.10 | `task_vPc7stSDUItZe6rlF7kZYpNVK4Wd9yuZ` |
| `sd-2.0-fast-官方版-720p`  | 文生                   |        5 | 1280×720，5.042 秒  |     ¥3.6 |    ¥3.60 | `task_Up5jPGZNnDCW482FDpMUWjQ1sja20ZrX` |
| `sd-2.0-mini-官方版-480p`  | 文生                   |        4 | 864×496，4.042 秒   |    ¥0.88 |    ¥0.88 | `task_eHWLJMsGOBm9lS07oDso3laS4u273BJy` |
| `sd-2.0-mini-官方版-720p`  | 文生                   |        4 | 1280×720，4.042 秒  |    ¥1.28 |    ¥1.28 | `task_yrE84WCUCfLvGvqJknKOdzl5NqDYzNeL` |
| `sd-2.5-官方版-720p`       | 文生                   |        4 | 1280×720，4.042 秒  |     ¥4.4 |    ¥4.40 | `task_V0gqwL0vx9GPLP6XxF0NXS08jb37GSN9` |
| `sd-2.5-480P-限时特价`     | 文生                   |        4 | 854×480，4.042 秒   |    ¥1.76 |    ¥1.76 | `task_zJBsWffdlcIMVvkivdEUN54OFXlhCnvl` |
| `sd-2.5-720P-限时特价`     | 文生                   |        4 | 1280×720，4.042 秒  |    ¥2.88 |    ¥2.88 | `task_9LXVUqfyFz2ADmBFuKP4libEknaQv37W` |
| `sd-2.0-官方版-480p`       | 文生                   |        4 | 864×496，4.042 秒   |    ¥2.48 |    ¥2.48 | `task_VM5S3V9RNM6cb268CILykPcLEs1GuzQV` |
| `sd-2.5-官方版-480p`       | 普通参考图             |        4 | 854×480，4.042 秒   |    ¥2.48 |    ¥2.48 | `task_2BPvashH7zgmniQVmGUZGSIxoDRg0y4X` |

以上任务均返回 `completed`，`/content` 返回 HTTP 200 和 `video/mp4`。31 份成片均通过媒体检查。另有 2 个已受理任务进入 `failed` 并结算为 ¥0。

## 参数拒绝与退款

| 型号                    | 场景                                                | 实测结果                                                                                                                                           |
| ----------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sd-2-mini-480-novideo` | 输入参考视频                                        | HTTP 400，未创建任务，客户额度和请求数无变化                                                                                                       |
| `sd-2-mini-720`         | 传入 480p、请求 3 秒、混传 `references` 和 `images` | 三个独立请求均返回 HTTP 400，客户额度和请求数无变化                                                                                                |
| `sd-2-mini-720`         | 参考图地址返回 HTTP 404                             | 任务 `task_82Gu6aZmGfOEwo8fSaUu65Lwgco7Rn8E` 进入 `failed`。两边各预扣 ¥0.48，客户额度恢复，上游任务账单显示 ¥0.00、已退款。更换可访问的素材后出片 |
| `sd-2-fast-480`         | 仅使用 `first_frame`                                | 上游返回 HTTP 400，说明该型号不支持 `first_frame` 模式。未创建任务，客户实扣 ¥0                                                                    |
| `sd-2.5-480P`           | 同时使用 `first_frame` 和 `last_frame`              | 上游返回 HTTP 400，说明该型号不支持 `first_last_frame` 模式。未创建任务，客户实扣 ¥0                                                               |
| `sd-2-fast-480-novideo` | 仅使用 `first_frame`                                | 上游返回 HTTP 400，说明该型号不支持 `first_frame` 模式。未创建任务，客户实扣 ¥0                                                                    |
| `sd-2.5-480P-novideo`   | 同时使用 `first_frame` 和 `last_frame`              | 上游返回 HTTP 400，说明该型号不支持 `first_last_frame` 模式。未创建任务，客户实扣 ¥0                                                               |
| `sd-2.0-官方版-480p`    | 仅使用 `first_frame`                                | 上游返回 HTTP 400，说明该型号不支持 `first_frame` 模式。未创建任务，客户实扣 ¥0                                                                    |
| `sd-2.5-官方版-480p`    | 同时使用 `first_frame` 和 `last_frame`              | 任务 `task_WCl4yAlYALhELDUfHFC3fCR5iQZoHRZX` 进入 `failed`，上游说明此型号只支持普通多素材参考。客户预扣 ¥2.48 已退回，上游账单实扣 ¥0             |

提交响应不明确时，先按请求时间、请求 ID 和任务日志确认是否已受理。查询或下载失败时继续核对原任务。生成成功与成片可下载分别验收。

## 收尾

测试 Key 已撤销，公网鉴权复查返回 HTTP 401。两个测试账号的剩余额度均为 0，已回收其中 ¥1 的未使用测试额度。对客文档在本地工作区完成，渲染测试 36 项、类型检查、定向 ESLint 和格式检查通过。
