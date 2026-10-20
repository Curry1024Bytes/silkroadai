# MiniMax-H3 渠道协议修复（2026-10-20）

客户按此前提供的 Apifox 示例调用 `/v1/video/generations`，收到 400：外层 `fail_to_fetch_task`，内层 `unsupported_parameter`，消息为 `quality is not supported by MiniMax Video`。此前示例未覆盖当前渠道的协议差异。

## 原因与配置修复

MiniMax-H3 与其他 12 个视频模型共用渠道 8，类型为 NewAPI Video（59）。该通用适配器会把请求转换为带 `quality`、`ratio`、`async` 的请求体；MiniMax 专用协议拒绝这些字段，并要求显式的 `size`。仅删除客户请求里的字段无法阻止通用适配器重新添加它们。

通过 new-api 管理 API 复制原渠道，创建 MiniMax-H3 专用渠道 9，类型为 MiniMax Video（64），仍属于原「视频模型」分组，使用复制的同一份上游地址和凭据。渠道 8 保留其余 12 个模型及原类型；MiniMax-H3 从渠道 8 移出。Portal 分组镜像更新为 `[8,9]`，仅将 MiniMax-H3 的目录引用从 8 改为 9。

没有修改 new-api 或 Portal 应用源码，没有重启服务，没有更改模型价格、分组倍率或其他计费规则。原 new-api 计费选项和 Portal 全部价格行的前后比较一致。

## Apifox 请求

`POST https://api.llmroute.club/v1/video/generations`

请求头：`Authorization: Bearer sk-客户视频分组Key`、`Content-Type: application/json`。

Body 选择 JSON，使用专用协议：

```json
{
    "model": "MiniMax-H3",
    "prompt": "一只橘猫在湖边钓鱼，镜头缓慢推进，电影质感",
    "seconds": 5,
    "size": "1376x768",
    "workflow_id": "text-to-video"
}
```

此例为 5 秒、768P 横屏。`seconds` 接受 4–15 的整数；`1376x768` 是 H3 支持的尺寸，勿替换为通用的 `1280x720`。此请求不再需要之前示例中的 `ratio`、`resolution` 和 `metadata.resolution`。

客户随后重试收到上游 422：`size 不能与 aspect_ratio、megapixels 或 pixels 同时使用`。此前示例同时传了 `size` 与 `aspect_ratio`，现已删除后者。指定具体像素尺寸时只传 `size`，不要同时传这些互斥字段；本地无效尺寸检查无法覆盖供应商的这项参数组合约束。

提交成功后保留返回的 `task_id`，每 5 秒带同一把 Key 查询 `GET /v1/video/generations/{task_id}`。`data.status=SUCCESS` 时读取 `data.result_url`，`FAILURE` 时读取 `data.fail_reason`，其他状态继续查询。不要将重复提交生成当作轮询。

## 验证与限制

- 已核对服务器与本地只读来源中的两个适配器文件 SHA-256 一致；专用适配器将客户请求转换为 `seconds`、`size`、`workflow_id` 等 MiniMax 支持的字段，使用 `/v1/videos` 调用上游。
- 源站和公网各发送一次故意无效尺寸的请求，均由专用适配器返回本地 `400/invalid_size`；此验证在调用供应商及收费之前拒绝。它证明专用渠道已生效，不能替代成功生成验收。
- 已核对 H3 目录仍启用、分组渠道引用为 `[8,9]`、原渠道类型和其余模型列表保持；应用及依赖容器启动时间与 restart count 不变。
- 本次未发起有效的收费生成请求，最终生成仍需客户使用修正后的 Body 提交确认。

## 备份与回滚

修复前两套数据库 gzip 备份及管理 API 配置快照位于 `/opt/backups/silkroadai-portal/repairs/minimax-h3-20261020/`，目录 0700、文件 0600，两个数据库备份均通过 `gzip -t`。

需要撤销配置时，通过管理 API 恢复渠道 8 的原模型列表和 Portal 原目录引用，并停用渠道 9；不要恢复整库覆盖新的业务数据，也不要删除渠道 9 及其后续任务历史。恢复原配置会重新带回 H3 的协议错误，只能作为撤销此次配置变更的手段。
