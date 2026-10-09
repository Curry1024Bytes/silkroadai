/**
 * 成片实测元数据:mp4 头部解析(Range 读)+ 宽高 → 火山 ratio 枚举 + 时长取整。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeVideoMeta, ratioFromDimensions, roundDurationSec } from '../video-probe';

function box(type: string, payload: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + payload.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, payload]);
}

/** 最小 mp4 头:ftyp + moov(mvhd + trak/tkhd)+ 一个声明很大、实际被 Range 截断的 mdat。 */
function mp4Head(durationMs: number, w: number, h: number): Buffer {
    const mvhd = Buffer.alloc(100);
    mvhd.writeUInt32BE(1000, 12); // timescale
    mvhd.writeUInt32BE(durationMs, 16);
    const tkhd = Buffer.alloc(84);
    tkhd.writeUInt32BE(w * 65536, 76);
    tkhd.writeUInt32BE(h * 65536, 80);
    const moov = box('moov', Buffer.concat([box('mvhd', mvhd), box('trak', box('tkhd', tkhd))]));
    const mdatHead = Buffer.alloc(8);
    mdatHead.writeUInt32BE(6_913_608, 0);
    mdatHead.write('mdat', 4, 'latin1');
    return Buffer.concat([box('ftyp', Buffer.alloc(24)), moov, mdatHead, Buffer.alloc(4096)]);
}

afterEach(() => vi.unstubAllGlobals());

describe('ratioFromDimensions', () => {
    it.each([
        [1280, 720, '16:9'],
        [1282, 720, '16:9'], // 成片像素对齐后的常见偏差
        [720, 1280, '9:16'],
        [1248, 704, '16:9'],
        [960, 960, '1:1'],
        [1112, 834, '4:3'],
        [834, 1112, '3:4'],
        [1470, 630, '21:9'],
    ])('%i×%i → %s', (w, h, want) => {
        expect(ratioFromDimensions(w, h)).toBe(want);
    });

    it('非法宽高 → null', () => {
        expect(ratioFromDimensions(0, 720)).toBeNull();
        expect(ratioFromDimensions(1280, 0)).toBeNull();
    });
});

describe('roundDurationSec', () => {
    it('成片秒数取整到官方回显口径', () => {
        expect(roundDurationSec(4.087)).toBe(4);
        expect(roundDurationSec(5.086)).toBe(5);
        expect(roundDurationSec(10.101)).toBe(10);
        expect(roundDurationSec(25.056)).toBe(25);
    });
});

describe('probeVideoMeta', () => {
    it('Range 读头部 → 时长 + 宽高(mdat 被截断不影响)', async () => {
        const fetchMock = vi.fn(async () => new Response(new Uint8Array(mp4Head(10101, 720, 1280)), { status: 206 }));
        vi.stubGlobal('fetch', fetchMock);
        const meta = await probeVideoMeta('https://vod/x.mp4?auth_key=1');
        expect(meta).toEqual({ durationSec: 10.101, width: 720, height: 1280 });
        const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
        expect((init.headers as Record<string, string>).Range).toBe('bytes=0-262143');
    });

    it('上游非 2xx / 不是 mp4 / 网络异常 → null(不抛)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('denied', { status: 403 })),
        );
        expect(await probeVideoMeta('https://vod/x.mp4')).toBeNull();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('not a video at all', { status: 200 })),
        );
        expect(await probeVideoMeta('https://vod/x.mp4')).toBeNull();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('ECONNRESET');
            }),
        );
        expect(await probeVideoMeta('https://vod/x.mp4')).toBeNull();
    });
});
