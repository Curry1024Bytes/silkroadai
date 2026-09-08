# Seedream 5 Pro(渠道 166)现状核查报告

> 核查日期:2026-09-06(北京时间 22:30–22:50 实测)
> 范围:new-api 渠道 166 + `seedream 5 pro` 分组 + portal 档位 + 客户调用全链路 + 计费
> 结论一句话:**链路是通的、上游 key 活着,但它不是"适配器",只是一条直连透传渠道;上线一个月零客户流量;今天起档位已对客户可见,而定价还没配,按 new-api 未定价模型的兜底倍率在收费,2K 以上会明显高于火山官方牌价。**

---

## 1. 它到底是什么

| 项          | 实际情况                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| portal 代码 | **没有任何 seedream 专用代码**。全仓 `grep -i seedream` 只命中 `categorize.ts`(把 `seedream` 归到 ByteDance 厂商)和一条 proxy 测试用例(拿 `seedream-4.0` 当"非 gpt-image 模型"的示例名)。没有像 image2 / minimax / seedance 那样的 `src/lib/*-adapter`,也没有 `/xxx-adapter` 路由。                     |
| 调用路径    | 客户 → `ai.silkroadai.io/v1/images/generations` → portal 代理(server2 api-1..6)按"非 Gemini、非 gpt-image 模型"走 **JSON 原样透传** `forwardToNewApi` → new-api 渠道 166 → `https://ai.artsapi.com` → 火山方舟。响应经 `reshapeOpenAiImageResponse` 只做"显式传了的字段才回显",**不改写、不转存图片**。 |
| 所以        | 用户记忆里的"适配器"实际 = **一条 new-api 渠道 + 一个分组**,portal 侧零改动。这也是它在 CLAUDE.md、memory、PR 记录里都找不到的原因(没有 commit)。                                                                                                                                                       |

## 2. 渠道 166 配置(new-api,server2)

| 字段                           | 值                                                                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id / name                      | 166 / `seedream 5 pro`                                                                                                                                                                                                                  |
| type                           | 1(OpenAI 格式)                                                                                                                                                                                                                          |
| status                         | 1(启用)                                                                                                                                                                                                                                 |
| priority / weight              | 0 / 0                                                                                                                                                                                                                                   |
| base_url                       | `https://ai.artsapi.com`(前端是 tokensbyte 开源框架,CDN 头 `volc-dcdn`;与 seedance 海外线上游 SKU 前缀 `artsdance` 同名族,推测同一供应商)                                                                                               |
| key                            | `sk-339…d9b3`(51 字符)。**活的**:`GET /v1/models` 返 200,列表含 `doubao-seedream-5-0-pro-260628`,另有 `doubao-seedream-5-0-260128` / `4-5-251128` / `4-0-250828` / `jimeng_seedream46_cvtob` / `doubao-seedance-2-0-fast-260128` 等可选 |
| models                         | `doubao-seedream-5-0-pro-260628`(仅此一个)                                                                                                                                                                                              |
| group                          | `seedream 5 pro`                                                                                                                                                                                                                        |
| model_mapping / param_override | 空                                                                                                                                                                                                                                      |
| auto_ban                       | 1(连续失败会被 new-api 自动禁用;单渠道无 failover)                                                                                                                                                                                      |
| created_time                   | 2026-08-08 23:18(北京)                                                                                                                                                                                                                  |
| abilities                      | 1 行:`seedream 5 pro` × `doubao-seedream-5-0-pro-260628`,enabled                                                                                                                                                                        |

上游没有可读的余额 / 单价接口(`/api/pricing` `/api/status` `/dashboard/billing/*` 均 404 或返前端页),**上游成本单价与剩余额度只能登 artsapi 后台看**。

## 3. 分组与档位(三层都查了)

