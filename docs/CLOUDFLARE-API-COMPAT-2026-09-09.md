# 2026-09-09 Cloudflare API 客户端兼容检查

本记录是当天应用发布完成后的独立 Cloudflare 运维变更。operator 在审阅仅作用于 API 路径的 Browser Integrity Check（BIC）草稿后明确回复「按你意思来」，随后启用规则并验证。应用仍运行 `d3c60d3`；本次没有重新部署、数据库写入、Key 轮换、支付或收费生成请求。

## 已生效的变更

- 规则：`LLmRoute API - Disable Browser Integrity Check`。
- 类型：Configuration Rule；ID：`d3b136c9eda64005baf0a43257a793b1`。
- 北京时间 2026-09-09 16:40:43 左右启用；控制台回读为 `Active`、`1 active`。
- 唯一设置：`bic: false`。匹配表达式在保存后重新打开核实为：

```text
(http.host eq "api.llmroute.club" and (starts_with(http.request.uri.path, "/v1/") or starts_with(http.request.uri.path, "/v1beta/")))
```

主站 apex/www、API 的非白名单路径不在例外范围内。全局 BIC 和 Bot Fight Mode 仍开启，Cloudflare Managed Ruleset 与 HTTP DDoS 仍显示 Always active；没有新增跳过全部 managed rules 的规则。原 `Bypass LLmRoute API` Cache Rule 保持 Active。控制台显示自定义安全规则 `0/5`、自定义限流规则 `0/1`，不能表述为已经配置了 Cloudflare 自定义限流。

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

## 独立待办：OpenAI SDK 默认头被 Manage AI bots 拦截

启用 BIC 例外前后均复现官方 SDK 默认 `User-Agent: OpenAI/Python 3.10.0` 的 403。Security Events 精确匹配了以下两次请求：

- 16:27:29，Ray `a384d064ff426716-AMS`。
- 16:41:18，Ray `a384e49fcfd966e0-AMS`。
- Service：`Managed rules`；Action：`Block`。
- Ruleset：`Cloudflare Bot Management rules for all plans`，ID `3e677e63d4e9479382576f3fa66279e7`。
- Rule：`Manage AI bots`，ID `7bd01eeccb6b420fa0be30264603a5cb`。
- Host 为 `api.llmroute.club`、GET `/v1/models`、空 query string。

这是另一条规则的误拦，不能归因为 BIC 例外未生效，也不能混同为 Service 为 `Bot fight mode` 的挑战。后者在 Free 套餐不支持 Skip；[Cloudflare 的执行顺序与误拦排查说明](https://developers.cloudflare.com/waf/feature-interoperability/)将这两类服务分开处理。

当前控制台确认：Free 套餐的 Create rule → Managed rules 弹出升级提示；普通 Custom Rule 的 Skip 只提供所有 Managed Rules 等组件选项，没有单选上述 AI 规则的入口。事件详情也没有单条例外操作。AI bot policies 配置是整站选项；读取后取消，未保存修改。没有购买套餐、关闭整站 AI 防护或跳过整个 Managed Rules 阶段。

后续优先尝试针对上述单条规则建立与 BIC 相同 host/path 范围的例外，并复验 SDK 默认头。官方支持[通过 API 创建指定规则的 managed exception](https://developers.cloudflare.com/waf/managed-rules/waf-exceptions/define-api/)，但本次没有可用的受限 Cloudflare API 凭据，也没有实际验证 Free 套餐是否允许该特殊 ruleset 的精确例外；不要承诺 API 方式一定可用，或直接要求升级。

临时客户端办法已用官方 SDK 验证：仅替换 User-Agent 为专用客户端标识后，无效 Key 得到 401 JSON（Ray `a384f0e32c77c23f-AMS`）。保留 `OpenAI/Python` 再追加后缀仍为 403。以下初始化片段供受影响的客户端临时使用：

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["LLMROUTE_API_KEY"],
    base_url="https://api.llmroute.club/v1",
    default_headers={"User-Agent": "LLmRoute-Python-SDK/1.0"},
)
```

该办法只验证了无效 Key 的鉴权可达性，未用 SDK 发起收费生成；不能视为服务端已修复 SDK 的默认兼容问题。没有修改 Portal 公开文档或要求所有客户更换配置。

## 回滚与证据

在 Cloudflare Rules → Overview 找到 `LLmRoute API - Disable Browser Integrity Check`，通过该规则菜单选择 Disable 即可恢复原 BIC 行为。不要删除原 Cache Bypass 规则或调整 Nginx；回滚后默认 urllib 在 API 路径再次被拦截是预期结果。回滚此 Cloudflare 配置无需重建 Portal 或回退数据库。

本机原始证据目录为 `/tmp/llmroute-cloudflare-20260909/`，包含 `before-sdk.json`、`after-bic-server.json`、`after-bic-sdk.json`、`sdk-custom-ua.json` 及测试脚本。临时目录可能被清理，本记录已保留关键结果、规则 ID、表达式和 Ray ID；Cloudflare 事件检索本身也受保留期限制。
