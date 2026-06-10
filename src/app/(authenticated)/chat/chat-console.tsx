'use client';

/**
 * Chat UI v2 — assistant-ui console (client island).
 *
 * Upgrades v1's hand-rolled console to assistant-ui (LocalRuntime) while
 * keeping every backend contract identical:
 *   - still POSTs the full transcript to /api/portal/chat/stream
 *     (cookie auth + system token + quota — the sk-… never reaches here);
 *   - still stateless: no persistence. "新对话" remounts a fresh runtime.
 *
 * What assistant-ui buys us: real streaming-aware markdown + Prism code
 * highlighting (see assistant-markdown.tsx), image attachments, and a
 * maintained composer/thread — instead of ~700 lines of bespoke UI.
 *
 * What stays ours: the vendor-grouped model picker (operator's core ask)
 * and a 联网搜索 toggle. The runtime is headless, so the picker/toggle sit
 * outside it and feed the adapter via refs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AssistantRuntimeProvider,
    useLocalRuntime,
    ThreadPrimitive,
    MessagePrimitive,
    ComposerPrimitive,
    ActionBarPrimitive,
    AttachmentPrimitive,
    SimpleImageAttachmentAdapter,
    type ChatModelAdapter,
    type ThreadMessage,
} from '@assistant-ui/react';
import type { ChatModelGroup } from '@/lib/chat/models';
import { AssistantMarkdown } from './assistant-markdown';

interface ChatConsoleProps {
    groups: ChatModelGroup[];
    /** Flat id list — first entry is the default selection. */
    modelIds: string[];
}

// ── OpenAI message conversion ──────────────────────────────────────────

type OAIContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type OAIMessage = { role: 'system' | 'user' | 'assistant'; content: string | OAIContentPart[] };

/** Convert assistant-ui ThreadMessages into the OpenAI shape our backend
 *  forwards to new-api. Text parts → text; image parts + image attachments
 *  → `image_url` (data URLs from SimpleImageAttachmentAdapter). A turn with
 *  no images stays a plain string (cheaper, and what non-vision models want). */
function toOpenAIMessages(messages: readonly ThreadMessage[]): OAIMessage[] {
    const out: OAIMessage[] = [];
    for (const m of messages) {
        if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
        const texts: string[] = [];
        const imageUrls = new Set<string>();

        for (const part of m.content as ReadonlyArray<{ type: string; text?: string; image?: string }>) {
            if (part.type === 'text' && part.text) texts.push(part.text);
            else if (part.type === 'image' && part.image) imageUrls.add(part.image);
        }
        // Image attachments live alongside content (SimpleImageAttachmentAdapter).
        const attachments = (
            m as {
                attachments?: ReadonlyArray<{
                    content?: ReadonlyArray<{ type: string; text?: string; image?: string }>;
                }>;
            }
        ).attachments;
        for (const att of attachments ?? []) {
            for (const part of att.content ?? []) {
                if (part.type === 'image' && part.image) imageUrls.add(part.image);
                else if (part.type === 'text' && part.text) texts.push(part.text);
            }
        }

        const text = texts.join('\n').trim();
        if (imageUrls.size > 0) {
            const parts: OAIContentPart[] = [];
            if (text) parts.push({ type: 'text', text });
            for (const url of imageUrls) parts.push({ type: 'image_url', image_url: { url } });
            out.push({ role: m.role, content: parts });
        } else {
            out.push({ role: m.role, content: text });
        }
    }
    return out;
}

/** Parse OpenAI-style SSE buffer → concatenated delta text + remaining tail
 *  + done flag. Verbatim from v1 (proven). */
function drainSse(buffer: string): { text: string; rest: string; done: boolean } {
    let text = '';
    let done = false;
    const parts = buffer.split('\n\n');
    const rest = parts.pop() ?? '';
    for (const part of parts) {
        for (const rawLine of part.split('\n')) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
                done = true;
                continue;
            }
            try {
                const json = JSON.parse(data);
                const delta = json?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') text += delta;
            } catch {
                /* malformed event — skip */
            }
        }
    }
    return { text, rest, done };
}

// ── Inner runtime + thread (remounts on "新对话") ────────────────────────