| 层                                                                | 状态                                                                                                          | 备注                                                                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| new-api `GroupRatio`                                              | ✅ 有,`"seedream 5 pro": 1`                                                                                   | 组倍率 1                                                                                                                                                                         |
| new-api `UserUsableGroups`                                        | ✅ 有,`"seedream 5 pro": "seedream 5 pro"`                                                                    | 无 `@` 前缀 = 对客户可见                                                                                                                                                         |
| new-api `group_ratio_setting` / `group_ratio_setting.group_ratio` | ❌ **都没有**                                                                                                 | 见 §6 P1:目前靠内存态放行,下次任何 PUT 这个 option 或重载后,该组会变 `403 分组 seedream 5 pro 已被弃用`(2026-06-30 同款事故)                                                     |
| portal `channel_groups`                                           | ✅ `key=seedream-5-pro`,display `seedream 5 pro`,enabled,非默认,tier_level 28(排最末),`newapi_channel_ids` 空 | **行创建时间 2026-09-06 22:20(北京)**= 今天由 `/keys` 的 UUG 自动同步生成 → 说明 UUG 里这条是今天才加的;从今天起所有未受 `allowed_tier_keys` 限制的客户在 `/keys` 都能选到这一档 |
| 客户 token / 用户                                                 | 0 个 token 绑定该组,0 个用户在该组                                                                            | 至今没有任何客户拿到过这一档的 key                                                                                                                                               |
| 公开页                                                            | `/models` 已列出 `doubao-seedream-5-0-pro-260628`(ByteDance 分组下);`/docs` 无 seedream 章节                  |                                                                                                                                                                                  |

## 4. 历史时间线(日志还原)

| 时间(北京)              | 事件                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-22              | 用户 112(分销)打 ch49 的 Gemini 生图报错文本里出现 `seedream`(上游支持列表),与本渠道无关                                                                                   |
| 2026-08-07 19:07        | 用户 112 请求 `seedream-4.0` / `seedream-3.0` → `No available channel`(**有客户在按短名找 seedream**)                                                                      |
| 2026-08-08 23:18        | 渠道 166 创建;第一次"测试"走了聊天端点 → 上游 400「模型为图片类型,不支持聊天接口」                                                                                         |
| 2026-08-08 23:19–23:20  | 改用图片端点测试成功,106 s 出图,计 153,600 quota(¥0.3072)                                                                                                                  |
| 2026-08-08 23:21        | 一条 `WARN non-200 from seedream 5 pro: 404 Not Found`(单行,无同 request-id 的其他记录,未复现)                                                                             |
| 2026-08-21              | operator 用 Postman 直打 artsapi 的这把 key 报错,当时 session 的处理是纠正 Postman 用法(URL 只留 `/v1/images/generations`、清掉残留 Params、body 用 raw JSON),渠道配置未动 |
| 2026-08-21 → 2026-09-06 | **零流量**(new-api `logs` 表全周期只有 08-08 那 1 条;server2 迁移后的日志里也没有任何 seedream 请求或 "No available channel" 记录;portal 六个 api 副本 7 天日志 0 命中)    |
| 2026-09-06 22:20        | portal 档位行自动生成(UUG 新增)                                                                                                                                            |
| 2026-09-06 22:35–22:46  | 本次核查 3 次实测(见 §5)                                                                                                                                                   |

## 5. 本次实测(全部通过)

| #   | 路径                                                                                                   | 参数                                   | 结果                                                       | 耗时   | 计费                                |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------- | ------ | ----------------------------------- |
| 1   | new-api 管理端渠道测试(`endpoint_type=image-generation`)                                               | 默认                                   | 200,返火山 TOS 图 URL                                      | 16 s   | 153,600 quota = ¥0.3072(记在 admin) |
| 2   | **客户真实路径** `ai.silkroadai.io/v1/images/generations`,test5(uid 768)临时 token,组 `seedream 5 pro` | `size=1024x1024`,`response_format=url` | 200,JPEG 1024×1024,219 KB;log 落 ch166 / 组 seedream 5 pro | 22.7 s | 153,638 quota = ¥0.3073             |
| 3   | 同上                                                                                                   | `size=2048x2048`                       | 200,JPEG 2048×2048,330 KB                                  | 30.8 s | 614,438 quota = ¥1.2289             |

