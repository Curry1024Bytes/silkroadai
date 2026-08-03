/**
 * /v1 请求体守门 —— 把 new-api 的 500 变成「强转成功」或「400」。
 *
 * new-api 在转发前把请求反序列化进自己的 Go 结构体,解析失败直接抛 **500**
 * (`json: cannot unmarshal ... into Go struct field ...`)。这是客户端错误,按 HTTP
 * 语义必须 4xx —— 5xx 会让 SDK 与网关退避重试,一个永远不可能成功的请求被反复重打,
 * 白烧配额与连接数。四家 new-api 系渠道实测报错字符串逐字一致,是公共行为,
 * 换上游解决不了(PR #304 背景)。
 *
 * 三条面各有自己的 Go 结构体,字段名与类型不同,所以按面分 spec:
 *   - /chat/completions → GeneralOpenAIRequest      (PR #304 已上线,本模块接管其逻辑)
 *   - /messages         → ClaudeRequest             (占 97.4% 流量)
 *   - /responses        → OpenAIResponsesRequest    (占 2.2%)
 * legacy /completions 不覆盖:该端点在我们网关上对任何合法请求都返
 * `400 field messages is required`(new-api 并进了 chat 处理器),本就不可用。
 *
 * 两段式,与既有 coerceImageIntFields 同思路:
 *   1. 语义无歧义的就地强转("100"→100、"true"→true),客户请求照常成功;
 *   2. 强转不了的(类型错、uint 收到负数/小数)→ 400,不打上游。
 *
 * 安全性质:
 *   - **fail-open** —— 守门自身抛异常一律按「原样放行」处理。/messages 是 97.4%
 *     的流量,宁可漏掉一个 400,不能因为守门挂掉造成全站故障。
 *   - **body 不可解析时放行** —— 保持今天的行为(交给 new-api 报它自己的错)。
 *   - **没有强转就转发原始字节** —— 只有真改了字段才重新序列化,避免键序/转义差异。
 */

export type JsonRecord = Record<string, unknown>;

/** null / undefined 一律视为「未传」—— Go 把 JSON null 解析进标量是安全的,不能误判成非法。 */
export function isAbsent(v: unknown): boolean {
    return v === null || v === undefined;
}

type FieldKind = 'uint' | 'int' | 'float' | 'bool' | 'array' | 'string';

/** 字段名支持一层嵌套点号(如 thinking.budget_tokens);父级缺失或非对象 → 跳过。 */
type FieldRule = readonly [path: string, kind: FieldKind];

const MESSAGE_BY_KIND: Record<FieldKind, string> = {
    uint: 'must be a non-negative integer',
    int: 'must be an integer',
    float: 'must be a number',
    bool: 'must be a boolean',
    array: 'must be an array',
    string: 'must be a string',
};

/** 顺序即校验顺序(多个字段同时非法时,报最靠前的那个)。 */
export type Spec = readonly FieldRule[];

/** /chat/completions → GeneralOpenAIRequest。顺序与 PR #304 一致,勿随意调整(测试依赖报错字段)。 */
export const CHAT_SPEC: Spec = [
    ['messages', 'array'],
    ['model', 'string'],
    ['tools', 'array'],
    ['stream', 'bool'],
    ['logprobs', 'bool'],
    ['max_tokens', 'uint'],
    ['max_completion_tokens', 'uint'],
    ['n', 'uint'],
    ['top_logprobs', 'uint'],
    ['temperature', 'float'],
    ['top_p', 'float'],
    ['presence_penalty', 'float'],
    ['frequency_penalty', 'float'],
    ['seed', 'int'],
];

/** /messages → ClaudeRequest。`system` 允许 string | array,`tool_choice` 允许对象,故不校验。 */
export const ANTHROPIC_SPEC: Spec = [
    ['messages', 'array'],
    ['model', 'string'],
    ['tools', 'array'],
    ['stop_sequences', 'array'],
    ['stream', 'bool'],
    ['max_tokens', 'uint'],
    ['top_k', 'uint'],
    ['thinking.budget_tokens', 'uint'],
    ['temperature', 'float'],
    ['top_p', 'float'],
];