function ChatThread({
    modelRef,
    webSearchRef,
    canAttach,
}: {
    modelRef: React.RefObject<string>;
    webSearchRef: React.RefObject<boolean>;
    canAttach: boolean;
}) {
    const attachmentAdapter = useMemo(() => new SimpleImageAttachmentAdapter(), []);

    const adapter = useMemo<ChatModelAdapter>(
        () => ({
            async *run({ messages, abortSignal }) {
                // Surface errors as a visible assistant bubble (⚠️ …) rather than
                // throwing — a thrown run error renders an empty bubble in prod
                // (assistant-ui needs ErrorPrimitive wiring we don't have). A
                // user-initiated abort (停止) must still propagate so the runtime
                // keeps the partial content, so we re-throw AbortError only.
                let res: Response;
                try {
                    res = await fetch('/api/portal/chat/stream', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal: abortSignal,
                        body: JSON.stringify({
                            model: modelRef.current,
                            web_search: webSearchRef.current,
                            messages: toOpenAIMessages(messages),
                        }),
                    });
                } catch (err) {
                    if (err instanceof DOMException && err.name === 'AbortError') throw err;
                    yield { content: [{ type: 'text' as const, text: '⚠️ 网络连接失败,请稍后重试' }] };
                    return;
                }

                if (!res.ok || !res.body) {
                    let msg = `请求失败 (${res.status})`;
                    try {
                        const j = await res.json();
                        msg = j?.message || j?.detail?.error?.message || j?.error || msg;
                    } catch {
                        /* non-JSON */
                    }
                    yield { content: [{ type: 'text' as const, text: `⚠️ ${msg}` }] };
                    return;
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let acc = '';
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const { text, rest, done: sseDone } = drainSse(buffer);
                    buffer = rest;
                    if (text) {
                        acc += text;
                        yield { content: [{ type: 'text' as const, text: acc }] };
                    }
                    if (sseDone) break;
                }
                if (acc.trim() === '') {
                    yield { content: [{ type: 'text' as const, text: '_(无返回内容)_' }] };
                }
            },
        }),
        [modelRef, webSearchRef],
    );

    const runtime = useLocalRuntime(adapter, { adapters: { attachments: attachmentAdapter } });

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <ThreadPrimitive.Root className="flex flex-1 flex-col overflow-hidden">
                <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
                    <ThreadPrimitive.Empty>
                        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-ink">
                            <p className="m-0 text-base font-medium text-navy">开始对话</p>
                            <p className="m-0 max-w-sm text-sm">选择上方模型,输入消息即可。对话不会保存,刷新后清空。</p>
                        </div>
                    </ThreadPrimitive.Empty>
                    <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
                </ThreadPrimitive.Viewport>
                <Composer canAttach={canAttach} />
            </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
    );
}

// ── Message renderers ──────────────────────────────────────────────────

function UserMessage() {
    return (
        <MessagePrimitive.Root className="flex justify-end">
            <div className="max-w-[85%] rounded-xl bg-navy px-3.5 py-2.5 text-sm text-paper">
                <MessagePrimitive.Attachments
                    components={{ Image: MessageImageThumb, Attachment: MessageAttachmentChip }}
                />
                <div className="whitespace-pre-wrap break-words">
                    <MessagePrimitive.Parts />
                </div>
            </div>
        </MessagePrimitive.Root>
    );
}

function AssistantMessage() {
    return (
        <MessagePrimitive.Root className="group flex flex-col items-start gap-1">
            <div className="max-w-[85%] rounded-xl border border-brand-border bg-paper-muted px-3.5 py-2.5 text-sm text-ink">
                <MessagePrimitive.Parts components={{ Text: AssistantMarkdown }} />
            </div>
            <ActionBarPrimitive.Root
                hideWhenRunning
                autohide="not-last"
                className="ml-1 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100"
            >
                <ActionBarPrimitive.Copy className="text-[11px] text-minor-ink hover:text-navy cursor-pointer">
                    复制
                </ActionBarPrimitive.Copy>
            </ActionBarPrimitive.Root>
        </MessagePrimitive.Root>
    );
}

/** Image attachment thumbnail inside a sent user message. */
function MessageImageThumb() {
    return (
        <AttachmentPrimitive.Root className="mb-2 inline-block overflow-hidden rounded-lg border border-white/20">
            <AttachmentPrimitive.unstable_Thumb className="max-h-40 max-w-[220px] object-cover" />
        </AttachmentPrimitive.Root>
    );
}

/** Non-image attachment fallback chip. */
function MessageAttachmentChip() {
    return (
        <AttachmentPrimitive.Root className="mb-2 inline-flex items-center gap-1 rounded bg-white/15 px-2 py-1 text-xs">
            <AttachmentPrimitive.Name />
        </AttachmentPrimitive.Root>
    );
}

// ── Composer ───────────────────────────────────────────────────────────

