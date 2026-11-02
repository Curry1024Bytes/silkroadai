'use client';

import { useCallback, useEffect, useState } from 'react';
import { useMessages } from '@/lib/i18n/client';
import { toolsMessages } from '@/lib/i18n/messages/tools';

type ImageToolMessages = (typeof toolsMessages)['zh']['image'];

type Mode = 'text' | 'edit';
type TaskStatus = 'IDLE' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILURE';
const ASPECTS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2'];
const LAST_TASK_STORAGE_KEY = 'llmroute:image-tool:last-task';

/** 分辨率(size)选项按模型给 —— gpt-image / dall-e 用 WxH,Gemini 生图用 1K/2K/4K 档。
 *  用错格式会被上游 400,所以 model 变了就重置 size(见 ImageTool)。 */
type SizeOpt = { v: string; label: string };
function sizeOptionsFor(model: string, t: ImageToolMessages): SizeOpt[] {
    const m = model.toLowerCase();
    if (m.includes('gpt-image') || m.includes('dall-e') || m.includes('dalle')) {
        return [
            { v: '', label: t.sizeDefault },
            { v: '1024x1024', label: t.sizeSquare },
            { v: '1536x1024', label: t.sizeLandscape },
            { v: '1024x1536', label: t.sizePortrait },
        ];
    }
    // Gemini 生图:1K/2K/4K(pro 可自选;其余模型固定档时该参数被上游忽略,无害)
    return [
        { v: '', label: t.sizeDefault },
        { v: '1K', label: '1K (1024)' },
        { v: '2K', label: '2K (2048)' },
        { v: '4K', label: '4K (4096)' },
    ];
}

function buildBody(
    model: string,
    mode: Mode,
    prompt: string,
    aspect: string,
    size: string,
    n: number,
    image: string,
): string {
    const b: Record<string, unknown> = { model, prompt };
    // GPT 图片的像素尺寸已经决定画幅;同时传相反的比例会被代理层改成另一个尺寸。
    if (aspect && aspect !== 'auto' && !(model.toLowerCase().includes('gpt-image') && size)) {
        b.aspect_ratio = aspect;
    }
    if (size) b.size = size;
    if (n > 1) b.n = n;
    if (mode === 'edit' && image) b.image = image;
    return JSON.stringify(b, null, 2);
}

