/**
 * /v1 请求体守门引擎单测(@/lib/proxy/body-guard)。
 * 三条面共用一个引擎,这里覆盖引擎语义;端到端接线在 proxy.test.ts / messages-stream-hold.test.ts。
 */
import { describe, expect, it } from 'vitest';
import {
    ANTHROPIC_SPEC,
    CHAT_SPEC,
    RESPONSES_SPEC,
    coerceAndValidate,
    guardRawBody,
    isAbsent,
    MAX_TOKENS_LIMIT,
    validateRequired,
    violationBody,
} from '@/lib/proxy/body-guard';

describe('body-guard — 强转', () => {
    it('数字串 → 数字(uint / float / int)', () => {
        const o: Record<string, unknown> = { max_tokens: '100', temperature: '0.6', seed: '-3' };
        const { violation, changed } = coerceAndValidate(o, CHAT_SPEC);
        expect(violation).toBeNull();
        expect(changed).toBe(true);
        expect(o.max_tokens).toBe(100);
        expect(o.temperature).toBe(0.6);
        expect(o.seed).toBe(-3);
    });

    it('"true"/"false" → 布尔', () => {
        const o: Record<string, unknown> = { stream: 'true', logprobs: 'FALSE' };
        expect(coerceAndValidate(o, CHAT_SPEC).violation).toBeNull();
        expect(o.stream).toBe(true);
        expect(o.logprobs).toBe(false);
    });

    it('非数字串不强转,落到校验 → 违规', () => {
        const o: Record<string, unknown> = { max_tokens: 'abc' };
        expect(coerceAndValidate(o, CHAT_SPEC).violation).toEqual({
            param: 'max_tokens',
            message: "'max_tokens' must be a non-negative integer",
        });
    });

    it('合法值不动,changed=false', () => {
        const o: Record<string, unknown> = { max_tokens: 1024, stream: false, temperature: 0.7 };
        const { violation, changed } = coerceAndValidate(o, CHAT_SPEC);
        expect(violation).toBeNull();
        expect(changed).toBe(false);
    });
});

describe('body-guard — 校验边界', () => {
    it('null / undefined 视为未传(SDK 常见)', () => {
        expect(isAbsent(null)).toBe(true);
        expect(isAbsent(undefined)).toBe(true);
        const o: Record<string, unknown> = { max_tokens: null, stream: null, tools: null, temperature: null };
        expect(coerceAndValidate(o, CHAT_SPEC).violation).toBeNull();
    });

    it('uint 拒负数与小数,int 允许负数', () => {
        expect(coerceAndValidate({ max_tokens: -1 }, CHAT_SPEC).violation?.param).toBe('max_tokens');
        expect(coerceAndValidate({ max_tokens: 1.5 }, CHAT_SPEC).violation?.param).toBe('max_tokens');
        expect(coerceAndValidate({ seed: -5 }, CHAT_SPEC).violation).toBeNull();
        expect(coerceAndValidate({ seed: 1.5 }, CHAT_SPEC).violation?.param).toBe('seed');
    });

    it('类型错各报各的', () => {
        expect(coerceAndValidate({ messages: 'hi' }, CHAT_SPEC).violation?.param).toBe('messages');
        expect(coerceAndValidate({ model: 123 }, CHAT_SPEC).violation?.param).toBe('model');
        expect(coerceAndValidate({ tools: {} }, CHAT_SPEC).violation?.param).toBe('tools');
        expect(coerceAndValidate({ logprobs: 2 }, CHAT_SPEC).violation?.param).toBe('logprobs');
        expect(coerceAndValidate({ temperature: 'warm' }, CHAT_SPEC).violation?.param).toBe('temperature');
    });

    it('NaN / Infinity 视为非法 float', () => {
        expect(coerceAndValidate({ temperature: NaN }, CHAT_SPEC).violation?.param).toBe('temperature');
        expect(coerceAndValidate({ top_p: Infinity }, CHAT_SPEC).violation?.param).toBe('top_p');
    });
});