function Composer({ canAttach }: { canAttach: boolean }) {
    return (
        <div className="border-t border-brand-border bg-paper px-3 py-3">
            <ComposerPrimitive.Attachments
                components={{ Image: ComposerImageThumb, Attachment: ComposerAttachmentChip }}
            />
            <ComposerPrimitive.Root className="flex items-end gap-2">
                {canAttach && (
                    <ComposerPrimitive.AddAttachment
                        className="shrink-0 rounded-lg border border-brand-border px-2.5 py-2 text-base text-muted-ink transition-colors hover:bg-paper-muted hover:text-navy cursor-pointer"
                        aria-label="上传图片"
                    >
                        🖼
                    </ComposerPrimitive.AddAttachment>
                )}
                <ComposerPrimitive.Input
                    autoFocus
                    rows={1}
                    placeholder="输入消息,Enter 发送,Shift+Enter 换行"
                    className="max-h-40 min-h-[40px] flex-1 resize-none rounded-lg border border-brand-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-minor-ink focus:border-brand-accent focus:outline-none"
                />
                <ThreadPrimitive.If running={false}>
                    <ComposerPrimitive.Send className="shrink-0 rounded-lg bg-navy px-4 py-2 text-sm text-paper transition-colors hover:bg-navy-strong disabled:cursor-not-allowed disabled:bg-paper-muted disabled:text-minor-ink/60 cursor-pointer">
                        发送
                    </ComposerPrimitive.Send>
                </ThreadPrimitive.If>
                <ThreadPrimitive.If running>
                    <ComposerPrimitive.Cancel className="shrink-0 rounded-lg border border-brand-border px-4 py-2 text-sm text-muted-ink transition-colors hover:bg-paper-muted hover:text-navy cursor-pointer">
                        停止
                    </ComposerPrimitive.Cancel>
                </ThreadPrimitive.If>
            </ComposerPrimitive.Root>
        </div>
    );
}

function ComposerImageThumb() {
    return (
        <AttachmentPrimitive.Root className="relative mb-2 mr-2 inline-block overflow-hidden rounded-lg border border-brand-border">
            <AttachmentPrimitive.unstable_Thumb className="max-h-24 max-w-[140px] object-cover" />
            <AttachmentPrimitive.Remove
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-navy/70 text-[11px] text-paper hover:bg-navy cursor-pointer"
                aria-label="移除"
            >
                ✕
            </AttachmentPrimitive.Remove>
        </AttachmentPrimitive.Root>
    );
}

function ComposerAttachmentChip() {
    return (
        <AttachmentPrimitive.Root className="mb-2 mr-2 inline-flex items-center gap-1 rounded border border-brand-border bg-paper-muted px-2 py-1 text-xs text-muted-ink">
            <AttachmentPrimitive.Name />
            <AttachmentPrimitive.Remove className="text-minor-ink hover:text-navy cursor-pointer" aria-label="移除">
                ✕
            </AttachmentPrimitive.Remove>
        </AttachmentPrimitive.Root>
    );
}

// ── Outer console: toolbar (picker + web search + new chat) + thread ────

export function ChatConsole({ groups, modelIds }: ChatConsoleProps) {
    const [model, setModel] = useState(modelIds[0] ?? '');
    const [webSearch, setWebSearch] = useState(false);
    const [resetKey, setResetKey] = useState(0);

    // Latest model / web-search flag for the headless adapter to read at send.
    // Synced in an effect (not during render) — the adapter only reads these
    // on a user send, which always happens after effects have flushed.
    const modelRef = useRef(model);
    const webSearchRef = useRef(webSearch);
    useEffect(() => {
        modelRef.current = model;
        webSearchRef.current = webSearch;
    }, [model, webSearch]);

    // Vision lookup: gate the image-upload button to image-capable models.
    const visionById = useMemo(() => {
        const map = new Map<string, boolean>();
        for (const g of groups) for (const m of g.models) map.set(m.id, m.vision);
        return map;
    }, [groups]);
    const canAttach = visionById.get(model) ?? false;

    return (
        <div className="flex h-[calc(100vh-220px)] min-h-[460px] flex-col overflow-hidden rounded-xl border border-brand-border bg-surface">
            {/* Toolbar */}
            <div className="flex items-center justify-between gap-3 border-b border-brand-border bg-paper px-4 py-2.5">
                <div className="flex items-center gap-2">
                    <ModelPicker groups={groups} value={model} onChange={setModel} />
                    <WebSearchToggle on={webSearch} onToggle={() => setWebSearch((v) => !v)} />
                </div>
                <button
                    type="button"
                    onClick={() => setResetKey((k) => k + 1)}
                    className="rounded-lg border border-brand-border px-3 py-1.5 text-sm text-muted-ink transition-colors hover:bg-paper-muted hover:text-navy cursor-pointer"
                >
                    新对话
                </button>
            </div>

            {/* Runtime + thread — `key` remounts a fresh (empty) runtime on 新对话 */}
            <ChatThread key={resetKey} modelRef={modelRef} webSearchRef={webSearchRef} canAttach={canAttach} />
        </div>
    );
}

function WebSearchToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            onClick={onToggle}
            title="联网搜索:开启后会先检索网络再回答(需 operator 开通搜索服务)"
            aria-pressed={on}
            className={[
                'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm transition-colors duration-150',
                on
                    ? 'border-brand-accent bg-brand-accent/10 text-navy'
                    : 'border-brand-border text-muted-ink hover:bg-paper-muted hover:text-navy',
                'cursor-pointer',
            ].join(' ')}
        >
            <span aria-hidden>🌐</span>
            <span className="hidden sm:inline">联网</span>
        </button>
    );
}

/** Vendor-grouped model dropdown (ported from v1; now flags vision models). */
/** Compact price-multiplier label: 2 → "2", 2.4615 → "2.5". */
function formatMultiplier(m: number): string {
    return m % 1 === 0 ? String(m) : m.toFixed(1);
}

function ModelPicker({
    groups,
    value,
    onChange,
}: {
    groups: ChatModelGroup[];
    value: string;
    onChange: (id: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    const close = useCallback(() => setOpen(false), []);
    const onRootBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
    }, []);

    const currentModel = useMemo(() => groups.flatMap((g) => g.models).find((m) => m.id === value), [groups, value]);
    const currentPremium = (currentModel?.priceMultiplier ?? 1) > 1.05;

    return (
        <div ref={rootRef} onBlur={onRootBlur} className="relative">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="flex items-center gap-2 rounded-lg border border-brand-border bg-surface px-3 py-1.5 text-sm text-navy transition-colors hover:bg-paper-muted cursor-pointer"
            >
                <span className="max-w-[220px] truncate font-mono font-medium">{value || '选择模型'}</span>
                {currentModel?.vendor && (
                    <span className="hidden text-[11px] text-minor-ink sm:inline">· {currentModel.vendor}</span>
                )}
                {currentPremium && currentModel?.priceMultiplier != null && (
                    <span
                        title={`官方稳定渠道,计费约为普通池的 ${formatMultiplier(currentModel.priceMultiplier)} 倍`}
                        className="rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200"
                    >
                        官方 {formatMultiplier(currentModel.priceMultiplier)}×
                    </span>
                )}
                <span aria-hidden className="text-minor-ink">
                    ▾
                </span>
            </button>

            {open && (
                <div className="absolute left-0 top-full z-50 mt-1 max-h-[60vh] w-[320px] overflow-y-auto rounded-xl border border-brand-border bg-surface py-1 shadow-lg">
                    {groups.length === 0 ? (
                        <p className="m-0 px-3 py-2 text-sm text-muted-ink">暂无可用模型</p>
                    ) : (
                        groups.map((g) => (
                            <div key={g.vendor}>
                                <p className="m-0 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-minor-ink">
                                    {g.vendor}
                                </p>
                                {g.models.map((m) => (
                                    <button
                                        key={m.id}
                                        type="button"
                                        onClick={() => {
                                            onChange(m.id);
                                            close();
                                        }}
                                        className={[
                                            'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-sm break-all',
                                            'transition-colors duration-150 cursor-pointer',
                                            m.id === value
                                                ? 'bg-paper-muted font-medium text-navy'
                                                : 'text-muted-ink hover:bg-paper-muted/60 hover:text-navy',
                                        ].join(' ')}
                                    >
                                        <span className="truncate">{m.id}</span>
                                        <span className="flex shrink-0 items-center gap-1">
                                            {m.priceMultiplier != null && m.priceMultiplier > 1.05 && (
                                                <span
                                                    title={`官方稳定渠道,计费约为普通池的 ${formatMultiplier(m.priceMultiplier)} 倍`}
                                                    className="rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200"
                                                >
                                                    官方 {formatMultiplier(m.priceMultiplier)}×
                                                </span>
                                            )}
                                            {m.vision && (
                                                <span className="rounded bg-brand-accent/15 px-1 text-[10px] text-brand-accent">
                                                    视觉
                                                </span>
                                            )}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