/** /responses → OpenAIResponsesRequest。`input` 允许 string | array,`reasoning` 是对象,故不校验。 */
export const RESPONSES_SPEC: Spec = [
    ['tools', 'array'],
    ['model', 'string'],
    ['stream', 'bool'],
    ['store', 'bool'],
    ['parallel_tool_calls', 'bool'],
    ['max_output_tokens', 'uint'],
    ['max_tool_calls', 'uint'],
    ['top_logprobs', 'uint'],
    ['temperature', 'float'],
    ['top_p', 'float'],
];

/** 解析一层点号路径,返回 [持有该字段的对象, 末级键]。父级不是普通对象 → null(跳过该规则)。 */
function resolve(obj: JsonRecord, path: string): [JsonRecord, string] | null {
    const dot = path.indexOf('.');
    if (dot < 0) return [obj, path];
    const parent = obj[path.slice(0, dot)];
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return null;
    return [parent as JsonRecord, path.slice(dot + 1)];
}

export type Violation = { param: string; message: string };

/**
 * 就地强转 + 校验。返回首个违规(null = 通过);`changed` 表示是否发生过强转。
 * 只拒「本来就必然 500」的输入 —— 不新增任何今天能跑通的请求的拒绝。
 */
export function coerceAndValidate(obj: JsonRecord, spec: Spec): { violation: Violation | null; changed: boolean } {
    let changed = false;

    for (const [path, kind] of spec) {
        const site = resolve(obj, path);
        if (!site) continue;
        const [holder, key] = site;
        let v = holder[key];
        if (isAbsent(v)) continue;

        // ① 语义无歧义的强转
        if (kind === 'bool' && typeof v === 'string') {
            const s = v.trim().toLowerCase();
            if (s === 'true' || s === 'false') {
                v = s === 'true';
                holder[key] = v;
                changed = true;
            }
        } else if ((kind === 'uint' || kind === 'int' || kind === 'float') && typeof v === 'string') {
            const s = v.trim();
            if (s !== '' && Number.isFinite(Number(s))) {
                v = Number(s);
                holder[key] = v;
                changed = true;
            }
        }

        // ② 强转后仍非法 → 违规
        const bad =
            kind === 'array'
                ? !Array.isArray(v)
                : kind === 'string'
                  ? typeof v !== 'string'
                  : kind === 'bool'
                    ? typeof v !== 'boolean'
                    : kind === 'float'
                      ? typeof v !== 'number' || !Number.isFinite(v)
                      : kind === 'int'
                        ? typeof v !== 'number' || !Number.isInteger(v)
                        : typeof v !== 'number' || !Number.isInteger(v) || v < 0; // uint

        if (bad) return { violation: { param: path, message: `'${path}' ${MESSAGE_BY_KIND[kind]}` }, changed };
    }

    return { violation: null, changed };
}

export type RawGuardResult = {
    /** 要发给上游的 body:未强转 = 原始字节;强转过 = 重新序列化。 */
    body: string;
    /** 顺带解析出的 model / stream,省掉调用方再解析一次(/messages 是热路径)。 */
    model: string | null;
    streamed: boolean;
    /** 非 null → 调用方应直接返回 400,不打上游。 */
    violation: Violation | null;
};

/**
 * 文本入口:解析 → 强转 → 校验。**永不抛异常**(fail-open:任何意外都按原样放行)。
 * body 不可解析时同样放行,保持今天「交给 new-api 报错」的行为。
 */
export function guardRawBody(raw: string, spec: Spec): RawGuardResult {
    try {
        const obj = JSON.parse(raw) as unknown;
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            return { body: raw, model: null, streamed: false, violation: null };
        }
        const rec = obj as JsonRecord;
        const model = typeof rec.model === 'string' ? rec.model : null;
        const streamed = rec.stream === true;

        const { violation, changed } = coerceAndValidate(rec, spec);
        if (violation) return { body: raw, model, streamed, violation };

        return { body: changed ? JSON.stringify(rec) : raw, model, streamed: rec.stream === true, violation: null };
    } catch {
        return { body: raw, model: null, streamed: false, violation: null };
    }
}

/** OpenAI 形 400 响应体(三条面统一形状)。 */
export function violationBody(v: Violation) {
    return {
        error: {
            message: v.message,
            type: 'invalid_request_error',
            param: v.param,
            code: 'invalid_request_error',
        },
    };
}
