'use client';

import { useCallback, useEffect, useState } from 'react';

type Mode = 'text' | 'edit';
const ASPECTS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2'];

function buildBody(model: string, mode: Mode, prompt: string, aspect: string, n: number, image: string): string {
    const b: Record<string, unknown> = { model, prompt };
    if (aspect && aspect !== 'auto') b.aspect_ratio = aspect;
    if (n > 1) b.n = n;
    if (mode === 'edit' && image) b.image = image;
    return JSON.stringify(b, null, 2);
}

export function ImageTool() {
    const [key, setKey] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [models, setModels] = useState<string[]>([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [model, setModel] = useState('');
    const [mode, setMode] = useState<Mode>('text');
    const [prompt, setPrompt] = useState('');
    const [aspect, setAspect] = useState('1:1');
    const [n, setN] = useState(1);
    const [image, setImage] = useState('');
    const [bodyJson, setBodyJson] = useState('');
    const [busy, setBusy] = useState(false);
    const [imgs, setImgs] = useState<string[]>([]);
    const [raw, setRaw] = useState('');
    const [err, setErr] = useState('');

    useEffect(() => {
        if (model) setBodyJson(buildBody(model, mode, prompt, aspect, n, image));
    }, [model, mode, prompt, aspect, n, image]);

    const loadModels = useCallback(async () => {
        setErr('');
        setLoadingModels(true);
        try {
            const r = await fetch('/api/tools/image/models', { headers: { Authorization: `Bearer ${key.trim()}` } });
            const j = await r.json();
            if (!r.ok) throw new Error(j?.error?.message || j?.error || '加载失败');
            const ms: string[] = j.models || [];
            if (!ms.length) throw new Error('这把 key 下没有可用的生图模型');
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

    const onUpload = useCallback((f: File | undefined) => {
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => setImage(String(reader.result || ''));
        reader.readAsDataURL(f);
    }, []);

    const generate = useCallback(async () => {
        if (busy || !model || !prompt.trim()) return;
        setErr('');
        setImgs([]);
        setRaw('');
        setBusy(true);
        try {
            const r = await fetch('/api/tools/image/generate', {
                method: 'POST',
                headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' },
                body: bodyJson,
            });
            const text = await r.text();
            setRaw(text);
            let j: unknown;
            try {
                j = JSON.parse(text);
            } catch {
                throw new Error(`返回非 JSON (${r.status})`);
            }
            if (!r.ok) {
                const e = j as { error?: { message?: string } | string; message?: string };
                throw new Error(
                    (typeof e.error === 'string' ? e.error : e.error?.message) || e.message || `请求失败 (${r.status})`,
                );
            }
            const data = (j as { data?: Array<{ url?: string; b64_json?: string }> }).data || [];
            const urls = data
                .map((d) => d.url || (d.b64_json ? `data:image/png;base64,${d.b64_json}` : ''))
                .filter(Boolean);
            if (!urls.length) throw new Error('返回里没有图片(见下方原始响应)');
            setImgs(urls);
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
        } finally {
            setBusy(false);
        }
    }, [busy, model, prompt, bodyJson, key]);

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
                    {/* 模型 + 模式 */}
                    <div className="rounded-lg border border-brand-border bg-surface p-4 space-y-3">
                        <div className="flex items-center gap-3 flex-wrap">
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
                        </div>
                        <div className="flex gap-2">
                            {(['text', 'edit'] as Mode[]).map((m) => (
                                <button
                                    key={m}
                                    onClick={() => setMode(m)}
                                    className={`rounded-full px-4 py-1.5 text-sm border ${
                                        mode === m
                                            ? 'bg-brand-accent text-white border-brand-accent'
                                            : 'border-brand-border text-muted-ink'
                                    }`}
                                >
                                    {m === 'text' ? '文生图' : '图生图'}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 参数 */}
                    <div className="rounded-lg border border-brand-border bg-surface p-4 space-y-3">
                        <div>
                            <label className="block text-sm font-medium text-navy mb-1">提示词</label>
                            <textarea
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                                rows={3}
                                placeholder="描述你想生成 / 修改的图片"
                                className="w-full rounded border border-brand-border bg-paper px-3 py-2 text-sm"
                            />
                        </div>
                        <div className="flex items-center gap-4 flex-wrap">
                            <div className="flex items-center gap-2">
                                <label className="text-sm font-medium text-navy">比例</label>
                                <select
                                    value={aspect}
                                    onChange={(e) => setAspect(e.target.value)}
                                    className="rounded border border-brand-border bg-paper px-2 py-1.5 text-sm"
                                >
                                    {ASPECTS.map((a) => (
                                        <option key={a} value={a}>
                                            {a}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex items-center gap-2">
                                <label className="text-sm font-medium text-navy">数量</label>
                                <input
                                    type="number"
                                    min={1}
                                    max={4}
                                    value={n}
                                    onChange={(e) => setN(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
                                    className="w-16 rounded border border-brand-border bg-paper px-2 py-1.5 text-sm"
                                />
                                <span className="text-xs text-minor-ink">Gemini 系单次出 1 张</span>
                            </div>
                        </div>
                        {mode === 'edit' && (
                            <div>
                                <label className="block text-sm font-medium text-navy mb-1">参考图(图生图)</label>
                                <input
                                    type="file"
                                    accept="image/*"
                                    onChange={(e) => onUpload(e.target.files?.[0])}
                                    className="text-sm"
                                />
                                {image && (
                                    <img
                                        src={image}
                                        alt="ref"
                                        className="mt-2 max-h-32 rounded border border-brand-border"
                                    />
                                )}
                            </div>
                        )}
                    </div>

                    {/* JSON */}
                    <div className="rounded-lg border border-brand-border bg-surface p-4">
                        <label className="block text-sm font-medium text-navy mb-1">请求 JSON(可手动改)</label>
                        <textarea
                            value={bodyJson}
                            onChange={(e) => setBodyJson(e.target.value)}
                            rows={6}
                            className="w-full rounded border border-brand-border bg-paper px-3 py-2 text-xs font-mono"
                        />
                    </div>

                    <button
                        onClick={generate}
                        disabled={busy || !prompt.trim()}
                        className="rounded bg-brand-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                        {busy ? '生成中…' : '生成图片'}
                    </button>

                    {imgs.length > 0 && (
                        <div className="grid grid-cols-2 gap-3">
                            {imgs.map((u, i) => (
                                <a key={i} href={u} target="_blank" rel="noreferrer">
                                    <img
                                        src={u}
                                        alt={`result ${i + 1}`}
                                        className="w-full rounded-lg border border-brand-border"
                                    />
                                </a>
                            ))}
                        </div>
                    )}

                    {raw && (
                        <details className="rounded-lg border border-brand-border bg-surface p-3 text-xs">
                            <summary className="cursor-pointer text-muted-ink">原始响应</summary>
                            <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-minor-ink">{raw}</pre>
                        </details>
                    )}
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
