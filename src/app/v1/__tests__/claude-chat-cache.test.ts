/**
 * W9 Claude prompt-cache 透明增强 — 翻译纯函数单测。
 */
import { describe, expect, it, vi } from 'vitest';
import {
    isCacheableClaudeChat,
    buildAnthropicRequest,
    anthropicToOpenAiChat,
    translateAnthropicSseToOpenAi,
} from '../[...path]/claude-chat-cache';

const big = 'x'.repeat(5000); // > MIN_CACHE_CHARS

describe('isCacheableClaudeChat', () => {
    it('true: claude + 纯文本 + 够大', () => {
        expect(
            isCacheableClaudeChat({
                model: 'claude-sonnet-4-6',
                messages: [
                    { role: 'system', content: big },
                    { role: 'user', content: 'hi' },
                ],
            }),
        ).toBe(true);
    });
    it('false: 非 claude', () => {
        expect(isCacheableClaudeChat({ model: 'gpt-5.5', messages: [{ role: 'user', content: big }] })).toBe(false);
    });
    it('false: 带 tools(走透传,翻译不处理工具调用)', () => {
        expect(
            isCacheableClaudeChat({
                model: 'claude-sonnet-4-6',
                tools: [{ type: 'function', function: { name: 'f' } }],
                messages: [{ role: 'user', content: big }],
            }),
        ).toBe(false);
    });
    it('false: 多模态图片 content', () => {
        expect(
            isCacheableClaudeChat({
                model: 'claude-sonnet-4-6',
                messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://x' } }] }],
            }),
        ).toBe(false);
    });
    it('false: response_format(结构化输出)', () => {
        expect(
            isCacheableClaudeChat({
                model: 'claude-sonnet-4-6',
                response_format: { type: 'json_object' },
                messages: [{ role: 'user', content: big }],
            }),
        ).toBe(false);
    });
    it('false: 上下文太小(不值得 / Anthropic 缓存阈值以下)', () => {
        expect(isCacheableClaudeChat({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] })).toBe(
            false,
        );
    });
    it('false: 只有 system 没有对话消息', () => {
        expect(
            isCacheableClaudeChat({ model: 'claude-sonnet-4-6', messages: [{ role: 'system', content: big }] }),
        ).toBe(false);
    });
});

describe('buildAnthropicRequest', () => {
    it('抽 system + 在 system 和最后一条消息打 cache_control', () => {
        const out = buildAnthropicRequest({
            model: 'claude-sonnet-4-6',
            messages: [
                { role: 'system', content: 'SYS' },
                { role: 'user', content: 'hello' },
            ],
        })!;
        expect(out.model).toBe('claude-sonnet-4-6');
        const system = out.system as Array<{ text: string; cache_control?: unknown }>;
        expect(system[0].text).toBe('SYS');
        expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
        const messages = out.messages as Array<{
            role: string;
            content: Array<{ text: string; cache_control?: unknown }>;
        }>;
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('user');
        expect(messages[0].content[0].text).toBe('hello');
        expect(messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('合并连续同 role(Anthropic 要求交替)', () => {
        const out = buildAnthropicRequest({
            model: 'claude-sonnet-4-6',
            messages: [
                { role: 'user', content: 'a' },
                { role: 'user', content: 'b' },
                { role: 'assistant', content: 'c' },
                { role: 'user', content: 'd' },
            ],
        })!;
        const messages = out.messages as Array<{ role: string; content: Array<{ text: string }> }>;
        expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(messages[0].content[0].text).toBe('a\n\nb');
    });

    it('首条(非 system)不是 user → 返回 null(交给透传)', () => {
        expect(
            buildAnthropicRequest({
                model: 'claude-sonnet-4-6',
                messages: [
                    { role: 'assistant', content: 'x' },
                    { role: 'user', content: 'y' },
                ],
            }),
        ).toBeNull();
    });

    it('max_tokens 钳到 4096;映射 temperature/stop/stream', () => {
        const out = buildAnthropicRequest({
            model: 'claude-sonnet-4-6',
            max_tokens: 9999,
            temperature: 0.3,
            stop: ['END'],
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
        })!;
        expect(out.max_tokens).toBe(4096);
        expect(out.temperature).toBe(0.3);
        expect(out.stop_sequences).toEqual(['END']);
        expect(out.stream).toBe(true);
    });

    it('缺 max_tokens → 默认 4096', () => {
        const out = buildAnthropicRequest({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] })!;
        expect(out.max_tokens).toBe(4096);
    });

    it('文本 content-parts 数组也能抽文本', () => {
        const out = buildAnthropicRequest({
            model: 'claude-sonnet-4-6',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'p1' },
                        { type: 'text', text: 'p2' },
                    ],
                },
            ],
        })!;
        const messages = out.messages as Array<{ content: Array<{ text: string }> }>;
        expect(messages[0].content[0].text).toBe('p1p2');
    });
});

