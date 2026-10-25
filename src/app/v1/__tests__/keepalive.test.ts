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
    function ssePayloads(text: string) {
        return text
            .split('\n')
            .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
            .map((line) => JSON.parse(line.slice(6)));
    }

    it.each([200, 400, 503])(
        'slow JSON error %s becomes one parseable SSE error frame and terminates',
        async (status) => {
            const error = { message: 'image rejected', type: 'upstream_error', code: 'image_failed' };
            const work = new Promise<NextResponse>((resolve) =>
                setTimeout(() => resolve(NextResponse.json({ error }, { status })), 25),
            );
            const response = await withKeepalive(work, { sse: true, afterMs: 1, trickleMs: 5 });
            const text = await response.text();
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/event-stream');
            expect(ssePayloads(text)).toEqual([{ error }]);
            expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
        },
    );

    it('slow HTML failure becomes a safe SSE error instead of an ignored raw response', async () => {
        const work = new Promise<NextResponse>((resolve) =>
            setTimeout(() => resolve(new NextResponse('<html>private upstream</html>', { status: 502 })), 25),
        );
        const response = await withKeepalive(work, { sse: true, afterMs: 1, trickleMs: 5 });
        const text = await response.text();
        expect(ssePayloads(text)[0].error).toMatchObject({ type: 'server_error', code: 'upstream_error' });
        expect(text).not.toContain('private upstream');
    });

    it('slow rejection becomes a proxy_error SSE frame', async () => {
        const work = new Promise<NextResponse>((_, reject) => setTimeout(() => reject(new Error('late failure')), 25));
        const response = await withKeepalive(work, { sse: true, afterMs: 1, trickleMs: 5 });
        const text = await response.text();
        expect(ssePayloads(text)).toEqual([
            { error: { message: 'upstream request failed: late failure', type: 'proxy_error' } },
        ]);
        expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    });

    it('a slow response-body read failure also becomes an SSE error frame', async () => {
        const work = new Promise<NextResponse>((resolve) =>
            setTimeout(
                () =>
                    resolve(
                        new NextResponse(
                            new ReadableStream({
                                start(controller) {
                                    controller.error(new Error('body disconnected'));
                                },
                            }),
                            { headers: { 'content-type': 'text/event-stream' } },
                        ),
                    ),
                25,
            ),
        );
        const response = await withKeepalive(work, { sse: true, afterMs: 1, trickleMs: 5 });
        expect(ssePayloads(await response.text())[0].error.message).toContain('body disconnected');
    });

    it('emits the first keepalive immediately and preserves successful SSE bytes exactly', async () => {
        let finish!: (response: NextResponse) => void;
        const work = new Promise<NextResponse>((resolve) => {
            finish = resolve;
        });
        const response = await withKeepalive(work, { sse: true, afterMs: 1, trickleMs: 10_000 });
        const reader = response.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toBe(': keepalive\n\n');
        const actual = 'data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n';
        finish(new NextResponse(actual, { headers: { 'content-type': 'text/event-stream' } }));
        const remaining: Uint8Array[] = [];
        for (;;) {
            const part = await reader.read();
            if (part.done) break;
            remaining.push(part.value);
        }
        expect(Buffer.concat(remaining).toString('utf8')).toBe(actual);
    });

    it('customer cancellation leaves the generation promise running without a stream-close rejection', async () => {
        let finish!: (response: NextResponse) => void;
        const work = new Promise<NextResponse>((resolve) => {
            finish = resolve;
        });
        const response = await withKeepalive(work, { sse: true, afterMs: 1, trickleMs: 5 });
        const reader = response.body!.getReader();
        await reader.read();
        const cancelled = reader.cancel();
        finish(new NextResponse('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
        await cancelled;
        expect((await work).status).toBe(200);
    });
});
