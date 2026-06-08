'use client';

/**
 * Chat UI v1 — stateless chat console (client island).
 *
 * Everything here is in-memory: the `messages` array lives in React
 * state and is gone on refresh. No persistence, no schema. Each send
 * POSTs the *full* current transcript to /api/portal/chat/stream and
 * reads the SSE reply token-by-token. "新对话" just clears state.
 *
 * The server proxy resolves the customer's system token, so the browser
 * never sees an sk-… key.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from './markdown';
import type { ChatModelGroup } from '@/lib/chat/models';

interface Message {
    role: 'user' | 'assistant';
    content: string;
}

interface ChatConsoleProps {
    groups: ChatModelGroup[];
    /** Flat id list — first entry is the default selection. */
    modelIds: string[];
}

/** Parse the OpenAI-style SSE chunk buffer, returning concatenated delta
 *  text plus the remaining (incomplete) buffer tail. */
function drainSse(buffer: string): { text: string; rest: string; done: boolean } {
    let text = '';
    let done = false;
    const parts = buffer.split('\n\n');
    const rest = parts.pop() ?? ''; // last element is a possibly-incomplete event
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
                /* keep partial JSON in the next pass — but since we only
                 * split on complete \n\n boundaries, a parse failure here
                 * means a genuinely malformed event; skip it. */
            }
        }
    }
    return { text, rest, done };
}

