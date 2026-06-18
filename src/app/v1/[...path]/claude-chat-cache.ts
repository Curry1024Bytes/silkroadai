/**
 * W9 — Claude prompt-cache 透明增强(OpenAI 格式)。
 *
 * 背景:new-api 的 OpenAI(/v1/chat/completions)→ Claude 转换器会【丢弃】请求里的
 *   `cache_control`(实测:放 system / user content-parts 都不行)。所以用 OpenAI 格式
 *   调 Claude 的客户拿不到 prompt 缓存,大上下文每轮全价重发 → 余额烧得快。
 *
 * 解决:代理对【可缓存的纯文本 Claude /chat/completions 请求】自己翻译成原生
 *   Anthropic `/v1/messages`、注入 cache_control,发给 new-api 的 /v1/messages
 *   (绕过会剥 cache_control 的转换层),再把响应翻回 OpenAI 形。已证实原生
 *   /v1/messages + cache_control 能命中缓存(user 40 / 探针)。
 *
 * 安全:gate 很保守 —— 带 tools/function call / 多模态图片 / response_format / n>1
 *   或上下文过小的请求一律返回不可翻译,调用方走原透传(零回归)。请求被上游 4xx
 *   拒时调用方也回退透传。响应翻译(含流式 SSE)有完整单测。
 */
import { randomUUID } from 'node:crypto';

type JsonRecord = Record<string, unknown>;

/** Anthropic 单模型最低可缓存 ~1024 tokens;低于此注入 cache_control 也不生效,
 *  故只对足够大的请求翻译,顺带把 blast radius 限制在"值得缓存"的请求上。 */
const MIN_CACHE_CHARS = 4096; // ~1K tokens
const MAX_TOKENS_CAP = 4096; // 与 route.ts 既有 Claude clamp 一致

function isTextContent(content: unknown): boolean {
    if (typeof content === 'string') return true;
    if (Array.isArray(content)) {
        return content.every(
            (p) =>
                p &&
                typeof p === 'object' &&
                (p as JsonRecord).type === 'text' &&
                typeof (p as JsonRecord).text === 'string',
        );
    }
    return false;
}

function contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((p) => (p && typeof p === 'object' ? String((p as JsonRecord).text ?? '') : '')).join('');
    }
    return '';
}

/** 这个 /chat/completions 请求是否适合走"翻译+缓存"路径。保守:任何不确定都返回 false。 */
export function isCacheableClaudeChat(body: JsonRecord): boolean {
    const model = String(body.model ?? '');
    if (!model.startsWith('claude-')) return false;
    // 带工具调用 / 结构化输出 / 多候选 → 翻译复杂,走透传
    if (body.tools || body.functions || body.tool_choice || body.function_call || body.response_format) return false;
    if (typeof body.n === 'number' && body.n > 1) return false;
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) return false;

    let totalChars = 0;
    let hasNonSystem = false;
    for (const m of messages) {
        if (!m || typeof m !== 'object') return false;
        const role = (m as JsonRecord).role;
        const content = (m as JsonRecord).content;
        if (role !== 'system' && role !== 'user' && role !== 'assistant') return false;
        if (!isTextContent(content)) return false; // 多模态/工具结果 → 透传
        totalChars += contentToText(content).length;
        if (role !== 'system') hasNonSystem = true;
    }
    if (!hasNonSystem) return false;
    return totalChars >= MIN_CACHE_CHARS;
}

type AnthropicTextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicTextBlock[] };

/**
 * OpenAI /chat/completions body → Anthropic /v1/messages body,并注入 cache_control。
 * 返回 null = 结构无法干净翻译(如首条非 system 消息不是 user),调用方应走透传。
 */
export function buildAnthropicRequest(body: JsonRecord): JsonRecord | null {
    const messages = body.messages as unknown[];

    // 1. 收集 system(OpenAI 允许多条 system,合并)
    const systemTexts: string[] = [];
    const convo: { role: 'user' | 'assistant'; text: string }[] = [];
    for (const m of messages) {
        const role = (m as JsonRecord).role as string;
        const text = contentToText((m as JsonRecord).content);
        if (role === 'system') systemTexts.push(text);
        else convo.push({ role: role as 'user' | 'assistant', text });
    }

    // 2. 合并连续同 role(Anthropic 要求 user/assistant 交替)
    const merged: { role: 'user' | 'assistant'; text: string }[] = [];
    for (const c of convo) {
        const last = merged[merged.length - 1];
        if (last && last.role === c.role) last.text += '\n\n' + c.text;
        else merged.push({ ...c });
    }
    // Anthropic 要求首条是 user;否则放弃翻译走透传
    if (merged.length === 0 || merged[0].role !== 'user') return null;

    // 3. 转成 Anthropic messages,并在【最后一条消息】末块打 cache_control(增量缓存)
    const anthMessages: AnthropicMessage[] = merged.map((c) => ({
        role: c.role,
        content: [{ type: 'text', text: c.text }],
    }));
    const lastBlock = anthMessages[anthMessages.length - 1].content[0];
    lastBlock.cache_control = { type: 'ephemeral' };

    // 4. system 也打 cache_control(稳定大前缀,单独断点更耐用)
    const out: JsonRecord = {
        model: body.model,
        max_tokens: Math.min(typeof body.max_tokens === 'number' ? body.max_tokens : MAX_TOKENS_CAP, MAX_TOKENS_CAP),
        messages: anthMessages,
    };
    const systemText = systemTexts.join('\n\n').trim();
    if (systemText.length > 0) {
        out.system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
    }
    if (typeof body.temperature === 'number') out.temperature = body.temperature;
    if (typeof body.top_p === 'number') out.top_p = body.top_p;
    if (body.stream === true) out.stream = true;
    if (typeof body.stop === 'string') out.stop_sequences = [body.stop];
    else if (Array.isArray(body.stop)) out.stop_sequences = body.stop.filter((s) => typeof s === 'string');

    return out;
}

