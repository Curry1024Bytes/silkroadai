# 2026-09-09 Cloudflare API 客户端兼容检查

本记录是当天应用发布完成后的独立 Cloudflare 运维变更。operator 先批准 API 路径的 Browser Integrity Check（BIC）例外，随后在了解机器人阶段豁免范围后要求「所以我们要先处理这些问题才行」，继续完成默认 SDK 兼容修复。北京时间 21:26，官方 OpenAI Python SDK 默认配置、真实管理员客户 Key 的模型列表已返回 200。应用仍运行 `d3c60d3`；本次没有重新部署、数据库写入、客户 Key 轮换、支付或收费生成请求。

## 已生效的变更

- 规则：`LLmRoute API - Disable Browser Integrity Check`。
- 类型：Configuration Rule；ID：`d3b136c9eda64005baf0a43257a793b1`。
- 北京时间 2026-09-09 16:40:43 左右启用；控制台回读为 `Active`、`1 active`。
- 唯一设置：`bic: false`。匹配表达式在保存后重新打开核实为：

```text
(http.host eq "api.llmroute.club" and (starts_with(http.request.uri.path, "/v1/") or starts_with(http.request.uri.path, "/v1beta/")))
```

主站 apex/www、API 的非白名单路径不在例外范围内。全局 BIC 和 Bot Fight Mode 仍开启，Cloudflare Managed Ruleset 与 HTTP DDoS 仍显示 Always active；没有新增跳过全部 managed rules 的规则。原 `Bypass LLmRoute API` Cache Rule 保持 Active。16:40 BIC 单独启用时，控制台显示自定义安全规则 `0/5`、自定义限流规则 `0/1`；21:23 后仅新增下文的一条 custom skip rule，不能表述为已经配置了 Cloudflare 自定义限流。

