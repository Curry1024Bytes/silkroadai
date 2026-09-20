/** /v1/messages tools[] 结构校验单测(@/lib/proxy/anthropic-tools-guard)。 */
import { describe, expect, it } from 'vitest';
import { anthropicInvalidRequestBody, validateAnthropicTools } from '@/lib/proxy/anthropic-tools-guard';

const OK = {
    name: 'get_weather',
    description: 'x',
    input_schema: { type: 'object', properties: { q: { type: 'string' } } },
};

describe('validateAnthropicTools', () => {
    it('合规自定义工具 / 无 properties / 空数组 / 非数组 → 通过', () => {
        expect(validateAnthropicTools([OK])).toBeNull();
        expect(validateAnthropicTools([{ name: 'a', input_schema: { type: 'object' } }])).toBeNull();
        expect(validateAnthropicTools([])).toBeNull();
        expect(validateAnthropicTools(undefined)).toBeNull();
        expect(validateAnthropicTools('nope')).toBeNull();
    });

    it('服务端/内建工具(带非 custom 的 type)不校验', () => {
        expect(validateAnthropicTools([{ type: 'web_search_20250305', name: 'web_search' }])).toBeNull();
        expect(validateAnthropicTools([{ type: 'bash_20250124', name: 'bash' }])).toBeNull();
    });

    it('type: custom 仍按自定义工具校验', () => {
        expect(validateAnthropicTools([{ type: 'custom', name: 'a' }])?.param).toBe('tools.0.custom.input_schema');
    });

    it('元素不是对象 → tools.<i>', () => {
        expect(validateAnthropicTools(['x'])?.message).toBe('tools.0: Input should be an object');
    });

    it('name 缺失 / 非法字符 / 超长 → tools.<i>.custom.name', () => {
        expect(validateAnthropicTools([{ input_schema: { type: 'object' } }])?.message).toBe(
            'tools.0.custom.name: Field required',
        );
        expect(validateAnthropicTools([{ name: 'has space', input_schema: { type: 'object' } }])?.param).toBe(
            'tools.0.custom.name',
        );
        expect(validateAnthropicTools([{ name: 'a'.repeat(65), input_schema: { type: 'object' } }])?.param).toBe(
            'tools.0.custom.name',
        );
    });

    it('重名 → tools: Tool names must be unique', () => {
        expect(validateAnthropicTools([OK, OK])?.message).toBe('tools: Tool names must be unique');
    });

    it('input_schema 缺失 / 非对象 / type 不是 object / properties 非对象', () => {
        expect(validateAnthropicTools([{ name: 'a' }])?.message).toBe('tools.0.custom.input_schema: Field required');
        expect(validateAnthropicTools([{ name: 'a', input_schema: 'string' }])?.message).toBe(
            'tools.0.custom.input_schema: Input should be an object',
        );
        expect(validateAnthropicTools([{ name: 'a', input_schema: [] }])?.param).toBe('tools.0.custom.input_schema');
        expect(validateAnthropicTools([{ name: 'a', input_schema: { type: 'string' } }])?.message).toBe(
            "tools.0.custom.input_schema.type: Input should be 'object'",
        );
        expect(validateAnthropicTools([{ name: 'a', input_schema: {} }])?.param).toBe(
            'tools.0.custom.input_schema.type',
        );
        expect(validateAnthropicTools([{ name: 'a', input_schema: { type: 'object', properties: 'x' } }])?.param).toBe(
            'tools.0.custom.input_schema.properties',
        );
        // properties: null 官方允许
        expect(validateAnthropicTools([{ name: 'a', input_schema: { type: 'object', properties: null } }])).toBeNull();
    });

    it('报第一个违规(第 2 个工具坏 → tools.1)', () => {
        expect(validateAnthropicTools([OK, { name: 'b' }])?.param).toBe('tools.1.custom.input_schema');
    });

    it('anthropicInvalidRequestBody 是 Anthropic 原生错误形', () => {
        expect(anthropicInvalidRequestBody('m')).toEqual({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'm' },
        });
    });
});