- 注意:`endpoint_type=openai_image` 会被忽略而回落聊天端点(复现 08-08 的 400),正确值是 `image-generation`。
- 两把临时 token 已删除(id 2260 / 2261,软删);test5 消耗的 768,076 quota 已用 admin `add_quota` 回补,余额回到测试前的 3,296,199。
- 本次共消耗上游约 3 张图。

**响应形态**(原样透传给客户):

```json
{
    "model": "doubao-seedream-5-0-pro-260628",
    "created": 1788705888,
    "data": [
        {
            "url": "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/…?X-Tos-Expires=86400&…",
            "size": "1024x1024",
            "output_format": "jpeg"
        }
    ],
    "usage": { "input_images": 0, "generated_images": 1, "output_tokens": 4096, "total_tokens": 4096 },
    "size": "1024x1024"
}
```

- 图片 URL 是火山 TOS 签名链接,**24 小时过期**(`X-Tos-Expires=86400`),portal 不转存(只有 gpt-image 路径会转存到 R2 / 客户 OSS)。
- 响应头带 `x-new-api-version` / `x-oneapi-request-id`,和其他模型一致。

## 6. 计费现状(最需要处理的一项)

模型**没有配 ModelPrice / ModelRatio**(log `other.model_price=-1`,`model_ratio=37.5` 是 new-api 对未定价模型的兜底倍率),而且 `usage_billing_path=upstream`——**按上游返回的 `output_tokens` 计**,tokens = 宽×高 ÷ 256:

| 尺寸                               | 上游 output_tokens | 当前扣费(×37.5,组倍率 1;500k quota = ¥1) | 火山官方牌价(wcode.net 转载,需再核对) | 差异         |
| ---------------------------------- | ------------------ | ---------------------------------------- | ------------------------------------- | ------------ |
| 1024×1024(1.05 MP)                 | 4,096              | **¥0.31**                                | ¥0.36(≤2.36 MP 档)                    | 低于官方 15% |
| 2048×2048(4.2 MP,**模型默认尺寸**) | 16,384             | **¥1.23**(实测)                          | ¥0.72(>2.36 MP 档)                    | 高于官方 70% |
| 3072×3072(3K)                      | 36,864(推算)       | ¥2.76                                    | ¥0.72                                 | 3.8×         |
| 4096×4096(4K)                      | 65,536(推算)       | ¥4.92                                    | ¥0.72                                 | 6.8×         |

问题:

1. 客户不传 `size` 时模型默认 2048×2048,**每张 ¥1.23**,比官方贵 70%,上线即投诉风险。
2. 上游 artsapi 的成本价未知,当前毛利无法计算。
3. 37.5 是 new-api 兜底值,不是我们定的价;新版本或全局 ModelRatio 变动都会悄悄改变这个数字。

可选定价方案(供拍板,任选其一后再放量):

| 方案                             | 做法                                 | 1K / 2K / 4K 售价              |
| -------------------------------- | ------------------------------------ | ------------------------------ |
| A. 按张固定价                    | 给模型设 `ModelPrice`(每张),尺寸无关 | 例如统一 ¥0.72 / ¥0.72 / ¥0.72 |
| B. 按 token,锚定 2K = 官方 ¥0.72 | `ModelRatio ≈ 22`                    | ¥0.18 / ¥0.72 / ¥2.88          |
| C. 按 token,锚定 1K = 官方 ¥0.36 | `ModelRatio ≈ 44`                    | ¥0.36 / ¥1.44 / ¥5.76          |
| D. 维持现状                      | 不动                                 | ¥0.31 / ¥1.23 / ¥4.92          |