[Cloudflare BIC 文档](https://developers.cloudflare.com/waf/tools/browser-integrity-check/)说明该功能会检查客户端 HTTP 头，并支持按条件关闭；本次用 Configuration Rule 对 API 路径配置例外。

## 原始故障的归因证据

北京时间 16:16:27，在 VPS 用同一 urllib 库、同一无效测试 Key 请求 `GET https://api.llmroute.club/v1/models`，仅替换 User-Agent：

| User-Agent          | HTTP | 返回               | CF-Ray                 |
| ------------------- | ---- | ------------------ | ---------------------- |
| `Python-urllib/3.9` | 403  | `error code: 1010` | `a384c03c1af869bb-LAX` |
| `curl/8.12.1`       | 401  | JSON，无效 Key     | `a384c03c7f5da0c6-LAX` |

Cloudflare Security Events 中第一条 Ray 的 Host、Path、User-Agent 均匹配，Service 为 `Browser integrity check`，Action 为 `Block`。这确认了该次 403 的来源；没有据此推断拦截策略最早开始生效的日期。发布期间未修改 Cloudflare，与本记录之后独立启用规则的时间应分开。

## 启用后验证

北京时间 16:41，VPS 发起的 16 项检查全部通过：

| 检查                                                                                                                                  | 客户端            | 结果                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------- |
| API `/v1/models`，管理员自己的活动客户 Key                                                                                            | 默认 urllib、curl | 均 200；该档次均返回 4 个模型 |
| API `/v1/models`，无效测试 Key                                                                                                        | 默认 urllib、curl | 均 401 JSON                   |
| API `/v1/chat/completions` OPTIONS                                                                                                    | 默认 urllib、curl | 均 204                        |
| API `/v1beta/models/compat-smoke:generateContent` OPTIONS                                                                             | 默认 urllib、curl | 均 204                        |
| apex/www `/login`                                                                                                                     | curl              | 均 200                        |
| apex/www `/login`                                                                                                                     | 默认 urllib       | 均 403；主站原有 BIC 仍生效   |
| API `/login`、`/admin/login`、`/image-adapter/ominiapi/v1/images/generations`、`/image-adapter25/wetokenasia25/v1/images/generations` | curl GET          | 四项均 404                    |

真实 Key 只在服务器内存中读取和使用，curl 的 Authorization 通过 stdin 传入；没有输出、保存或放入命令参数。本轮只有 GET/OPTIONS，未执行推理、支付或创建/删除 Key。以上状态码验证不扩展为收费生成、完整 OAuth 登录或所有客户端均兼容。

另在本机隔离 Python 环境测试默认客户端，统一使用无效测试 Key、`GET /v1/models`，期望值为 401：

| 客户端                          | 启用 BIC 例外后    | 说明                               |
| ------------------------------- | ------------------ | ---------------------------------- |
| Python urllib 默认头            | 401 JSON           | 到达 Key 鉴权                      |
| requests 2.34.2                 | 401 JSON           | 到达 Key 鉴权                      |
| httpx2 2.12.0                   | 401 JSON           | 到达 Key 鉴权                      |
| OpenAI Python SDK 3.10.0 默认头 | **403 text/plain** | 另一条 AI 机器人规则仍拦截，未解决 |

Python SDK 仅安装到 `/tmp/llmroute-cloudflare-20260909/venv`，没有加入 Portal 依赖。Portal 仍是 Next.js/TypeScript；Python 在这里是验收工具和第三方客户端。

## 独立故障：OpenAI SDK 默认头被 Manage AI bots 拦截

启用 BIC 例外前后均复现官方 SDK 默认 `User-Agent: OpenAI/Python 3.10.0` 的 403。Security Events 精确匹配了以下两次请求：

- 16:27:29，Ray `a384d064ff426716-AMS`。
- 16:41:18，Ray `a384e49fcfd966e0-AMS`。
- Service：`Managed rules`；Action：`Block`。
- Ruleset：`Cloudflare Bot Management rules for all plans`，ID `3e677e63d4e9479382576f3fa66279e7`。
- Rule：`Manage AI bots`，ID `7bd01eeccb6b420fa0be30264603a5cb`。
- Host 为 `api.llmroute.club`、GET `/v1/models`、空 query string。

这是另一条规则的误拦，不能归因为 BIC 例外未生效，也不能混同为 Service 为 `Bot fight mode` 的挑战。后者在 Free 套餐不支持 Skip；[Cloudflare 的执行顺序与误拦排查说明](https://developers.cloudflare.com/waf/feature-interoperability/)将这两类服务分开处理。

当时控制台确认：Free 套餐的 Create rule → Managed rules 弹出升级提示；普通 Custom Rule 的 Skip 只提供所有 Managed Rules 等组件选项，没有单选上述 AI 规则的入口。事件详情也没有单条例外操作。AI bot policies 配置是整站选项；读取后取消，未保存修改。没有购买套餐、关闭整站 AI 防护或跳过整个 Managed Rules 阶段。

最初计划是针对上述单条规则建立与 BIC 相同 host/path 范围的例外。后续 API 只读检查和 `dry_run=true` 得到：目标 ruleset 属于 `http_request_sbfm`，WAF Token 读取它返回权限不足；这不等同于套餐权益被拒绝。zone 没有 WAF managed entrypoint；在 custom phase 使用单规则 `rules` 参数返回 400/code 20118：`skip action parameter 'rules' cannot be used in the phase http_request_firewall_custom`。改为只跳过 `http_request_sbfm` 后预校验 200，且前后 ruleset 列表完全一致，没有在预校验阶段保存规则。

修复前的临时客户端办法曾用官方 SDK 验证：仅替换 User-Agent 为专用客户端标识后，无效 Key 得到 401 JSON（Ray `a384f0e32c77c23f-AMS`）。保留 `OpenAI/Python` 再追加后缀仍为 403。以下片段仅保留为历史证据；21:26 默认 SDK 验收通过后，不再要求客户端采用此覆盖：

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["LLMROUTE_API_KEY"],
    base_url="https://api.llmroute.club/v1",
    default_headers={"User-Agent": "LLmRoute-Python-SDK/1.0"},
)
```

该临时办法当时只验证了无效 Key 的鉴权可达性，未用 SDK 发起收费生成。没有修改 Portal 公开文档或要求所有客户更换配置。

## 21:23 SDK 默认兼容修复与验收

恢复执行前，重新实测 OpenAI Python SDK 3.10.0 默认请求仍为 403（Ray `a3867fa83b8bef4a-LHR`），另外三类 HTTP 客户端为 401；当前 custom entrypoint 仍不存在，原有五个 ruleset 的版本与上次检查一致。重复预校验成功后，于北京时间 21:23:43 应用以下规则：

- 名称：`LLmRoute API - Skip SBFM bot checks`。
- zone custom ruleset：`c66d62c0ae7541caa27328d72174649c`，version 1。
- Rule ID：`5804effbe8504e7386f78e6715d4bccb`，version 1，enabled，匹配日志开启。
- 匹配表达式与本记录 BIC 例外完全相同，只包含 API hostname 的 `/v1/`、`/v1beta/` 前缀。
- action 为 `skip`，唯一 `action_parameters` 为 `{"phases":["http_request_sbfm"]}`。

保存后逐字段回读完全匹配，custom entrypoint 恰好包含这一条规则，其他 ruleset 的 ID/version 均未变化。本次跳过的是该范围内整个 SBFM 阶段的现有及未来规则，不是单条 `Manage AI bots`。WAF managed/custom、rate limiting、HTTP DDoS 阶段均未跳过；主站不在范围内。Free Bot Fight Mode 位于 Ruleset Engine 之外，不能据此宣称它已被跳过；依据见 [Cloudflare Skip 选项](https://developers.cloudflare.com/waf/custom-rules/skip/options/)。没有升级套餐或新增自定义限流规则。

北京时间 21:24–21:26，默认 SDK 的六项鉴权测试全部通过：

| 客户端与请求                                          | 凭据                     | 结果                                                   |
| ----------------------------------------------------- | ------------------------ | ------------------------------------------------------ |
| OpenAI Python SDK 3.10.0，GET `/v1/models`            | 管理员自己的活动客户 Key | 200，SDK 正常解析 4 个模型；Ray `a38685720b4fa733-LAX` |
| OpenAI Python SDK 3.10.0，GET `/v1/models`            | 无效测试 Key             | 401 JSON                                               |
| OpenAI Python SDK 3.10.0，POST `/v1/chat/completions` | 无效测试 Key             | 401 JSON                                               |
| OpenAI Python SDK 3.10.0，POST `/v1/responses`        | 无效测试 Key             | 401 JSON                                               |
| Anthropic Python SDK 1.4.0，GET `/v1/models`          | 无效测试 Key             | 401 JSON                                               |
| Anthropic Python SDK 1.4.0，POST `/v1/messages`       | 无效测试 Key             | 401 JSON；Ray `a38685c418625730-LAX`                   |

测试记录实际请求 UA 分别为 `OpenAI/Python 3.10.0`、`Anthropic/Python 1.4.0`，没有覆盖 UA。客户 Key 通过 SSH 从生产只读查询到本机测试进程内存，不写文件、不进命令参数或输出。真实 Key 只用于 GET 模型列表；三个 POST 均用无效测试 Key，没有收费推理，也未验收生成结果或 SSE。

另有 urllib、requests 2.34.2、httpx2 2.12.0、OpenAI SDK 四类客户端的无效 Key 模型列表均为 401 JSON；原 16 项服务器检查再次全部通过：真实 Key 200、假 Key 401、两类 CORS 204、主站 curl 200/urllib 原 BIC 403、API 非白名单及内部适配器 GET 404。

临时管理 Token `LLmRoute SDK compatibility 20260909` 仅有该 zone 的 WAF Edit 权限，原设定在北京时间次日 07:59:59 到期。验收后于 21:27 主动删除；控制台显示 `No API tokens`，API verify 返回 401/code 1000 `Invalid API Token`。本机 0600 凭据文件及其 0700 临时目录已删除，持有凭据的 CUA 会话已重置。Token 撤销不影响已保存的两条兼容规则或客户 API Key。

## Claude 桌面客户端的独立限制

用户 17:04 的 `/v1/messages` 403 已到达源站/new-api，channel 9 的上游明确返回 `This group is restricted to Claude Code clients`，与 Cloudflare 误拦分开处理。21:24 只读复核六条渠道，仍只有 `CCMax稳定满血`（channel 9）提供 Claude，共九个模型；Portal 未额外剥离请求头。没有更改渠道或伪装 Claude Code 客户端。

桌面客户端的真实 Claude 推理仍未解决：需供应商授权通用客户端访问，或由 operator 提供兼容的通用 Claude 渠道后接入与验收。本次 Anthropic SDK 的无效 Key 401 只能证明经过 Cloudflare 到达鉴权，不能证明该渠道支持桌面客户端。

## 回滚与证据

在 Cloudflare Rules → Overview 找到 `LLmRoute API - Disable Browser Integrity Check`，通过该规则菜单选择 Disable 即可恢复原 BIC 行为。不要删除原 Cache Bypass 规则或调整 Nginx；回滚后默认 urllib 在 API 路径再次被拦截是预期结果。回滚此 Cloudflare 配置无需重建 Portal 或回退数据库。

SDK 例外独立回滚：只 Disable 或删除 `LLmRoute API - Skip SBFM bot checks`（Rule ID `5804effbe8504e7386f78e6715d4bccb`）；不要删除整个 custom ruleset，以免影响未来新增的其他规则。回滚后官方 SDK 默认请求可能恢复原 AI bot 403，BIC 例外和 cache bypass 应继续保留。

本机原始证据目录为 `/tmp/llmroute-cloudflare-20260909/`，包含 BIC 前后记录、两类 `cf-dry-run-*.json`、`resume-before-*.json`、`apply-response.json`、`apply-confirmed-entry.json`、`after-sbfm-sdk.json`、`after-sbfm-sdk-auth.json`、`after-sbfm-server.json`、`token-revoked.json` 及测试脚本。临时目录可能被清理，本记录已保留关键结果、规则 ID、表达式和 Ray ID；Cloudflare 事件检索本身也受保留期限制。
