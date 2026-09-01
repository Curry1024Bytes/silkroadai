# 【变更通知稿】图片 API 错误码统一(合并后待发布)— 待 operator 发送

> 当前仅为 dev 合并后的通知草稿；必须完成 dev 验证、prod 发布和真实链路验收后，才能对客户发送。

> 发送对象:image2 线大客户(c-70fd7c5f / c-ff22024e / c-99e5e065 / c-255b9112 / c-5ba310b1 / c-0277013d 等,建议全量);渠道:微信/邮件。以下为可直接粘贴的正文。

---

尊敬的客户:

为解决图片接口(gpt-image-2,`/v1/images/generations` 与 `/v1/images/edits`)报错码不统一的问题,平台计划在本次变更发布后将错误响应**完全对齐 OpenAI 官方契约**。要点如下:

**1. 错误体统一为官方四字段形**

```json
{ "error": { "message": "...", "type": "...", "param": null, "code": "..." } }
```

程序请按 **HTTP 状态码 + `error.code`** 分支;`message` 仅供人读。官方 openai SDK(Python / Node)的异常分类开箱即用。

**2. 状态码与 code 对照表(新契约)**

| HTTP | error.code                                            | 含义                                 | 建议处理                            |
| ---- | ----------------------------------------------------- | ------------------------------------ | ----------------------------------- |
| 400  | `moderation_blocked`                                  | 内容安全审核拒绝                     | 改写提示词/更换素材,原样重发无效    |
| 400  | `invalid_image` / `invalid_value` / `invalid_request` | 参考图损坏 / 尺寸参数非法 / 请求错误 | 按 `param` 与 message 修正请求      |
| 401  | `invalid_api_key`                                     | key 无效或禁用                       | 检查 key                            |
| 429  | `insufficient_quota`                                  | 余额不足                             | 充值后重试                          |
| 429  | `rate_limit_exceeded`                                 | 限流/并发排队                        | 按响应头 `Retry-After` 秒数退避重发 |
| 500  | (无 code,type `server_error`)                         | 平台/上游临时错误                    | 直接重试                            |
| 503  | (无 code,type `server_error`)                         | 线路繁忙                             | 30 秒后重试                         |

**3. 与旧行为的差异(如你的代码按旧值分支,请对照迁移)**

- 限流原以 **408** 返回 → 现统一 **429**(并新增 `Retry-After` 响应头);
- 上游临时错误原散落 400/404/502/504 → 现统一 **500**;
- 审核拒绝的 code 原为 `content_policy_violation` → 现为官方的 **`moderation_blocked`**(HTTP 恒 400 不变);
- 余额不足原为 403 → 现为官方的 **429 `insufficient_quota`**。

**4. 不变的部分**

- 错误响应不应产生 Portal 侧额外计费；发布前仍需用真实失败、重试和延迟结算场景复核;
- 成功响应的格式、计费、模型行为均无任何变化;
- 完整对照表与示例已更新至 https://llmroute.club/docs#errors 。

如接入中有任何疑问,随时联系我们。

LLmRoute
