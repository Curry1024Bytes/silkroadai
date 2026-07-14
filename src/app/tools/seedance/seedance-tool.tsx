'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Mode = 'text' | 'image' | 'multi' | 'frames' | 'audio';
type Source = 'overseas' | 'reverse' | 'cn' | 'normal';

const MODES: { key: Mode; label: string; hint: string }[] = [
    { key: 'text', label: '文生视频', hint: '纯文字描述生成' },
    { key: 'image', label: '图生视频', hint: '上传 1 张参考图' },
    { key: 'multi', label: '多图参考', hint: '上传多张图(角色/场景)' },
    { key: 'frames', label: '首尾帧', hint: '上传首帧 + 尾帧' },
    { key: 'audio', label: '参考音频', hint: '上传 1 张图 + 音频' },
];
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];

function detectSource(id: string): Source {
    if (/^dreamina-/i.test(id)) return 'overseas';
    if (/^seedance-2\.0-(720|1080)$/i.test(id)) return 'reverse';
    if (/^artsdance/i.test(id)) return 'cn';
    return 'normal';
}
function sourceLabel(s: Source): string {
    return s === 'overseas' ? '海外满血' : s === 'reverse' ? '逆向低价' : s === 'cn' ? '国内企业级' : '普通';
}
function groupModels(models: string[]): { source: Source; ids: string[] }[] {
    const by: Record<Source, string[]> = { overseas: [], reverse: [], cn: [], normal: [] };
    for (const m of models) by[detectSource(m)].push(m);
    return (['overseas', 'reverse', 'cn', 'normal'] as Source[])
        .filter((s) => by[s].length)
        .map((s) => ({ source: s, ids: by[s] }));
}

// 按模型来源 + 玩法拼请求体(海外满血 / 逆向 / 普通 三套字段约定不同)。
function buildBody(
    model: string,
    mode: Mode,
    prompt: string,
    seconds: string,
    ratio: string,
    images: string[],
    audio: string,
): Record<string, unknown> {
    const src = detectSource(model);
    // 图生类玩法:海外满血 / 国内企业级 需 -ref 模型,自动补
    let m = model;
    if ((src === 'overseas' || src === 'cn') && mode !== 'text' && !/-ref$/.test(m)) m = m + '-ref';
    const b: Record<string, unknown> = { model: m, prompt };
    if (src === 'normal' || src === 'cn') b.duration = Number(seconds) || 5;
    else b.seconds = String(seconds || '5');
    if (ratio) b.aspect_ratio = ratio;

    if (mode === 'image') {
        if (src === 'reverse') b.image_url = images[0];
        else b.image = images[0];
    } else if (mode === 'multi') {
        if (src === 'overseas' || src === 'cn') b.images = images;
        else if (src === 'reverse') b.reference_image_urls = images;
        else b.reference_images = images;
    } else if (mode === 'frames') {
        if (src === 'overseas' || src === 'cn') {
            b.first_frame = images[0];
            b.last_frame = images[1];
        } else if (src === 'reverse') {
            b.reference_image_urls = [images[0], images[1]];
            b.video_config = { reference_mode: 'start_end' };
        } else {
            b.image = images[0];
            b.last_frame_image = images[1];
        }
    } else if (mode === 'audio') {
        if (src === 'reverse') b.image_url = images[0];
        else b.image = images[0];
        b.audio_url = audio;
    }
    return b;
}

function findStr(obj: unknown, key: string): string | null {
    let out: string | null = null;
    const walk = (n: unknown) => {
        if (out) return;
        if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === 'object') {
            const o = n as Record<string, unknown>;
            const v = o[key];
            if (typeof v === 'string' && v.startsWith('http')) out = v;
            else Object.values(o).forEach(walk);
        }
    };
    walk(obj);
    return out;
}
function findStatus(obj: unknown): string {
    const walk = (n: unknown): string => {
        if (Array.isArray(n)) {
            for (const x of n) {
                const r = walk(x);
                if (r) return r;
            }
        } else if (n && typeof n === 'object') {
            const o = n as Record<string, unknown>;
            if (typeof o.status === 'string') return o.status;
            for (const v of Object.values(o)) {
                const r = walk(v);
                if (r) return r;
            }
        }
        return '';
    };
    return walk(obj);
}