describe('body-guard — Anthropic spec(嵌套 thinking.budget_tokens)', () => {
    it('thinking.budget_tokens 负数 → 违规', () => {
        const v = coerceAndValidate({ thinking: { type: 'enabled', budget_tokens: -1 } }, ANTHROPIC_SPEC).violation;
        expect(v?.param).toBe('thinking.budget_tokens');
        expect(v?.message).toContain('non-negative integer');
    });

    it('thinking.budget_tokens 数字串 → 强转', () => {
        const o: Record<string, unknown> = { thinking: { type: 'enabled', budget_tokens: '1024' } };
        expect(coerceAndValidate(o, ANTHROPIC_SPEC).violation).toBeNull();
        expect((o.thinking as Record<string, unknown>).budget_tokens).toBe(1024);
    });

    it('thinking 缺失 / 非对象 → 跳过该规则,不误报', () => {
        expect(coerceAndValidate({}, ANTHROPIC_SPEC).violation).toBeNull();
        expect(coerceAndValidate({ thinking: null }, ANTHROPIC_SPEC).violation).toBeNull();
        expect(coerceAndValidate({ thinking: 'enabled' }, ANTHROPIC_SPEC).violation).toBeNull();
        expect(coerceAndValidate({ thinking: [1, 2] }, ANTHROPIC_SPEC).violation).toBeNull();
    });

    it('system 允许 string 与 array(联合类型不校验)', () => {
        expect(coerceAndValidate({ system: 'you are x' }, ANTHROPIC_SPEC).violation).toBeNull();
        expect(coerceAndValidate({ system: [{ type: 'text', text: 'x' }] }, ANTHROPIC_SPEC).violation).toBeNull();
    });

    it('max_tokens:-1 / stop_sequences 类型错', () => {
        expect(coerceAndValidate({ max_tokens: -1 }, ANTHROPIC_SPEC).violation?.param).toBe('max_tokens');
        expect(coerceAndValidate({ stop_sequences: 'stop' }, ANTHROPIC_SPEC).violation?.param).toBe('stop_sequences');
    });
});

describe('body-guard — Responses spec', () => {
    it('max_output_tokens 负数 → 违规(实测该字段在 new-api 是 uint,会 500)', () => {
        expect(coerceAndValidate({ max_output_tokens: -1 }, RESPONSES_SPEC).violation?.param).toBe('max_output_tokens');
    });
    it('input 允许 string 与 array(联合类型不校验)', () => {
        expect(coerceAndValidate({ input: 'hi' }, RESPONSES_SPEC).violation).toBeNull();
        expect(coerceAndValidate({ input: [{ role: 'user', content: 'hi' }] }, RESPONSES_SPEC).violation).toBeNull();
    });
    it('store / parallel_tool_calls 布尔强转', () => {
        const o: Record<string, unknown> = { store: 'false', parallel_tool_calls: 'true' };
        expect(coerceAndValidate(o, RESPONSES_SPEC).violation).toBeNull();
        expect(o.store).toBe(false);
        expect(o.parallel_tool_calls).toBe(true);
    });
});

describe('body-guard — guardRawBody(文本入口)', () => {
    it('未强转 → 原始字节原样返回(不重新序列化)', () => {
        const raw = '{"model":"m",  "max_tokens":10,\n "messages":[]}';
        const g = guardRawBody(raw, CHAT_SPEC);
        expect(g.violation).toBeNull();
        expect(g.body).toBe(raw); // 逐字节相同
        expect(g.model).toBe('m');
        expect(g.streamed).toBe(false);
    });

    it('强转过 → 重新序列化', () => {
        const g = guardRawBody('{"model":"m","max_tokens":"10"}', CHAT_SPEC);
        expect(g.violation).toBeNull();
        expect(JSON.parse(g.body)).toEqual({ model: 'm', max_tokens: 10 });
    });

    it('违规 → 返回 violation 且 body 保持原样', () => {
        const raw = '{"model":"m","max_tokens":-1}';
        const g = guardRawBody(raw, CHAT_SPEC);
        expect(g.violation?.param).toBe('max_tokens');
        expect(g.body).toBe(raw);
    });

    it('顺带解析 model / stream', () => {
        const g = guardRawBody('{"model":"claude-opus-5","stream":true,"messages":[]}', ANTHROPIC_SPEC);
        expect(g.model).toBe('claude-opus-5');
        expect(g.streamed).toBe(true);
    });

    it('stream 由字符串强转后,streamed 也要跟着变 true', () => {
        const g = guardRawBody('{"model":"m","stream":"true"}', CHAT_SPEC);
        expect(g.streamed).toBe(true);
    });

    // ── fail-open:守门永不成为故障源 ──
    it('body 不是合法 JSON → 原样放行(交给 new-api 报错)', () => {
        const g = guardRawBody('not-json{{{', CHAT_SPEC);
        expect(g.violation).toBeNull();
        expect(g.body).toBe('not-json{{{');
    });

    it('body 是 JSON 数组 / 标量 → 原样放行', () => {
        expect(guardRawBody('[1,2]', CHAT_SPEC).violation).toBeNull();
        expect(guardRawBody('"hi"', CHAT_SPEC).violation).toBeNull();
        expect(guardRawBody('null', CHAT_SPEC).violation).toBeNull();
    });

    it('getter 抛异常的畸形对象 → 不抛,原样放行', () => {
        const spec = [['boom', 'uint']] as const;
        const raw = '{"boom":1}';
        // 用 Proxy 模拟解析后属性访问抛错(fail-open 的最后一道保险)
        const orig = JSON.parse;
        JSON.parse = () =>
            new Proxy(
                {},
                {
                    get() {
                        throw new Error('boom');
                    },
                },
            );
        try {
            const g = guardRawBody(raw, spec);
            expect(g.violation).toBeNull();
            expect(g.body).toBe(raw);
        } finally {
            JSON.parse = orig;
        }
    });
});