describe('anthropicToOpenAiChat', () => {
    it('content 拼接 + finish_reason 映射 + usage(prompt=input+cacheRead+cacheCreate, cached_tokens)', () => {
        const out = anthropicToOpenAiChat(
            {
                id: 'msg_abc',
                model: 'claude-sonnet-4-6',
                content: [
                    { type: 'text', text: 'Hello ' },
                    { type: 'text', text: 'world' },
                ],
                stop_reason: 'end_turn',
                usage: {
                    input_tokens: 10,
                    cache_read_input_tokens: 100,
                    cache_creation_input_tokens: 5,
                    output_tokens: 20,
                },
            },
            'claude-sonnet-4-6',
        );
        expect(out.object).toBe('chat.completion');
        const choices = out.choices as Array<{ message: { content: string }; finish_reason: string }>;
        expect(choices[0].message.content).toBe('Hello world');
        expect(choices[0].finish_reason).toBe('stop');
        const usage = out.usage as {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
            prompt_tokens_details: { cached_tokens: number };
        };
        expect(usage.prompt_tokens).toBe(115);
        expect(usage.completion_tokens).toBe(20);
        expect(usage.total_tokens).toBe(135);
        expect(usage.prompt_tokens_details.cached_tokens).toBe(100);
    });
    it('max_tokens stop_reason → length', () => {
        const out = anthropicToOpenAiChat(
            { content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens', usage: {} },
            'claude-sonnet-4-6',
        );
        const choices = out.choices as Array<{ finish_reason: string }>;
        expect(choices[0].finish_reason).toBe('length');
    });
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let out = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += dec.decode(value, { stream: true });
    }
    return out;
}
function sseStream(text: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
        start(c) {
            c.enqueue(enc.encode(text));
            c.close();
        },
    });
}