export function ImageTool() {
    const m = useMessages(toolsMessages);
    const [key, setKey] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [models, setModels] = useState<string[]>([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [model, setModel] = useState('');
    const [mode, setMode] = useState<Mode>('text');
    const [prompt, setPrompt] = useState('');
    const [aspect, setAspect] = useState('1:1');
    const [size, setSize] = useState('');
    const [n, setN] = useState(1);
    const [image, setImage] = useState('');
    const [bodyJson, setBodyJson] = useState('');
    const [busy, setBusy] = useState(false);
    const [imgs, setImgs] = useState<string[]>([]);
    const [raw, setRaw] = useState('');
    const [err, setErr] = useState('');
    const [taskId, setTaskId] = useState('');
    const [taskStatus, setTaskStatus] = useState<TaskStatus>('IDLE');

    useEffect(() => {
        try {
            const saved = window.localStorage.getItem(LAST_TASK_STORAGE_KEY) || '';
            if (/^[0-9a-f]{32}$/.test(saved)) {
                setTaskId(saved);
                setTaskStatus('IN_PROGRESS');
            }
        } catch {
            // 浏览器禁用存储时仍可在当前页面按任务号轮询。
        }
    }, []);

    useEffect(() => {
        if (!taskId || !key.trim()) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let stopped = false;
        const poll = async () => {
            try {
                const r = await fetch(`/api/tools/image/generate?task_id=${taskId}`, {
                    headers: { Authorization: `Bearer ${key.trim()}` },
                    cache: 'no-store',
                    signal: controller.signal,
                });
                const text = await r.text();
                const j = JSON.parse(text) as {
                    code?: string;
                    message?: string;
                    error?: { message?: string } | string;
                    data?: {
                        status?: string;
                        fail_reason?: string;
                        data?: { data?: Array<{ url?: string; b64_json?: string }> };
                    };
                };
                if (stopped) return;
                if (r.status === 401 || j.code === 'not_found') {
                    setErr(m.image.taskNotFound);
                    return;
                }
                if (!r.ok || j.code !== 'success' || !j.data) {
                    throw new Error(
                        m.shared.apiError(
                            (typeof j.error === 'string' ? j.error : j.error?.message) ||
                                j.message ||
                                m.image.queryFailed(r.status),
                        ),
                    );
                }
                if (j.data.status === 'SUCCESS') {
                    const result = j.data.data;
                    const urls = (result?.data || [])
                        .map((d) => d.url || (d.b64_json ? `data:image/png;base64,${d.b64_json}` : ''))
                        .filter(Boolean);
                    setRaw(
                        JSON.stringify(
                            result ?? {},
                            (_key, value: unknown) =>
                                typeof value === 'string' &&
                                (value.startsWith('data:image/') ||
                                    (value.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(value)))
                                    ? m.image.imageData(value.length)
                                    : value,
                            2,
                        ),
                    );
                    setImgs(urls);
                    setTaskStatus('SUCCESS');
                    setErr(urls.length ? '' : m.image.noImages);
                    return;
                }
                if (j.data.status === 'FAILURE') {
                    setTaskStatus('FAILURE');
                    setErr(j.data.fail_reason || m.image.taskFailed);
                    return;
                }
                if (j.data.status !== 'IN_PROGRESS') throw new Error(m.image.unknownStatus);
                setTaskStatus('IN_PROGRESS');
                setErr('');
                timer = setTimeout(poll, 3000);
            } catch (e) {
                if (stopped) return;
                setErr(m.image.pollRetrying(e instanceof Error ? e.message : String(e)));
                timer = setTimeout(poll, 5000);
            }
        };
        void poll();
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            controller.abort();
        };
    }, [taskId, key, m]);

    // 换模型时重置分辨率 —— 不同模型 size 格式不同(WxH vs 1K/2K/4K),留旧值会被上游 400。
    useEffect(() => {
        setSize('');
    }, [model]);

    useEffect(() => {
        if (model) setBodyJson(buildBody(model, mode, prompt, aspect, size, n, image));
    }, [model, mode, prompt, aspect, size, n, image]);

    const loadModels = useCallback(async () => {
        setErr('');
        setLoadingModels(true);
        try {
            const r = await fetch('/api/tools/image/models', { headers: { Authorization: `Bearer ${key.trim()}` } });
            const j = await r.json();
            if (!r.ok) throw new Error(m.shared.apiError(j?.error?.message || j?.error || m.shared.loadFailed));
            const ms: string[] = j.models || [];
            if (!ms.length) throw new Error(m.image.noModels);
            setModels(ms);
            setModel(ms[0]);
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
            setModels([]);
            setModel('');
        } finally {
            setLoadingModels(false);
        }
    }, [key, m]);

    const onUpload = useCallback((f: File | undefined) => {
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => setImage(String(reader.result || ''));
        reader.readAsDataURL(f);
    }, []);

    // 下载生成图:data URL 直接下;跨源 R2/OSS 链接走同源代理强制 attachment(浏览器对跨源
    // <a download> 只会打开不下载)。
    const downloadImage = useCallback((url: string, idx: number) => {
        const name = `llmroute-image-${idx + 1}`;
        const a = document.createElement('a');
        if (url.startsWith('data:')) {
            a.href = url;
            const mime = url.slice(5, url.indexOf(';'));
            a.download = `${name}.${mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'}`;
        } else {
            a.href = `/api/tools/image/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`;
            a.download = name; // 服务端会带 Content-Disposition,这里只作提示
        }
        document.body.appendChild(a);
        a.click();
        a.remove();
    }, []);

    const generate = useCallback(async () => {
        if (busy || taskStatus === 'IN_PROGRESS' || !model || !prompt.trim()) return;
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
                throw new Error(m.image.nonJson(r.status));
            }
            if (!r.ok) {
                const e = j as { error?: { message?: string } | string; message?: string };
                throw new Error(
                    m.shared.apiError(
                        (typeof e.error === 'string' ? e.error : e.error?.message) ||
                            e.message ||
                            m.shared.requestFailed(r.status),
                    ),
                );
            }
            const task = (j as { data?: { task_id?: string; status?: string } }).data;
            if (!task?.task_id || !/^[0-9a-f]{32}$/.test(task.task_id)) {
                throw new Error(m.image.noTaskId);
            }
            try {
                window.localStorage.setItem(LAST_TASK_STORAGE_KEY, task.task_id);
            } catch {
                // 本地存储不可用时，当前页面仍可继续查询。
            }
            setTaskId(task.task_id);
            setTaskStatus('IN_PROGRESS');
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
        } finally {
            setBusy(false);
        }
    }, [busy, taskStatus, model, prompt, bodyJson, key, m]);

    return (
        <div className="space-y-5">
            {/* Key */}
            <div className="rounded-lg border border-brand-border bg-surface p-4">
                <label className="block text-sm font-medium text-navy mb-1">{m.shared.apiKeyLabel}</label>
                <div className="flex gap-2">
                    <input
                        type={showKey ? 'text' : 'password'}
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                        placeholder={m.shared.apiKeyPlaceholder}
                        className="flex-1 rounded border border-brand-border bg-paper px-3 py-2 text-sm font-mono"
                    />
                    <button
                        onClick={() => setShowKey((s) => !s)}
                        className="rounded border border-brand-border px-3 text-sm text-muted-ink"
                    >
                        {showKey ? m.shared.hide : m.shared.show}
                    </button>
                    <button
                        onClick={loadModels}
                        disabled={!key.trim() || loadingModels}
                        className="rounded bg-brand-accent px-4 text-sm font-medium text-white disabled:opacity-50"
                    >
                        {loadingModels ? m.shared.loading : m.shared.loadModels}
                    </button>
                </div>
                <p className="m-0 mt-2 text-xs text-minor-ink">{m.shared.keyNote}</p>
            </div>

            {taskId && (
                <div className="rounded-lg border border-brand-border bg-surface p-4 text-sm text-navy space-y-1">
                    <p className="m-0">
                        {m.image.taskLabel}
                        <code className="font-mono break-all">{taskId}</code>
                    </p>
                    <p className="m-0 text-muted-ink">
                        {taskStatus === 'SUCCESS'
                            ? m.image.taskDone
                            : taskStatus === 'FAILURE'
                              ? m.image.taskFailedHint
                              : key.trim()
                                ? m.image.taskPolling
                                : m.image.taskNeedKey}
                    </p>
                    <button
                        type="button"
                        onClick={() => {
                            try {
                                window.localStorage.removeItem(LAST_TASK_STORAGE_KEY);
                            } catch {
                                // 不影响清除当前页面的任务号。
                            }
                            setTaskId('');
                            setTaskStatus('IDLE');
                            setErr('');
                        }}
                        className="mt-2 rounded border border-brand-border px-3 py-1 text-xs text-muted-ink"
                    >
                        {m.image.clearTask}
                    </button>
                </div>
            )}

            {models.length > 0 && (
                <>
                    {/* 模型 + 模式 */}
                    <div className="rounded-lg border border-brand-border bg-surface p-4 space-y-3">
                        <div className="flex items-center gap-3 flex-wrap">
                            <label className="text-sm font-medium text-navy">{m.shared.model}</label>
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
                            {(['text', 'edit'] as Mode[]).map((md) => (
                                <button
                                    key={md}
                                    onClick={() => setMode(md)}
                                    className={`rounded-full px-4 py-1.5 text-sm border ${
                                        mode === md
                                            ? 'bg-brand-accent text-white border-brand-accent'
                                            : 'border-brand-border text-muted-ink'
                                    }`}
                                >
                                    {md === 'text' ? m.image.modeText : m.image.modeEdit}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 参数 */}
                    <div className="rounded-lg border border-brand-border bg-surface p-4 space-y-3">
                        <div>
                            <label className="block text-sm font-medium text-navy mb-1">{m.image.prompt}</label>
                            <textarea
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                                rows={3}
                                placeholder={m.image.promptPlaceholder}
                                className="w-full rounded border border-brand-border bg-paper px-3 py-2 text-sm"
                            />
                        </div>
                        <div className="flex items-center gap-4 flex-wrap">
                            <div className="flex items-center gap-2">
                                <label className="text-sm font-medium text-navy">{m.image.aspect}</label>
                                <select
                                    value={aspect}
                                    onChange={(e) => {
                                        setAspect(e.target.value);
                                        if (model.toLowerCase().includes('gpt-image') && e.target.value !== 'auto') {
                                            setSize('');
                                        }
                                    }}
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
                                <label className="text-sm font-medium text-navy">{m.image.resolution}</label>
                                <select
                                    value={size}
                                    onChange={(e) => {
                                        setSize(e.target.value);
                                        if (model.toLowerCase().includes('gpt-image') && e.target.value) {
                                            setAspect('auto');
                                        }
                                    }}
                                    className="rounded border border-brand-border bg-paper px-2 py-1.5 text-sm"
                                >
                                    {sizeOptionsFor(model, m.image).map((o) => (
                                        <option key={o.v} value={o.v}>
                                            {o.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex items-center gap-2">
                                <label className="text-sm font-medium text-navy">{m.image.count}</label>
                                <input
                                    type="number"
                                    min={1}
                                    max={4}
                                    value={n}
                                    onChange={(e) => setN(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
                                    className="w-16 rounded border border-brand-border bg-paper px-2 py-1.5 text-sm"
                                />
                                <span className="text-xs text-minor-ink">{m.image.geminiSingle}</span>
                            </div>
                        </div>
                        {mode === 'edit' && (
                            <div>
                                <label className="block text-sm font-medium text-navy mb-1">{m.image.refImage}</label>
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
                        <label className="block text-sm font-medium text-navy mb-1">{m.image.requestJson}</label>
                        <textarea
                            value={bodyJson}
                            onChange={(e) => setBodyJson(e.target.value)}
                            rows={6}
                            className="w-full rounded border border-brand-border bg-paper px-3 py-2 text-xs font-mono"
                        />
                    </div>

                    <button
                        onClick={generate}
                        disabled={busy || taskStatus === 'IN_PROGRESS' || !prompt.trim()}
                        className="rounded bg-brand-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                        {busy
                            ? m.image.submitting
                            : taskStatus === 'IN_PROGRESS'
                              ? m.shared.generating
                              : m.image.generate}
                    </button>
                </>
            )}

            {imgs.length > 0 && (
                <div className="grid grid-cols-2 gap-3">
                    {imgs.map((u, i) => (
                        <div key={i} className="space-y-2">
                            <a href={u} target="_blank" rel="noreferrer">
                                <img
                                    src={u}
                                    alt={`result ${i + 1}`}
                                    className="w-full rounded-lg border border-brand-border"
                                />
                            </a>
                            <button
                                onClick={() => downloadImage(u, i)}
                                className="w-full rounded border border-brand-border px-3 py-1.5 text-sm font-medium text-navy hover:bg-paper-muted"
                            >
                                {m.image.download}
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {raw && (
                <details className="rounded-lg border border-brand-border bg-surface p-3 text-xs">
                    <summary className="cursor-pointer text-muted-ink">{m.image.responseDetails}</summary>
                    <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-minor-ink">{raw}</pre>
                </details>
            )}

            {err && (
                <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 whitespace-pre-wrap">
                    {err}
                </div>
            )}
        </div>
    );
}