describe('body-guard — 必填字段 + max_tokens 上限(validateRequired)', () => {
    const MSG = [{ role: 'user', content: 'hi' }];

    it('chat:messages 缺失 / null → missing_required_parameter', () => {
        for (const o of [{ model: 'm' }, { model: 'm', messages: null }]) {
            expect(validateRequired(o, 'chat')).toEqual({
                param: 'messages',
                message: "Missing required parameter: 'messages'.",
                code: 'missing_required_parameter',
            });
        }
    });

    it('chat:messages 空数组 → empty_array;非空 → 通过', () => {
        expect(validateRequired({ messages: [] }, 'chat')?.code).toBe('empty_array');
        expect(validateRequired({ messages: MSG }, 'chat')).toBeNull();
    });

    it('chat:FIM(prefix 或 suffix 非 null)豁免;prefix:null 不算', () => {
        expect(validateRequired({ prefix: 'a' }, 'chat')).toBeNull();
        expect(validateRequired({ suffix: '' }, 'chat')).toBeNull();
        expect(validateRequired({ prefix: null, suffix: null }, 'chat')?.param).toBe('messages');
    });

    it('anthropic:Anthropic 官方措辞,无 FIM 豁免', () => {
        expect(validateRequired({ model: 'm' }, 'anthropic')?.message).toBe('messages: Field required');
        expect(validateRequired({ messages: [] }, 'anthropic')?.message).toBe(
            'messages: at least one message is required',
        );
        expect(validateRequired({ prefix: 'a' }, 'anthropic')?.param).toBe('messages');
        expect(validateRequired({ messages: MSG }, 'anthropic')).toBeNull();
    });

    it('responses:只有 input 键缺失才拦(null 在 Go 侧是非 nil RawMessage,不必然 500)', () => {
        expect(validateRequired({ model: 'm' }, 'responses')?.param).toBe('input');
        expect(validateRequired({ input: null }, 'responses')).toBeNull();
        expect(validateRequired({ input: 'hi' }, 'responses')).toBeNull();
        expect(validateRequired({ input: [] }, 'responses')).toBeNull();
        // responses 面不要求 messages
        expect(validateRequired({ input: 'hi', messages: [] }, 'responses')).toBeNull();
    });

    it('max_tokens 上限:等于上限放行,超过 → integer_above_max_value(各面各字段)', () => {
        expect(validateRequired({ messages: MSG, max_tokens: MAX_TOKENS_LIMIT }, 'chat')).toBeNull();
        expect(validateRequired({ messages: MSG, max_tokens: MAX_TOKENS_LIMIT + 1 }, 'chat')).toMatchObject({
            param: 'max_tokens',
            code: 'integer_above_max_value',
        });
        expect(validateRequired({ messages: MSG, max_completion_tokens: 2 ** 31 }, 'chat')?.param).toBe(
            'max_completion_tokens',
        );
        expect(validateRequired({ messages: MSG, max_tokens_to_sample: 2 ** 31 }, 'anthropic')?.param).toBe(
            'max_tokens_to_sample',
        );
        expect(validateRequired({ input: 'hi', max_output_tokens: 2 ** 31 }, 'responses')?.param).toBe(
            'max_output_tokens',
        );
    });

    it('guardRawBody:不传 surface 不查必填(旧调用方行为不变);传了才查,且类型违规优先', () => {
        expect(guardRawBody('{"model":"m"}', CHAT_SPEC).violation).toBeNull();
        expect(guardRawBody('{"model":"m"}', RESPONSES_SPEC, 'responses').violation?.param).toBe('input');
        expect(guardRawBody('{"model":"m","max_output_tokens":-1}', RESPONSES_SPEC, 'responses').violation?.param).toBe(
            'max_output_tokens',
        );
        // 数字串先强转再比上限
        expect(
            guardRawBody('{"input":"hi","max_output_tokens":"2147483647"}', RESPONSES_SPEC, 'responses').violation
                ?.code,
        ).toBe('integer_above_max_value');
    });

    it('getter 抛异常 → fail-open 返回 null', () => {
        const evil = Object.defineProperty({}, 'messages', {
            enumerable: true,
            get() {
                throw new Error('boom');
            },
        });
        expect(validateRequired(evil as Record<string, unknown>, 'chat')).toBeNull();
    });
});

describe('body-guard — violationBody 形状', () => {
    it('带 code 的违规 → code 透出', () => {
        expect(violationBody({ param: 'messages', message: 'x', code: 'missing_required_parameter' }).error.code).toBe(
            'missing_required_parameter',
        );
    });

    it('OpenAI 形 invalid_request_error', () => {
        expect(violationBody({ param: 'max_tokens', message: "'max_tokens' must be a non-negative integer" })).toEqual({
            error: {
                message: "'max_tokens' must be a non-negative integer",
                type: 'invalid_request_error',
                param: 'max_tokens',
                code: 'invalid_request_error',
            },
        });
    });
});
