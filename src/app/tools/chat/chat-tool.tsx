'use client';

import { useCallback, useRef, useState } from 'react';

type Msg = { role: 'user' | 'assistant'; content: string };

export function ChatTool() {
    const [key, setKey] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [models, setModels] = useState<string[]>([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [model, setModel] = useState('');
    const [msgs, setMsgs] = useState<Msg[]>([]);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const [err, setErr] = useState('');
    const boxRef = useRef<HTMLDivElement>(null);

    const loadModels = useCallback(async () => {
        setErr('');
        setLoadingModels(true);
        try {
            const r = await fetch('/api/tools/chat/models', { headers: { Authorization: `Bearer ${key.trim()}` } });
            const j = await r.json();
            if (!r.ok) throw new Error(j?.error?.message || j?.error || '加载失败');
            const ms: string[] = j.models || [];
            if (!ms.length) throw new Error('这把 key 下没有可用的对话模型');
            setModels(ms);
            setModel(ms[0]);
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
            setModels([]);
            setModel('');
        } finally {
            setLoadingModels(false);
        }
    }, [key]);

    const send = useCallback(async () => {
        const text = input.trim();
        if (!text || sending || !model) return;
        setErr('');
        const next: Msg[] = [...msgs, { role: 'user', content: text }];
        setMsgs([...next, { role: 'assistant', content: '' }]);
        setInput('');
        setSending(true);
        try {
            const r = await fetch('/api/tools/chat/stream', {
                method: 'POST',
                headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, messages: next, stream: true }),
            });
            if (!r.ok || !r.body) {
                const j = await r.json().catch(() => ({}));
                throw new Error(j?.error?.message || j?.message || j?.error || `请求失败 (${r.status})`);
            }
            const reader = r.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            let acc = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const line of lines) {
                    const s = line.trim();
                    if (!s.startsWith('data:')) continue;
                    const data = s.slice(5).trim();
                    if (!data || data === '[DONE]') continue;
                    try {
                        const j = JSON.parse(data);
                        const delta = j?.choices?.[0]?.delta?.content;
                        if (typeof delta === 'string') {
                            acc += delta;
                            setMsgs((m) => {
                                const c = [...m];
                                c[c.length - 1] = { role: 'assistant', content: acc };
                                return c;
                            });
                            boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
                        }
                    } catch {
                        /* 非 JSON data 行忽略 */
                    }
                }
            }
            if (!acc) {
                setErr('未收到内容(可能模型不对或参数问题)');
                setMsgs((m) => m.slice(0, -1));
            }
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
            setMsgs((m) =>
                m.length && m[m.length - 1].role === 'assistant' && !m[m.length - 1].content ? m.slice(0, -1) : m,
            );
        } finally {
            setSending(false);
        }
    }, [input, sending, model, msgs, key]);

    return (
        <div className="space-y-5">
            {/* Key */}
            <div className="rounded-lg border border-brand-border bg-surface p-4">
                <label className="block text-sm font-medium text-navy mb-1">你的 API Key</label>
                <div className="flex gap-2">
                    <input
                        type={showKey ? 'text' : 'password'}
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                        placeholder="sk-..."
                        className="flex-1 rounded border border-brand-border bg-paper px-3 py-2 text-sm font-mono"
                    />
                    <button
                        onClick={() => setShowKey((s) => !s)}
                        className="rounded border border-brand-border px-3 text-sm text-muted-ink"
                    >
                        {showKey ? '隐藏' : '显示'}
                    </button>
                    <button
                        onClick={loadModels}
                        disabled={!key.trim() || loadingModels}
                        className="rounded bg-brand-accent px-4 text-sm font-medium text-white disabled:opacity-50"
                    >
                        {loadingModels ? '加载中…' : '加载模型'}
                    </button>
                </div>
                <p className="m-0 mt-2 text-xs text-minor-ink">
                    Key 只用于本次调用、不保存。在「API 密钥」页用复制按钮取。
                </p>
            </div>

            {models.length > 0 && (
                <>
                    <div className="rounded-lg border border-brand-border bg-surface p-4 flex items-center gap-3 flex-wrap">
                        <label className="text-sm font-medium text-navy">模型</label>
                        <select
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            className="rounded border border-brand-border bg-paper px-3 py-2 text-sm font-mono flex-1 min-w-48"
                        >
                            {models.map((id) => (
                                <option key={id} value={id}>
                                    {id}
                                </option>
                            ))}
                        </select>
                        <button
                            onClick={() => setMsgs([])}
                            className="rounded border border-brand-border px-3 py-2 text-sm text-muted-ink"
                        >
                            新对话
                        </button>
                    </div>

                    {/* 对话区 */}
                    <div
                        ref={boxRef}
                        className="rounded-lg border border-brand-border bg-surface p-4 min-h-40 max-h-[480px] overflow-auto space-y-3"
                    >
                        {msgs.length === 0 && <p className="m-0 text-sm text-minor-ink">下方输入消息开始对话。</p>}
                        {msgs.map((m, i) => (
                            <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
                                <div
                                    className={`inline-block rounded-lg px-3 py-2 text-sm whitespace-pre-wrap text-left max-w-[85%] ${
                                        m.role === 'user'
                                            ? 'bg-brand-accent text-white'
                                            : 'bg-paper border border-brand-border text-ink'
                                    }`}
                                >
                                    {m.content || (sending && i === msgs.length - 1 ? '…' : '')}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* 输入 */}
                    <div className="rounded-lg border border-brand-border bg-surface p-4">
                        <textarea
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    send();
                                }
                            }}
                            rows={2}
                            placeholder="输入消息,Enter 发送 / Shift+Enter 换行"
                            className="w-full rounded border border-brand-border bg-paper px-3 py-2 text-sm"
                        />
                        <button
                            onClick={send}
                            disabled={sending || !input.trim()}
                            className="mt-2 rounded bg-brand-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
                        >
                            {sending ? '生成中…' : '发送'}
                        </button>
                    </div>
                </>
            )}

            {err && (
                <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 whitespace-pre-wrap">
                    {err}
                </div>
            )}
        </div>
    );
}