export function ChatConsole({ groups, modelIds }: ChatConsoleProps) {
    const [model, setModel] = useState(modelIds[0] ?? '');
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [streaming, setStreaming] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const abortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    // Auto-scroll to bottom as content streams in.
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [messages, streaming]);

    const canSend = input.trim().length > 0 && !streaming && model !== '';

    const send = useCallback(async () => {
        const text = input.trim();
        if (!text || streaming || !model) return;

        setError(null);
        const nextMessages: Message[] = [...messages, { role: 'user', content: text }];
        setMessages(nextMessages);
        setInput('');
        setStreaming(true);

        // Placeholder assistant message we stream into.
        setMessages((m) => [...m, { role: 'assistant', content: '' }]);

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const res = await fetch('/api/portal/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, messages: nextMessages }),
                signal: controller.signal,
            });

            if (!res.ok || !res.body) {
                let msg = `请求失败 (${res.status})`;
                try {
                    const j = await res.json();
                    msg = j?.message || j?.detail?.error?.message || j?.error || msg;
                } catch {
                    /* non-JSON */
                }
                throw new Error(msg);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let acc = '';

            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const { text: chunk, rest, done: sseDone } = drainSse(buffer);
                buffer = rest;
                if (chunk) {
                    acc += chunk;
                    setMessages((m) => {
                        const copy = m.slice();
                        copy[copy.length - 1] = { role: 'assistant', content: acc };
                        return copy;
                    });
                }
                if (sseDone) break;
            }

            // If upstream sent nothing usable, surface a gentle note.
            if (acc.trim() === '') {
                setMessages((m) => {
                    const copy = m.slice();
                    copy[copy.length - 1] = { role: 'assistant', content: '_(无返回内容)_' };
                    return copy;
                });
            }
        } catch (err) {
            const aborted = err instanceof DOMException && err.name === 'AbortError';
            if (!aborted) {
                const msg = err instanceof Error ? err.message : '对话出错,请重试';
                setError(msg);
            }
            // Drop the empty/partial assistant placeholder on hard error so
            // we don't leave a blank bubble (keep partial content on abort).
            setMessages((m) => {
                const last = m[m.length - 1];
                if (last?.role === 'assistant' && last.content === '') return m.slice(0, -1);
                return m;
            });
        } finally {
            setStreaming(false);
            abortRef.current = null;
            textareaRef.current?.focus();
        }
    }, [input, streaming, model, messages]);

    function stop() {
        abortRef.current?.abort();
    }

    function newConversation() {
        abortRef.current?.abort();
        setMessages([]);
        setInput('');
        setError(null);
        textareaRef.current?.focus();
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
        }
    }

    return (
        <div className="flex flex-col h-[calc(100vh-220px)] min-h-[420px] border border-brand-border rounded-xl bg-surface overflow-hidden">
            {/* Toolbar: model picker + new conversation */}
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-brand-border bg-paper">
                <ModelPicker groups={groups} value={model} onChange={setModel} disabled={streaming} />
                <button
                    type="button"
                    onClick={newConversation}
                    disabled={messages.length === 0 && !streaming}
                    className={[
                        'text-sm px-3 py-1.5 rounded-lg border transition-colors duration-150 ease-brand',
                        messages.length === 0 && !streaming
                            ? 'border-brand-border text-minor-ink/60 cursor-not-allowed'
                            : 'border-brand-border text-muted-ink hover:text-navy hover:bg-paper-muted cursor-pointer',
                    ].join(' ')}
                >
                    新对话
                </button>
            </div>

            {/* Message scroll area */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
                {messages.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 text-muted-ink">
                        <p className="m-0 text-base font-medium text-navy">开始对话</p>
                        <p className="m-0 text-sm max-w-sm">选择上方模型,输入消息即可。对话不会保存,刷新后清空。</p>
                    </div>
                ) : (
                    messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)
                )}
            </div>

            {/* Error banner */}
            {error && (
                <div className="px-4 py-2 text-sm text-status-error-text bg-status-error-bg border-t border-status-error-border">
                    {error}
                </div>
            )}

            {/* Composer */}
            <div className="border-t border-brand-border bg-paper px-3 py-3">
                <div className="flex items-end gap-2">
                    <textarea
                        ref={textareaRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={onKeyDown}
                        rows={1}
                        placeholder="输入消息,Enter 发送,Shift+Enter 换行"
                        className="flex-1 resize-none max-h-40 min-h-[40px] px-3 py-2 text-sm rounded-lg border border-brand-border bg-surface text-ink placeholder:text-minor-ink focus:outline-none focus:border-brand-accent"
                    />
                    {streaming ? (
                        <button
                            type="button"
                            onClick={stop}
                            className="shrink-0 px-4 py-2 text-sm rounded-lg border border-brand-border text-muted-ink hover:text-navy hover:bg-paper-muted transition-colors duration-150 ease-brand cursor-pointer"
                        >
                            停止
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={() => void send()}
                            disabled={!canSend}
                            className={[
                                'shrink-0 px-4 py-2 text-sm rounded-lg transition-colors duration-150 ease-brand',
                                canSend
                                    ? 'bg-navy text-paper hover:bg-navy-strong cursor-pointer'
                                    : 'bg-paper-muted text-minor-ink/60 cursor-not-allowed',
                            ].join(' ')}
                        >
                            发送
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

function MessageBubble({ msg }: { msg: Message }) {
    const isUser = msg.role === 'user';
    return (
        <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div
                className={[
                    'max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm',
                    isUser
                        ? 'bg-navy text-paper whitespace-pre-wrap break-words'
                        : 'bg-paper-muted text-ink border border-brand-border',
                ].join(' ')}
            >
                {isUser ? (
                    msg.content
                ) : msg.content === '' ? (
                    <span className="inline-flex items-center gap-1 text-muted-ink">
                        <span className="animate-pulse">●</span> 思考中…
                    </span>
                ) : (
                    <Markdown content={msg.content} />
                )}
            </div>
        </div>
    );
}

/** Vendor-grouped model dropdown. Custom (not <select>) so we can show
 *  vendor sub-headers like the reference design. */
function ModelPicker({
    groups,
    value,
    onChange,
    disabled,
}: {
    groups: ChatModelGroup[];
    value: string;
    onChange: (id: string) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        function onDoc(e: MouseEvent) {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        }
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    const currentVendor = useMemo(
        () => groups.find((g) => g.models.some((m) => m.id === value))?.vendor,
        [groups, value],
    );

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                onClick={() => !disabled && setOpen((o) => !o)}
                disabled={disabled}
                className={[
                    'flex items-center gap-2 px-3 py-1.5 rounded-lg border border-brand-border text-sm',
                    'bg-surface transition-colors duration-150 ease-brand',
                    disabled ? 'text-minor-ink/60 cursor-not-allowed' : 'text-navy hover:bg-paper-muted cursor-pointer',
                ].join(' ')}
            >
                <span className="font-mono font-medium truncate max-w-[240px]">{value || '选择模型'}</span>
                {currentVendor && (
                    <span className="text-[11px] text-minor-ink hidden sm:inline">· {currentVendor}</span>
                )}
                <span aria-hidden className="text-minor-ink">
                    ▾
                </span>
            </button>

            {open && (
                <div className="absolute left-0 top-full mt-1 z-50 w-[300px] max-h-[60vh] overflow-y-auto rounded-xl border border-brand-border bg-surface shadow-lg py-1">
                    {groups.length === 0 ? (
                        <p className="m-0 px-3 py-2 text-sm text-muted-ink">暂无可用模型</p>
                    ) : (
                        groups.map((g) => (
                            <div key={g.vendor}>
                                <p className="m-0 px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-minor-ink">
                                    {g.vendor}
                                </p>
                                {g.models.map((m) => (
                                    <button
                                        key={m.id}
                                        type="button"
                                        onClick={() => {
                                            onChange(m.id);
                                            setOpen(false);
                                        }}
                                        className={[
                                            'block w-full text-left px-3 py-1.5 text-sm font-mono break-all',
                                            'transition-colors duration-150 ease-brand cursor-pointer',
                                            m.id === value
                                                ? 'bg-paper-muted text-navy font-medium'
                                                : 'text-muted-ink hover:bg-paper-muted/60 hover:text-navy',
                                        ].join(' ')}
                                    >
                                        {m.id}
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
