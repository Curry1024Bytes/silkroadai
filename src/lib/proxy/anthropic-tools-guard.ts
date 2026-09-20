/**
 * /v1/messages `tools[]` 结构校验 —— 对齐 Anthropic 官方的确定性 400。
 *
 * 官方 API 对自定义工具要求 `name`(`^[a-zA-Z0-9_-]{1,64}$`)+ `input_schema`(JSON Schema
 * 对象,`type` 必须是 `"object"`),不合规直接 400 `invalid_request_error` 且不计费。
 * 我们链路上的 new-api 与第三方中转都不校验,畸形工具定义会一路打到模型:客户为一个
 * 官方会免费拒掉的请求付费,对标官方的契约测试也判失败(2026-09-18 客户反馈)。
 *
 * 只校验自定义工具(无 `type` 或 `type: "custom"`);带其它 `type` 的服务端/内建工具
 * (`bash_*` / `text_editor_*` / `web_search_*` / `computer_*` / `code_execution_*` …)
 * 形状各异,交给上游。不做完整 JSON Schema 校验,只挡官方一定会拒的结构性错误。
 * 错误 message 沿用官方的 `tools.<i>.custom.<field>: <reason>` 路径写法。
 *
 * fail-open:校验器自身异常 → 视为通过(/messages 是主流量面,守门不能成为故障点)。
 */
import { isAbsent, type JsonRecord, type Violation } from '@/lib/proxy/body-guard';

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function isPlainObject(v: unknown): v is JsonRecord {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 返回首个违规(null = 通过)。`tools` 非数组时不在本层管(body-guard 的 ANTHROPIC_SPEC 已拦)。 */
export function validateAnthropicTools(tools: unknown): Violation | null {
    try {
        if (!Array.isArray(tools)) return null;
        const seen = new Set<string>();
        for (let i = 0; i < tools.length; i++) {
            const t: unknown = tools[i];
            if (!isPlainObject(t)) return { param: `tools.${i}`, message: `tools.${i}: Input should be an object` };
            if (!isAbsent(t.type) && t.type !== 'custom') continue; // 服务端/内建工具:交给上游

            const p = `tools.${i}.custom`;
            if (isAbsent(t.name)) return { param: `${p}.name`, message: `${p}.name: Field required` };
            if (typeof t.name !== 'string' || !TOOL_NAME_RE.test(t.name)) {
                return {
                    param: `${p}.name`,
                    message: `${p}.name: String should match pattern '${TOOL_NAME_RE.source}'`,
                };
            }
            if (seen.has(t.name)) return { param: 'tools', message: 'tools: Tool names must be unique' };
            seen.add(t.name);

            if (isAbsent(t.input_schema)) {
                return { param: `${p}.input_schema`, message: `${p}.input_schema: Field required` };
            }
            if (!isPlainObject(t.input_schema)) {
                return { param: `${p}.input_schema`, message: `${p}.input_schema: Input should be an object` };
            }
            if (t.input_schema.type !== 'object') {
                return { param: `${p}.input_schema.type`, message: `${p}.input_schema.type: Input should be 'object'` };
            }
            if (!isAbsent(t.input_schema.properties) && !isPlainObject(t.input_schema.properties)) {
                return {
                    param: `${p}.input_schema.properties`,
                    message: `${p}.input_schema.properties: Input should be an object`,
                };
            }
        }
        return null;
    } catch {
        return null;
    }
}

/** Anthropic 原生 400 错误体(SDK 按 `error.type` 归 BadRequestError)。 */
export function anthropicInvalidRequestBody(message: string) {
    return { type: 'error', error: { type: 'invalid_request_error', message } };
}