export function SeedanceTool() {
    const [key, setKey] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [models, setModels] = useState<string[]>([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [model, setModel] = useState('');
    const [mode, setMode] = useState<Mode>('text');
    const [prompt, setPrompt] = useState('一只橘猫在窗台上伸懒腰,慢镜头,暖色调');
    const [seconds, setSeconds] = useState('5');
    const [ratio, setRatio] = useState('16:9');
    const [images, setImages] = useState<string[]>([]);
    const [audio, setAudio] = useState('');
    const [bodyJson, setBodyJson] = useState('');
    const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
    const [progress, setProgress] = useState('');
    const [videoUrl, setVideoUrl] = useState('');
    const [raw, setRaw] = useState('');
    const [err, setErr] = useState('');

    const grouped = useMemo(() => groupModels(models), [models]);
    const src = model ? detectSource(model) : null;

    // 表单变化 → 自动重建请求 JSON(手改 JSON 后,改任意表单项会覆盖)
    useEffect(() => {
        if (!model) return;
        setBodyJson(JSON.stringify(buildBody(model, mode, prompt, seconds, ratio, images, audio), null, 2));
    }, [model, mode, prompt, seconds, ratio, images, audio]);

    const loadModels = useCallback(async () => {
        setErr('');
        setLoadingModels(true);
        try {
            const r = await fetch('/api/tools/seedance/models', { headers: { Authorization: `Bearer ${key.trim()}` } });
            const j = await r.json();
            if (!r.ok) throw new Error(j?.error?.message || j?.error || '加载失败');
            const ms: string[] = j.models || [];
            if (!ms.length) throw new Error('这把 key 下没有可用的 Seedance 视频模型(检查档位)');
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

    const onUpload = useCallback((files: FileList | null, multi: boolean) => {
        if (!files || !files.length) return;
        const arr = Array.from(files).slice(0, multi ? 9 : 1);
        Promise.all(
            arr.map(
                (f) =>
                    new Promise<string>((res, rej) => {
                        const fr = new FileReader();
                        fr.onload = () => res(String(fr.result));
                        fr.onerror = rej;
                        fr.readAsDataURL(f);
                    }),
            ),
        ).then((urls) => setImages((prev) => (multi ? [...prev, ...urls].slice(0, 9) : urls)));
    }, []);

    const onAudio = useCallback((files: FileList | null) => {
        const f = files?.[0];
        if (!f) return;
        const fr = new FileReader();
        fr.onload = () => setAudio(String(fr.result));
        fr.readAsDataURL(f);
    }, []);

    const generate = useCallback(async () => {
        setErr('');
        setVideoUrl('');
        setRaw('');
        setStatus('running');
        setProgress('提交中…');
        let body: unknown;
        try {
            body = JSON.parse(bodyJson);
        } catch {
            setErr('请求 JSON 格式错误');
            setStatus('error');
            return;
        }
        const headers = { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' };
        let taskId = '';
        try {
            const r = await fetch('/api/tools/seedance/submit', {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j?.error?.message || j?.message || j?.error || `提交失败 (${r.status})`);
            taskId = j.task_id || j.id || j?.data?.task_id;
            if (!taskId) throw new Error('未拿到 task_id:' + JSON.stringify(j).slice(0, 200));
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
            setStatus('error');
            return;
        }
        // 轮询(最多约 15 分钟)
        for (let i = 0; i < 150; i++) {
            await new Promise((r) => setTimeout(r, 6000));
            try {
                const r = await fetch(`/api/tools/seedance/poll/${encodeURIComponent(taskId)}`, { headers });
                const j = await r.json();
                setRaw(JSON.stringify(j, null, 2));
                const st = (findStatus(j) || '').toUpperCase();
                setProgress(`生成中… ${st || 'PROCESSING'}(已等 ${Math.round(((i + 1) * 6) / 6) * 6}s)`);
                if (['SUCCESS', 'COMPLETED', 'SUCCEEDED'].includes(st)) {
                    const url = findStr(j, 'video_url') || findStr(j, 'url');
                    setVideoUrl(url || '');
                    setStatus('done');
                    setProgress('');
                    if (!url) setErr('已完成但未找到 video_url,见下方原始响应');
                    return;
                }
                if (['FAILED', 'FAILURE', 'ERROR'].includes(st)) {
                    setErr('生成失败,见下方原始响应');
                    setStatus('error');
                    return;
                }
            } catch {
                /* 单次轮询失败忽略,继续 */
            }
        }
        setErr('超时(>15 分钟未出片),请稍后用 task_id 再查或重试');
        setStatus('error');
    }, [bodyJson, key]);

    const needImages = mode !== 'text';
    const imgCount = mode === 'frames' ? 2 : mode === 'multi' ? 9 : 1;

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
                    Key 只用于本次调用、不保存。在「API 密钥」页用复制按钮取,避免手敲混淆。
                </p>
            </div>

            {models.length > 0 && (
                <>
                    {/* 模型 */}
                    <div className="rounded-lg border border-brand-border bg-surface p-4">
                        <label className="block text-sm font-medium text-navy mb-1">模型</label>
                        <select
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            className="w-full rounded border border-brand-border bg-paper px-3 py-2 text-sm font-mono"
                        >
                            {grouped.map((g) => (
                                <optgroup key={g.source} label={sourceLabel(g.source)}>
                                    {g.ids.map((id) => (
                                        <option key={id} value={id}>
                                            {id}
                                        </option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                        {src && (
                            <p className="m-0 mt-1 text-xs text-minor-ink">
                                档位:{sourceLabel(src)} · 时长字段 {src === 'normal' ? 'duration' : 'seconds'}
                                {src === 'reverse' ? '(建议 10/15)' : ''}
                            </p>
                        )}
                    </div>

                    {/* 玩法 */}
                    <div className="rounded-lg border border-brand-border bg-surface p-4">
                        <label className="block text-sm font-medium text-navy mb-2">玩法</label>
                        <div className="flex flex-wrap gap-2 mb-3">
                            {MODES.map((m) => (
                                <button
                                    key={m.key}
                                    onClick={() => {
                                        setMode(m.key);
                                        setImages([]);
                                    }}
                                    className={`rounded-full px-3 py-1 text-sm border ${mode === m.key ? 'bg-brand-accent text-white border-brand-accent' : 'border-brand-border text-muted-ink'}`}
                                    title={m.hint}
                                >
                                    {m.label}
                                </button>
                            ))}
                        </div>

                        <label className="block text-sm font-medium text-navy mb-1">提示词</label>
                        <textarea
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            rows={2}
                            className="w-full rounded border border-brand-border bg-paper px-3 py-2 text-sm"
                        />
                        {mode === 'multi' && src === 'reverse' && (
                            <p className="m-0 mt-1 text-xs text-minor-ink">
                                多图请在提示词里用 @Image1 / @Image2 指代每张图。
                            </p>
                        )}

                        <div className="flex gap-4 mt-3">
                            <div>
                                <label className="block text-xs text-muted-ink mb-1">时长(秒)</label>
                                <input
                                    value={seconds}
                                    onChange={(e) => setSeconds(e.target.value)}
                                    className="w-24 rounded border border-brand-border bg-paper px-2 py-1.5 text-sm"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-muted-ink mb-1">画面比例</label>
                                <select
                                    value={ratio}
                                    onChange={(e) => setRatio(e.target.value)}
                                    className="rounded border border-brand-border bg-paper px-2 py-1.5 text-sm"
                                >
                                    {RATIOS.map((r) => (
                                        <option key={r}>{r}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        {needImages && (
                            <div className="mt-3">
                                <label className="block text-xs text-muted-ink mb-1">
                                    {mode === 'frames'
                                        ? '首帧 + 尾帧(按顺序选 2 张)'
                                        : mode === 'multi'
                                          ? '参考图(可多张,≤9)'
                                          : '参考图(1 张)'}
                                </label>
                                <input
                                    type="file"
                                    accept="image/*"
                                    multiple={imgCount > 1}
                                    onChange={(e) => onUpload(e.target.files, imgCount > 1)}
                                    className="text-xs"
                                />
                                {images.length > 0 && (
                                    <div className="flex flex-wrap gap-2 mt-2">
                                        {images.map((u, i) => (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img
                                                key={i}
                                                src={u}
                                                alt={`img${i}`}
                                                className="h-14 w-14 rounded object-cover border border-brand-border"
                                            />
                                        ))}
                                        <button
                                            onClick={() => setImages([])}
                                            className="text-xs text-minor-ink underline self-end"
                                        >
                                            清除
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {mode === 'audio' && (
                            <div className="mt-3">
                                <label className="block text-xs text-muted-ink mb-1">参考音频(上传或填直链)</label>
                                <input
                                    type="file"
                                    accept="audio/*"
                                    onChange={(e) => onAudio(e.target.files)}
                                    className="text-xs block mb-1"
                                />
                                <input
                                    value={audio.startsWith('data:') ? '(已上传音频文件)' : audio}
                                    onChange={(e) => setAudio(e.target.value)}
                                    placeholder="https://你的音频/song.mp3"
                                    className="w-full rounded border border-brand-border bg-paper px-2 py-1.5 text-sm"
                                />
                            </div>
                        )}
                    </div>

                    {/* 请求 JSON(可改) */}
                    <div className="rounded-lg border border-brand-border bg-surface p-4">
                        <label className="block text-sm font-medium text-navy mb-1">
                            请求 JSON(自动生成,可手动改 — 高级玩法直接编辑这里)
                        </label>
                        <textarea
                            value={bodyJson}
                            onChange={(e) => setBodyJson(e.target.value)}
                            rows={10}
                            className="w-full rounded border border-brand-border bg-paper px-3 py-2 text-xs font-mono"
                            spellCheck={false}
                        />
                        <button
                            onClick={generate}
                            disabled={status === 'running'}
                            className="mt-3 rounded bg-brand-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
                        >
                            {status === 'running' ? '生成中…' : '生成视频'}
                        </button>
                        {progress && <span className="ml-3 text-sm text-muted-ink">{progress}</span>}
                    </div>
                </>
            )}

            {err && (
                <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 whitespace-pre-wrap">
                    {err}
                </div>
            )}

            {videoUrl && (
                <div className="rounded-lg border border-brand-border bg-surface p-4">
                    <label className="block text-sm font-medium text-navy mb-2">生成结果</label>
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <video src={videoUrl} controls className="w-full rounded border border-brand-border" />
                    <a
                        href={videoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block text-sm text-brand-accent hover:underline break-all"
                    >
                        {videoUrl}
                    </a>
                </div>
            )}

            {raw && (
                <details className="rounded-lg border border-brand-border bg-surface p-4">
                    <summary className="cursor-pointer text-sm font-medium text-navy">原始响应(调试)</summary>
                    <pre className="mt-2 overflow-auto text-xs text-muted-ink">{raw}</pre>
                </details>
            )}
        </div>
    );
}
