import { describe, it, expect } from 'vitest';
import { NextResponse } from 'next/server';
import { withKeepalive } from '../[...path]/keepalive';

const laterResp = (ms: number, body: string, headers: Record<string, string>) =>
    new Promise<NextResponse>((resolve) =>
        setTimeout(() => resolve(new NextResponse(body, { status: 200, headers })), ms),
    );

describe('withKeepalive — 慢生图 keepalive 防 CF 100s 超时', () => {
    it('handler 快于阈值 → 原样返回同一个响应(状态/头/body 不变,零回归)', async () => {
        const res = NextResponse.json({ ok: true }, { status: 201, headers: { 'X-Test': 'a' } });
        const out = await withKeepalive(Promise.resolve(res), { afterMs: 1000 });
        expect(out).toBe(res); // 同一对象,未包装
        expect(out.status).toBe(201);
        expect(out.headers.get('X-Test')).toBe('a');
        expect(out.headers.get('X-Silkroadai-Keepalive')).toBeNull(); // 未触发 keepalive
    });

    it('handler 超过阈值 → 200 + 空格涓流,真实 JSON 前导空白不影响解析', async () => {
        const realBody = JSON.stringify({ created: 1, data: [{ b64_json: 'aGVsbG8=' }] });
        const out = await withKeepalive(laterResp(70, realBody, { 'content-type': 'application/json' }), {
            afterMs: 20,
            trickleMs: 10,
        });
        expect(out.status).toBe(200);
        expect(out.headers.get('X-Silkroadai-Keepalive')).toBe('trickle');
        expect(out.headers.get('content-type')).toBe('application/json');
        const text = await out.text();
        expect(text.length).toBeGreaterThan(realBody.length); // 前面有 keepalive 空格填充
        expect(text.startsWith(' ')).toBe(true);
        expect(JSON.parse(text).data[0].b64_json).toBe('aGVsbG8='); // 真实 body 完整、可解析
    });

    it('handler 超过阈值 + sse:true → text/event-stream + SSE 注释涓流,真实 SSE 在后', async () => {
        const sseBody = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
        const out = await withKeepalive(laterResp(70, sseBody, { 'content-type': 'text/event-stream' }), {
            sse: true,
            afterMs: 20,
            trickleMs: 10,
        });
        expect(out.headers.get('content-type')).toBe('text/event-stream');
        const text = await out.text();
        expect(text).toContain(': keepalive'); // SSE 注释(解析器忽略)
        expect(text).toContain('data: [DONE]'); // 真实 SSE body 在后
        expect(text.indexOf(': keepalive')).toBeLessThan(text.indexOf('data: [DONE]')); // 涓流在前
    });

    it('handler 超过阈值后 reject → 200 + proxy_error body(本会 524,不算回归)', async () => {
        const work = new Promise<NextResponse>((_res, reject) =>
            setTimeout(() => reject(new Error('boom-after-slow')), 70),
        );
        const out = await withKeepalive(work, { afterMs: 20, trickleMs: 10 });
        expect(out.status).toBe(200);
        const parsed = JSON.parse(await out.text());
        expect(parsed.error.type).toBe('proxy_error');
        expect(parsed.error.message).toContain('boom-after-slow');
    });

    it('handler 在阈值内 reject(罕见)→ 原样抛出,不包装', async () => {
        await expect(withKeepalive(Promise.reject(new Error('fast-fail')), { afterMs: 1000 })).rejects.toThrow(
            'fast-fail',
        );
    });
});
