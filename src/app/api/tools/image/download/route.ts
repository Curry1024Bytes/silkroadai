import { NextRequest, NextResponse } from 'next/server';

/**
 * 工具 — 生图结果下载代理(同源强制下载)。
 *
 * 跨源图片(R2 `images.llmroute.club` / 客户自定义 OSS)用浏览器 `<a download>` 会被无视 ——
 * 只在新标签打开、不触发下载。这里服务端把图片拉下来、带 `Content-Disposition: attachment`
 * 同源回传,强制浏览器下载。data URL(b64_json)由客户端直接下载,不经过这里。
 *
 * SSRF 基础守门:只放 http(s) + 拒 localhost / 私网 IPv4 字面量 / IPv6 字面量(复用 /v1 代理同款)。
 * 只接受 image/* content-type + 50MB 上限,避免被当成任意 URL 代理。无鉴权 —— 图本身是公开 URL。
 */
export const dynamic = 'force-dynamic';

function isDisallowedUrl(raw: string): boolean {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return true;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (h.includes(':') || h.startsWith('[')) return true; // IPv6 literal
    const ipv4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
        const a = Number(ipv4[1]);
        const b = Number(ipv4[2]);
        if (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168)
        )
            return true;
    }
    return false;
}

const EXT: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
};
const MAX_BYTES = 50 * 1024 * 1024;

export async function GET(req: NextRequest) {
    const url = req.nextUrl.searchParams.get('url') || '';
    const nameRaw = (req.nextUrl.searchParams.get('name') || 'image').replace(/[^\w.-]/g, '_').slice(0, 80);
    if (!url || isDisallowedUrl(url)) {
        return NextResponse.json({ error: '非法的图片地址' }, { status: 400 });
    }
    let up: Response;
    try {
        up = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (e) {
        return NextResponse.json({ error: `图片拉取失败: ${String(e)}` }, { status: 502 });
    }
    if (!up.ok) return NextResponse.json({ error: `图片不可达 (${up.status})` }, { status: 502 });
    const ct = (up.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ct.startsWith('image/')) return NextResponse.json({ error: '目标不是图片' }, { status: 400 });
    if (Number(up.headers.get('content-length') || '0') > MAX_BYTES) {
        return NextResponse.json({ error: '图片过大' }, { status: 400 });
    }
    const buf = await up.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return NextResponse.json({ error: '图片过大' }, { status: 400 });
    const base = nameRaw || 'image';
    const fname = base.includes('.') ? base : `${base}.${EXT[ct] || 'png'}`;
    return new NextResponse(buf, {
        headers: {
            'Content-Type': ct,
            'Content-Disposition': `attachment; filename="${fname}"`,
            'Cache-Control': 'no-store',
        },
    });
}
