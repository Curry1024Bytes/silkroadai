import { describe, it, expect } from 'vitest';
import { encodeApng, inspectApng } from '@/lib/image/apng';

async function solid(w: number, h: number, rgb: string): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    return sharp({ create: { width: w, height: h, channels: 4, background: rgb } })
        .png({ palette: false })
        .toBuffer();
}

describe('apng 最小编码器', () => {
    it('首帧整幅 + 两个子矩形帧 → acTL/fcTL/fdAT 结构正确,普通 PNG 解码器仍读到首帧尺寸', async () => {
        const f0 = await solid(64, 32, '#112233');
        const f1 = await solid(8, 8, '#ff0000');
        const out = encodeApng([
            { png: f0, x: 0, y: 0, delayMs: 100 },
            { png: f1, x: 4, y: 4, delayMs: 50 },
            { png: f1, x: 20, y: 4, delayMs: 50 },
        ]);
        expect(out.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const info = inspectApng(out)!;
        expect(info.frames).toBe(3);
        expect(info.loops).toBe(0);
        expect(info.fctl).toEqual([
            { w: 64, h: 32, x: 0, y: 0, delayMs: 100 },
            { w: 8, h: 8, x: 4, y: 4, delayMs: 50 },
            { w: 8, h: 8, x: 20, y: 4, delayMs: 50 },
        ]);
        const sharp = (await import('sharp')).default;
        const m = await sharp(out).metadata();
        expect([m.width, m.height]).toEqual([64, 32]);
        expect(out.toString('latin1')).toContain('fdAT');
        expect(inspectApng(f0)).toBeNull();
    });

    it('首帧不在 0,0 / 帧色彩类型不一致 / 空帧 → 抛', async () => {
        const rgba = await solid(16, 16, '#000000');
        const sharp = (await import('sharp')).default;
        const rgb = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#000000' } })
            .png({ palette: false })
            .toBuffer();
        expect(() => encodeApng([])).toThrow();
        expect(() => encodeApng([{ png: rgba, x: 1, y: 0, delayMs: 10 }])).toThrow();
        expect(() =>
            encodeApng([
                { png: rgba, x: 0, y: 0, delayMs: 10 },
                { png: rgb, x: 0, y: 0, delayMs: 10 },
            ]),
        ).toThrow();
    });
});