写法参考 `scripts/setup-image2-group.mjs`(merge 后 PUT `/api/option/`),改完必须用真实调用看 log `other.model_ratio` / `model_price` 验证(memory「GroupRatio 三键陷阱」同款流程)。

## 7. 待办清单(按优先级)

**P0 — 定价**:按 §6 选方案并落地,落地前建议先把档位从 `/keys` 隐藏(UUG 显示名加 `@` 前缀即可,portal 1 分钟内同步下架,不影响已有 key),避免客户在这期间按 ¥1.23/张 被扣。

**P1 — 分组三键补齐**:把 `"seedream 5 pro": 1` 同时写进 `group_ratio_setting` 和 `group_ratio_setting.group_ratio`(写之前先把 GroupRatio 里所有 key 镜像进去,否则会把其他靠内存态放行的组一起打成 403),然后 `docker restart new-api` + 真实调用验证。不做的后果:下次任何人 PUT 这个 option,该档所有 key 立刻 `403 分组已被弃用`,且这种 403 不落 `logs` 表,客户投诉前看不到。

**P1 — 图片 URL 24 h 过期**:要么在 `/docs` 明确告知客户"拿到 URL 立刻下载 / 传 `response_format=b64_json`",要么给这条路径加转存(复用 gpt-image 的 `storeGeneratedImage` 三级降级,需要改 proxy 代码 + 测试)。

**P2 — 文档与命名**:

- `/docs` 加 Seedream 章节:模型名、`size` 取值(`1K|2K|3K|4K|宽x高`,默认 2048²)、`response_format`、`watermark`(火山默认 true,会在右下角加"AI生成"字样,是否透传到 artsapi 未验证)、`output_format`、价格表。
- 8 月有客户按 `seedream-4.0` / `seedream-3.0` 短名调用被 503;如要放量,考虑给 `doubao-seedream-5-0-pro-260628` 配短名 alias(model_mapping + 同时写进 `channel.models`,gotcha #15)。
- `/models` 页显示名目前是原始 id,可考虑加友好名。

**P2 — 未验证项**:

- `/v1/images/edits`(图生图 / 参考图)没有测,透传 multipart 到 artsapi 是否被接受未知。
- 上游可用的其他 SKU(`doubao-seedream-5-0-260128` 非 pro 版、4.5、4.0)一个都没挂,如需低价档可直接加进 `channel.models`。
- 单渠道、priority 0、auto_ban=1:上游抖动几次就会被自动禁用,没有备胎;放量前至少关 auto_ban 或加一条备用渠道。

## 8. 快速核查命令(下次复查用)

```bash
# 渠道与分组
ssh vps2 'docker exec new-api-db psql -U newapi -d newapi -c "SELECT id,name,status,priority,base_url,models,\"group\" FROM channels WHERE id=166"'
ssh vps2 'docker exec new-api-db psql -U newapi -d newapi -c "SELECT key,(value ILIKE '"'"'%seedream 5 pro%'"'"') has FROM options WHERE key IN ('"'"'GroupRatio'"'"','"'"'group_ratio_setting'"'"','"'"'group_ratio_setting.group_ratio'"'"','"'"'UserUsableGroups'"'"')"'

# 流量与计费
ssh vps2 'docker exec new-api-db psql -U newapi -d newapi -c "SELECT to_timestamp(created_at) AT TIME ZONE '"'"'Asia/Shanghai'"'"' t,username,\"group\",quota,use_time,left(other,200) FROM logs WHERE channel_id=166 ORDER BY id DESC LIMIT 10"'

# 上游 key 是否还活着(不出图、不花钱)
ssh vps2 'K=$(docker exec new-api-db psql -U newapi -d newapi -tAc "SELECT key FROM channels WHERE id=166"); curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $K" https://ai.artsapi.com/v1/models'

# 出一张图的管理端测试(会花上游一张图的钱)
# GET /api/channel/test/166?model=doubao-seedream-5-0-pro-260628&endpoint_type=image-generation
```
