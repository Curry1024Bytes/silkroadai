/**
 * Midjourney 渠道适配器(frimodel MJ 原生接口,2026-11-04)。
 *
 * 走「portal 适配器 + new-api 渠道」模式:new-api 渠道(type=5 Midjourney Plus,base_url 指向
 * `/mj-adapter`)用内置 MJ 中继处理计费 / 任务归属 / 按钮动作 / 失败退款,本适配器只夹在
 * new-api 与上游之间,渠道 key = 上游 key,经 `mj-api-secret` 头带来,不在代码里存任何 key。
 *
 * 提交类请求纯透传。唯一的改写在 new-api 的轮询入口 `/mj/task/list-by-condition`:
 *  ①成品图转存 R2 —— 上游 URL 暴露供应商域名,且文档记录过历史任务 403;
 *  ②四张单图放进 `videoUrls` —— rc.44 的 MidjourneyDto 没有 `imageUrls`,new-api 入库时会丢,
 *    `videoUrls` 是唯一能原样存取的 URL 数组。对客层(`customer-proxy.ts`)再改回 `imageUrls`。
 *
 * new-api 单轮轮询 15s 超时,且一看到 SUCCESS 就不再轮询。所以转存没完成前把任务压在
 * IN_PROGRESS 99%,完成后才放出 SUCCESS —— 客户(和动作接口的 SUCCESS 校验)看到完成时
 * 图一定已在 R2。转存持续失败时超过 MIRROR_GIVE_UP_MS 回落上游直链(匿名可取),绝不让已
 * 出图的任务卡到 new-api 的 1 小时超时。
 */
import { NextRequest, NextResponse } from 'next/server';
import { uploadImage } from '@/lib/r2/client';

const MJ_BASE = process.env.MIDJOURNEY_BASE_URL || 'https://api.frimodel.com';

/** 提交/查询本身秒回;new-api 对提交给 60s,这里给足防挂死连接池。 */
const UPSTREAM_TIMEOUT_MS = 60_000;
const IMAGE_TIMEOUT_MS = 60_000;
/** 留给转存的等待时长,必须小于 new-api 单轮轮询的 15s 超时。 */
const POLL_WAIT_MS = 10_000;
const MIRROR_GIVE_UP_MS = 3 * 60_000;
const MIRROR_CACHE_MAX = 500;

const IMAGE_EXTENSIONS: Record<string, string> = {
    'image/png': 'png',
    'image/webp': 'webp',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
};

export interface MjTask extends Record<string, unknown> {
    id?: string;
    status?: string;
    finishTime?: number;
    imageUrl?: string;
    imageUrls?: Array<{ url?: string }> | null;
}

interface MirroredImages {
    imageUrl: string;
    imageUrls: string[];
}

/** 进程内去重 + 结果缓存:没等完的转存下一轮直接取结果,不重复下载。失败不缓存。
 *  十副本各有一份;串到别的副本最多重传一次,R2 key 确定,结果幂等。 */
const mirrors = new Map<string, Promise<MirroredImages>>();

function upstreamKey(req: NextRequest): string {
    const secret = req.headers.get('mj-api-secret') || req.headers.get('authorization') || '';
    return secret.replace(/^Bearer\s+/i, '').trim();
}

function fetchUpstream(path: string, key: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${MJ_BASE}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
}

async function mirrorImage(url: string, objectKey: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`image fetch ${res.status}`);
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_EXTENSIONS[contentType];
    if (!ext) throw new Error(`unexpected image content-type: ${contentType}`);
    return uploadImage(`${objectKey}.${ext}`, Buffer.from(await res.arrayBuffer()), contentType);
}

async function mirrorTaskImages(task: MjTask): Promise<MirroredImages> {
    const singles = (task.imageUrls ?? []).map((i) => i?.url).filter((u): u is string => !!u);
    const [imageUrl, ...imageUrls] = await Promise.all([
        mirrorImage(String(task.imageUrl), `mj/${task.id}/grid`),
        ...singles.map((url, i) => mirrorImage(url, `mj/${task.id}/${i}`)),
    ]);
    return { imageUrl, imageUrls };
}

function mirrorOnce(task: MjTask): Promise<MirroredImages> {
    const id = String(task.id);
    const existing = mirrors.get(id);
    if (existing) return existing;
    const job = mirrorTaskImages(task);
    mirrors.set(id, job);
    job.catch((e: unknown) => {
        mirrors.delete(id);
        console.warn('[mj-adapter] mirror failed', { id, error: e instanceof Error ? e.message : String(e) });
    });
    if (mirrors.size > MIRROR_CACHE_MAX) mirrors.delete(mirrors.keys().next().value as string);
    return job;
}

/** 转存结果 → 上游任务对象里 new-api 能入库的形状(单图 URL 走 videoUrls,见文件头)。 */
function withImages(task: MjTask, imageUrl: string, singles: string[]): MjTask {
    return { ...task, imageUrl, imageUrls: null, videoUrls: singles.length ? singles.map((url) => ({ url })) : null };
}

function holdInProgress(task: MjTask): MjTask {
    return {
        ...task,
        status: 'IN_PROGRESS',
        progress: '99%',
        finishTime: 0,
        imageUrl: '',
        imageUrls: null,
        buttons: [],
    };
}

/** 轮询里的单个任务:没图的(进行中 / 失败 / Describe)原样过,出图的转存后才放行。 */
export async function resolveTask(task: MjTask): Promise<MjTask> {
    if (task.status !== 'SUCCESS' || !task.imageUrl) return task;
    const mirrored = await Promise.race([
        mirrorOnce(task).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), POLL_WAIT_MS)),
    ]);
    if (mirrored) return withImages(task, mirrored.imageUrl, mirrored.imageUrls);

    if (Date.now() - Number(task.finishTime || Date.now()) < MIRROR_GIVE_UP_MS) return holdInProgress(task);
    console.warn('[mj-adapter] mirror gave up, falling back to upstream urls', { id: task.id });
    const singles = (task.imageUrls ?? []).map((i) => i?.url).filter((u): u is string => !!u);
    return withImages(task, task.imageUrl, singles);
}

async function listByCondition(body: string, key: string): Promise<NextResponse> {
    const upstream = await fetchUpstream('/mj/task/list-by-condition', key, { method: 'POST', body });
    const text = await upstream.text();
    if (!upstream.ok) return new NextResponse(text, { status: upstream.status });
    const tasks = JSON.parse(text) as MjTask[];
    return NextResponse.json(await Promise.all(tasks.map(resolveTask)));
}

export async function handleAdapterRequest(req: NextRequest, segments: string[]): Promise<NextResponse> {
    const key = upstreamKey(req);
    if (!key) {
        return NextResponse.json({ code: 4, description: 'missing mj-api-secret' }, { status: 401 });
    }
    const path = `/mj/${segments.join('/')}`;
    const body = req.method === 'GET' ? undefined : await req.text();
    try {
        if (path === '/mj/task/list-by-condition') return await listByCondition(body ?? '{}', key);
        const upstream = await fetchUpstream(`${path}${req.nextUrl.search}`, key, { method: req.method, body });
        return new NextResponse(await upstream.text(), {
            status: upstream.status,
            headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
        });
    } catch (e) {
        console.error('[mj-adapter] upstream request failed', { path, error: e instanceof Error ? e.message : e });
        return NextResponse.json({ code: 4, description: 'upstream_unavailable' }, { status: 502 });
    }
}

/** 仅测试用:清进程内转存缓存。 */
export function resetMirrorsForTest(): void {
    mirrors.clear();
}
