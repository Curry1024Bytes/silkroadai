/**
 * Seedance 逆向低价(callxyq)适配器。
 *
 * callxyq(api.callxyq.xyz)本身是原生 OpenAI-video(POST /v1/videos 提交 / GET /v1/videos/{id} 轮询),
 * 所以本适配器**只做透传**,不像海外满血(service-inference.ai 自定义 API)需要翻译。
 * 唯一额外动作:轮询出片后把成片**转存我们 R2**(复用 [@/lib/seedance/adapter].mirrorVideoToR2),
 * video_url 返回 images.silkroadai.io 公网永久直链(藏上游 niuma + 不过期 + 浏览器可开),
 * 否则客户拿到的是 app.niuma.me 临时裸链。见 project_seedance_reverse_lowprice。
 *
 * 渠道 ch38 base_url 指到本适配器(https://silkroadai.io/seedance-reverse-adapter,过 443 公网 + new-api SSRF 白名单);
 * 模型名路由由 new-api model_mapping 在转发前完成(seedance-2.0-720 → sora-v3-pro),适配器收到已是上游名。
 */
import { NextRequest, NextResponse } from 'next/server';
import { mirrorVideoToR2 } from '@/lib/seedance/adapter';

const BASE = process.env.SEEDANCE_REVERSE_BASE_URL || 'http://api.callxyq.xyz';
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function err(status: number, code: string, message: string) {
    return NextResponse.json({ error: { code, message, type: 'seedance_reverse_adapter_error' } }, { status });
}

/** POST 提交:原样透传到 callxyq /v1/videos。 */
export async function submitVideo(req: NextRequest): Promise<NextResponse> {
    const auth = req.headers.get('authorization') || '';
    const body = await req.text();
    try {
        const up = await fetch(`${BASE}/v1/videos`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json', 'User-Agent': UA },
            body,
        });
        return new NextResponse(await up.text(), {
            status: up.status,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (e) {
        return err(502, 'upstream_unreachable', `callxyq unreachable: ${String(e)}`);
    }
}

/** GET 轮询:透传 callxyq;status 完成后把成片转存 R2,video_url/url/urls 改成我们域名公网直链。 */
export async function pollVideo(req: NextRequest, id: string): Promise<NextResponse> {
    const auth = req.headers.get('authorization') || '';
    let up: Response;
    try {
        up = await fetch(`${BASE}/v1/videos/${encodeURIComponent(id)}`, {
            headers: { Authorization: auth, 'User-Agent': UA },
        });
    } catch (e) {
        return err(502, 'upstream_unreachable', `callxyq unreachable: ${String(e)}`);
    }
    const text = await up.text();
    if (!up.ok) return new NextResponse(text, { status: up.status, headers: { 'Content-Type': 'application/json' } });
    let j: Record<string, unknown>;
    try {
        j = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const status = String(j.status || '').toLowerCase();
    const isDone = status === 'completed' || status === 'succeeded' || status === 'success';
    const urls = Array.isArray(j.urls) ? (j.urls as unknown[]) : [];
    // 公开直链(/generated/,urls[0])优先;否则 video_url(/content,需鉴权)。
    const src =
        (typeof urls[0] === 'string' ? (urls[0] as string) : null) ||
        (typeof j.video_url === 'string' ? (j.video_url as string) : null);
    if (isDone && src) {
        // 完成:转存 R2 → 我们域名公网直链;R2 失败回退公开 src(urls[0]),绝不返回 /content。
        const finalUrl = (await mirrorVideoToR2(src, auth, id)) || src;
        j.video_url = finalUrl;
        j.url = finalUrl;
        j.urls = [finalUrl];
    } else if (!isDone) {
        // 生成中:别把上游"生成中"的 /content 临时链漏给客户(打不开)。置空,等完成再给。
        j.video_url = null;
        j.url = null;
        j.urls = [];
    }
    return NextResponse.json(j, { status: 200 });
}

/** GET 内容代理:透传 callxyq 的 /content(new-api result_url 回抓用)。 */
export async function streamContent(req: NextRequest, id: string): Promise<Response> {
    const auth = req.headers.get('authorization') || '';
    try {
        const up = await fetch(`${BASE}/v1/videos/${encodeURIComponent(id)}/content`, {
            headers: { Authorization: auth, 'User-Agent': UA },
        });
        return new Response(up.body, {
            status: up.status,
            headers: { 'Content-Type': up.headers.get('content-type') || 'video/mp4' },
        });
    } catch (e) {
        return err(502, 'upstream_unreachable', `callxyq unreachable: ${String(e)}`);
    }
}