describe('translateAnthropicSseToOpenAi', () => {
    it('Anthropic SSE → OpenAI chunk(role 先行 / content delta / finish / [DONE])', async () => {
        const anthropic = [
            'event: message_start',
            'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":100}}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
            '',
            'event: message_delta',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
            '',
            'event: message_stop',
            'data: {"type":"message_stop"}',
            '',
            '',
        ].join('\n');
        const out = await collect(translateAnthropicSseToOpenAi(sseStream(anthropic), 'claude-sonnet-4-6'));
        const datas = out
            .split('\n\n')
            .map((b) => b.replace(/^data: /, '').trim())
            .filter(Boolean);
        expect(datas[datas.length - 1]).toBe('[DONE]');
        const chunks = datas.slice(0, -1).map((d) => JSON.parse(d));
        expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' });
        expect(chunks[0].object).toBe('chat.completion.chunk');
        expect(chunks[0].model).toBe('claude-sonnet-4-6');
        const contents = chunks.map((c) => c.choices[0].delta.content).filter((x) => typeof x === 'string');
        expect(contents.join('')).toBe('Hello');
        const last = chunks[chunks.length - 1];
        expect(last.choices[0].finish_reason).toBe('stop');
        // 所有 chunk 共享同一 id
        expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    });

    it('跨网络分片的 SSE(事件被切断)也能正确重组', async () => {
        const enc = new TextEncoder();
        const parts = [
            'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6"}}\n\nevent: content_bl',
            'ock_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"AB"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        ];
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(enc.encode(parts[0]));
                c.enqueue(enc.encode(parts[1]));
                c.close();
            },
        });
        const out = await collect(translateAnthropicSseToOpenAi(stream, 'claude-sonnet-4-6'));
        const chunks = out
            .split('\n\n')
            .map((b) => b.replace(/^data: /, '').trim())
            .filter((d) => d && d !== '[DONE]')
            .map((d) => JSON.parse(d));
        const contents = chunks.map((c) => c.choices[0].delta.content).filter((x) => typeof x === 'string');
        expect(contents.join('')).toBe('AB');
        expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
    });

    // SSE 流式两件套:翻译流的中断不能包装成 finish_reason:"stop"(截断回答与完整回答
    // 必须可区分)。三种中断形态都要以 error 尾帧收尾:读异常 / 无 message_stop 的干净
    // 关流 / 上游 in-band error 事件。
    const parseChunks = (out: string) =>
        out
            .split('\n\n')
            .map((b) => b.replace(/^data: /, '').trim())
            .filter((d) => d && d !== '[DONE]')
            .map((d) => JSON.parse(d));

    it('上游读异常(连接死)→ finish_reason:"error" 尾帧 + error 对象 + [DONE],不装 stop', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(
                    enc.encode(
                        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6"}}\n\n' +
                            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"par"}}\n\n',
                    ),
                );
                // 异步 error:让读端先消费已入队字节(error() 会丢弃未读队列,真实网络也是字节先到错误后至)
                setTimeout(() => c.error(new Error('ECONNRESET')), 0);
            },
        });
        const out = await collect(translateAnthropicSseToOpenAi(stream, 'claude-sonnet-4-6'));
        const chunks = parseChunks(out);
        const last = chunks[chunks.length - 1];
        expect(last.choices[0].finish_reason).toBe('error');
        expect(last.error.code).toBe('upstream_stream_interrupted');
        expect(last.model).toBe('claude-sonnet-4-6');
        expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
        // 已产出的部分内容仍在
        expect(out).toContain('"content":"par"');
        warn.mockRestore();
    });

    it('上游没发 message_stop 就干净关流(半途断开的另一副面孔)→ 同样 error 尾帧', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const truncated = [
            'event: message_start',
            'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"par"}}',
            '',
            '',
        ].join('\n');
        const out = await collect(translateAnthropicSseToOpenAi(sseStream(truncated), 'claude-sonnet-4-6'));
        const chunks = parseChunks(out);
        expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('error');
        expect(out).toContain('without message_stop');
        warn.mockRestore();
    });

    it('message_delta 已带 stop_reason、message_stop 前断开 → 生成已完整,按正常 finish 收尾', async () => {
        const complete = [
            'event: message_start',
            'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"full"}}',
            '',
            'event: message_delta',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
            '',
            '',
        ].join('\n');
        const out = await collect(translateAnthropicSseToOpenAi(sseStream(complete), 'claude-sonnet-4-6'));
        const chunks = parseChunks(out);
        expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
        expect(out).not.toContain('interrupted');
    });

    it('上游 in-band error 事件 → error 尾帧带上游错误文案', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errored = [
            'event: message_start',
            'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6"}}',
            '',
            'event: error',
            'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
            '',
            '',
        ].join('\n');
        const out = await collect(translateAnthropicSseToOpenAi(sseStream(errored), 'claude-sonnet-4-6'));
        const chunks = parseChunks(out);
        const last = chunks[chunks.length - 1];
        expect(last.choices[0].finish_reason).toBe('error');
        expect(last.error.message).toBe('Overloaded');
        warn.mockRestore();
    });
});