function mapStopReason(stop: unknown): string {
    switch (stop) {
        case 'max_tokens':
            return 'length';
        case 'end_turn':
        case 'stop_sequence':
            return 'stop';
        default:
            return 'stop';
    }
}

/** 非流式 Anthropic message → OpenAI chat.completion */
export function anthropicToOpenAiChat(anthropic: JsonRecord, fallbackModel: string): JsonRecord {
    const content = Array.isArray(anthropic.content)
        ? (anthropic.content as unknown[])
              .map((b) =>
                  b && typeof b === 'object' && (b as JsonRecord).type === 'text'
                      ? String((b as JsonRecord).text ?? '')
                      : '',
              )
              .join('')
        : '';
    const usage = (anthropic.usage as JsonRecord) ?? {};
    const inTok = Number(usage.input_tokens ?? 0);
    const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
    const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
    const outTok = Number(usage.output_tokens ?? 0);
    const promptTokens = inTok + cacheRead + cacheCreate;
    return {
        id: 'chatcmpl-' + (typeof anthropic.id === 'string' ? anthropic.id : randomUUID()),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: typeof anthropic.model === 'string' ? anthropic.model : fallbackModel,
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: mapStopReason(anthropic.stop_reason),
            },
        ],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: outTok,
            total_tokens: promptTokens + outTok,
            prompt_tokens_details: { cached_tokens: cacheRead },
        },
    };
}

/** 流式 Anthropic SSE → OpenAI chat.completion.chunk SSE */
export function translateAnthropicSseToOpenAi(
    upstream: ReadableStream<Uint8Array>,
    fallbackModel: string,
): ReadableStream<Uint8Array> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const id = 'chatcmpl-' + randomUUID();
    const created = Math.floor(Date.now() / 1000);
    let respModel = fallbackModel;
    let finishReason = 'stop';
    let roleSent = false;
    let buffer = '';

    const chunk = (delta: JsonRecord, finish: string | null): Uint8Array =>
        encoder.encode(
            `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model: respModel,
                choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`,
        );
    const DONE = encoder.encode('data: [DONE]\n\n');

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            let ended = false;
            const finish = () => {
                if (ended) return;
                ended = true;
                controller.enqueue(chunk({}, finishReason));
                controller.enqueue(DONE);
                controller.close();
            };
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const events = buffer.split('\n\n');
                    buffer = events.pop() ?? ''; // 留下不完整的事件
                    for (const evt of events) {
                        if (!evt.trim()) continue;
                        let type = '';
                        let dataStr = '';
                        for (const line of evt.split('\n')) {
                            if (line.startsWith('event:')) type = line.slice(6).trim();
                            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
                        }
                        if (!dataStr) continue;
                        let data: JsonRecord;
                        try {
                            data = JSON.parse(dataStr) as JsonRecord;
                        } catch {
                            continue;
                        }
                        const t = type || String(data.type ?? '');
                        if (t === 'message_start') {
                            const msg = data.message as JsonRecord | undefined;
                            if (msg && typeof msg.model === 'string') respModel = msg.model;
                            if (!roleSent) {
                                controller.enqueue(chunk({ role: 'assistant' }, null));
                                roleSent = true;
                            }
                        } else if (t === 'content_block_delta') {
                            const delta = data.delta as JsonRecord | undefined;
                            const text = delta?.text;
                            if (typeof text === 'string' && text.length > 0)
                                controller.enqueue(chunk({ content: text }, null));
                        } else if (t === 'message_delta') {
                            const delta = data.delta as JsonRecord | undefined;
                            if (delta && delta.stop_reason != null) finishReason = mapStopReason(delta.stop_reason);
                        } else if (t === 'message_stop') {
                            finish();
                            return;
                        } else if (t === 'error') {
                            // 上游流中错误:尽力收尾,客户至少拿到已产出的内容 + 正常结束
                            finish();
                            return;
                        }
                        // 忽略 ping / content_block_start / content_block_stop
                    }
                }
                finish();
            } catch {
                finish();
            }
        },
        cancel() {
            void reader.cancel();
        },
    });
}
