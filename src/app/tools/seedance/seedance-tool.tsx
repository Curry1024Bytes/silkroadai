'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMessages } from '@/lib/i18n/client';
import { toolsMessages } from '@/lib/i18n/messages/tools';

type Mode = 'text' | 'image' | 'multi' | 'frames' | 'audio';
type Source = 'overseas' | 'reverse' | 'cn' | 'normal';

const MODE_KEYS: Mode[] = ['text', 'image', 'multi', 'frames', 'audio'];
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];

function detectSource(id: string): Source {
    if (/^dreamina-/i.test(id)) return 'overseas';
    if (/^seedance-2\.0-(720|1080)$/i.test(id)) return 'reverse';
    if (/^seedance2\.0-pro/i.test(id)) return 'cn';
    return 'normal';
}
function groupModels(models: string[]): { source: Source; ids: string[] }[] {
    const by: Record<Source, string[]> = { overseas: [], reverse: [], cn: [], normal: [] };
    for (const m of models) by[detectSource(m)].push(m);
    return (['overseas', 'reverse', 'cn', 'normal'] as Source[])
        .filter((s) => by[s].length)
        .map((s) => ({ source: s, ids: by[s] }));
}

// 按模型来源 + 玩法拼请求体(海外满血 / 逆向 / 国内企业级 / 普通 四套字段约定不同)。
export function buildBody(
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
    const m = useMessages(toolsMessages);
    const t = m.seedance;
    const sourceLabel = (s: Source): string => t.sources[s];
    const [key, setKey] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [models, setModels] = useState<string[]>([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [model, setModel] = useState('');
    const [mode, setMode] = useState<Mode>('text');
    const [prompt, setPrompt] = useState(t.defaultPrompt);
    const [seconds, setSeconds] = useState('5');
    const [ratio, setRatio] = useState('16:9');
    const [images, setImages] = useState<string[]>([]);
    const [audio, setAudio] = useState('');
    const [bodyJson, setBodyJson] = useState('');
    const [manualEdit, setManualEdit] = useState(false); // 用户手改过请求 JSON → 提交用文本框而非表单重建
    const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
    const [progress, setProgress] = useState('');
    const [videoUrl, setVideoUrl] = useState('');
    const [raw, setRaw] = useState('');
    const [err, setErr] = useState('');

    const grouped = useMemo(() => groupModels(models), [models]);
    const src = model ? detectSource(model) : null;

    // 表单变化 → 自动重建请求 JSON + 退出"手改"模式(改任意表单项会覆盖手改内容)
    useEffect(() => {
        if (!model) return;
        setBodyJson(JSON.stringify(buildBody(model, mode, prompt, seconds, ratio, images, audio), null, 2));
        setManualEdit(false);
    }, [model, mode, prompt, seconds, ratio, images, audio]);

    const loadModels = useCallback(async () => {
        setErr('');
        setLoadingModels(true);
        try {
            const r = await fetch('/api/tools/seedance/models', { headers: { Authorization: `Bearer ${key.trim()}` } });
            const j = await r.json();
            if (!r.ok) throw new Error(m.shared.apiError(j?.error?.message || j?.error || m.shared.loadFailed));
            const ms: string[] = j.models || [];
            if (!ms.length) throw new Error(t.noModels);
            setModels(ms);
            setModel(ms[0]);
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
            setModels([]);
            setModel('');
        } finally {
            setLoadingModels(false);
        }
    }, [key, m, t]);

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
        setProgress(t.submitting);
        // 未手改 JSON 时,提交用【实时表单状态】重建 —— 避免"上传图后 JSON 文本框还没同步"的竞态
        // (老实现只读文本框,上传与文本框刷新之间点生成就会漏掉图)。手改过 JSON 才用文本框内容。
        let body: Record<string, unknown>;
        if (manualEdit) {
            try {
                body = JSON.parse(bodyJson) as Record<string, unknown>;
            } catch {
                setErr(t.jsonInvalid);
                setStatus('error');
                return;
            }
        } else {
            body = buildBody(model, mode, prompt, seconds, ratio, images, audio);
        }
        // 需要参考媒体的玩法:body 里必须真有媒体,防"选了文件但没进请求"(比如切档把已选图清空了)
        if (mode !== 'text') {
            const mediaKeys = [
                'image',
                'image_url',
                'images',
                'reference_image_urls',
                'first_frame',
                'last_frame',
                'audio_url',
                'reference_videos',
            ];
            const hasMedia = mediaKeys.some((k) => {
                const v = body[k];
                return typeof v === 'string' ? !!v : Array.isArray(v) ? v.length > 0 : false;
            });
            if (!hasMedia) {
                setErr(t.needMedia);
                setStatus('error');
                return;
            }
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
            if (!r.ok)
                throw new Error(
                    m.shared.apiError(j?.error?.message || j?.message || j?.error || t.submitFailed(r.status)),
                );
            taskId = j.task_id || j.id || j?.data?.task_id;
            if (!taskId) throw new Error(t.noTaskId(JSON.stringify(j).slice(0, 200)));
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
                setProgress(t.progress(st || 'PROCESSING', Math.round(((i + 1) * 6) / 6) * 6));
                if (['SUCCESS', 'COMPLETED', 'SUCCEEDED'].includes(st)) {
                    const url = findStr(j, 'video_url') || findStr(j, 'url');
                    setVideoUrl(url || '');
                    setStatus('done');
                    setProgress('');
                    if (!url) setErr(t.doneNoUrl);
                    return;
                }
                if (['FAILED', 'FAILURE', 'ERROR'].includes(st)) {
                    setErr(t.failed);
                    setStatus('error');
                    return;
                }
            } catch {
                /* 单次轮询失败忽略,继续 */
            }
        }
        setErr(t.timeout);
        setStatus('error');
    }, [manualEdit, bodyJson, key, model, mode, prompt, seconds, ratio, images, audio, m, t]);

    const needImages = mode !== 'text';
    const imgCount = mode === 'frames' ? 2 : mode === 'multi' ? 9 : 1;

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
                <p className="m-0 mt-2 text-xs text-minor-ink">{t.keyNote}</p>
            </div>

            {models.length > 0 && (
                <>
                    {/* 模型 */}
                    <div className="rounded-lg border border-brand-border bg-surface p-4">
                        <label className="block text-sm font-medium text-navy mb-1">{m.shared.model}</label>
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
                                {t.tierLine(
                                    sourceLabel(src),
                                    src === 'normal' || src === 'cn' ? 'duration' : 'seconds',
                                )}
                                {src === 'reverse' ? t.reverseDurationHint : ''}
                            </p>
                        )}
                    </div>

                    {/* 玩法 */}
                    <div className="rounded-lg border border-brand-border bg-surface p-4">
                        <label className="block text-sm font-medium text-navy mb-2">{t.playMode}</label>
                        <div className="flex flex-wrap gap-2 mb-3">
                            {MODE_KEYS.map((k) => (
                                <button
                                    key={k}
                                    onClick={() => {
                                        if (k === mode) return; // 再点当前玩法不清空已选素材
                                        setMode(k);
                                        setImages([]);
                                    }}
                                    className={`rounded-full px-3 py-1 text-sm border ${mode === k ? 'bg-brand-accent text-white border-brand-accent' : 'border-brand-border text-muted-ink'}`}
                                    title={t.modes[k].hint}
                                >
                                    {t.modes[k].label}
                                </button>
                            ))}
                        </div>

                        <label className="block text-sm font-medium text-navy mb-1">{t.prompt}</label>
                        <textarea
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            rows={2}
                            className="w-full rounded border border-brand-border bg-paper px-3 py-2 text-sm"
                        />
                        {mode === 'multi' && src === 'reverse' && (
                            <p className="m-0 mt-1 text-xs text-minor-ink">{t.multiHint}</p>
                        )}

                        <div className="flex gap-4 mt-3">
                            <div>
                                <label className="block text-xs text-muted-ink mb-1">{t.duration}</label>
                                <input
                                    value={seconds}
                                    onChange={(e) => setSeconds(e.target.value)}
                                    className="w-24 rounded border border-brand-border bg-paper px-2 py-1.5 text-sm"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-muted-ink mb-1">{t.ratio}</label>
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
                                        ? t.framesLabel
                                        : mode === 'multi'
                                          ? t.multiLabel
                                          : t.singleLabel}
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
                                            {t.clear}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {mode === 'audio' && (
                            <div className="mt-3">
                                <label className="block text-xs text-muted-ink mb-1">{t.audioLabel}</label>
                                <input
                                    type="file"
                                    accept="audio/*"
                                    onChange={(e) => onAudio(e.target.files)}
                                    className="text-xs block mb-1"
                                />
                                <input
                                    value={audio.startsWith('data:') ? t.audioUploaded : audio}
                                    onChange={(e) => setAudio(e.target.value)}
                                    placeholder={t.audioPlaceholder}
                                    className="w-full rounded border border-brand-border bg-paper px-2 py-1.5 text-sm"
                                />
                            </div>
                        )}
                    </div>

                    {/* 请求 JSON(可改) */}
                    <div className="rounded-lg border border-brand-border bg-surface p-4">
                        <label className="block text-sm font-medium text-navy mb-1">{t.requestJson}</label>
                        <textarea
                            value={bodyJson}
                            onChange={(e) => {
                                setBodyJson(e.target.value);
                                setManualEdit(true);
                            }}
                            rows={10}
                            className="w-full rounded border border-brand-border bg-paper px-3 py-2 text-xs font-mono"
                            spellCheck={false}
                        />
                        <button
                            onClick={generate}
                            disabled={status === 'running'}
                            className="mt-3 rounded bg-brand-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
                        >
                            {status === 'running' ? m.shared.generating : t.generate}
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
                    <label className="block text-sm font-medium text-navy mb-2">{t.result}</label>
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
                    <summary className="cursor-pointer text-sm font-medium text-navy">{t.rawDebug}</summary>
                    <pre className="mt-2 overflow-auto text-xs text-muted-ink">{raw}</pre>
                </details>
            )}
        </div>
    );
}
