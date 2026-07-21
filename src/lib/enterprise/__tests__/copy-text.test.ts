/**
 * copyText:裸 IP HTTP 下 navigator.clipboard 为 undefined,必须降级
 * execCommand 路径(2026-07-20 operator 实测复制按钮无效)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../copy-text';

function stubDocument(execResult: boolean) {
    const appended: Array<{ value: string }> = [];
    const doc = {
        createElement: () => {
            const ta = {
                value: '',
                setAttribute: () => {},
                style: {} as Record<string, string>,
                select: () => {},
                setSelectionRange: () => {},
            };
            return ta;
        },
        body: {
            appendChild: (el: { value: string }) => appended.push(el),
            removeChild: () => {},
        },
        execCommand: vi.fn(() => execResult),
    };
    vi.stubGlobal('document', doc);
    return { doc, appended };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('copyText', () => {
    it('clipboard API 可用 → 直接用,不碰 execCommand', async () => {
        const writeText = vi.fn(async () => {});
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        const { doc } = stubDocument(true);
        expect(await copyText('sk-ent-abc')).toBe(true);
        expect(writeText).toHaveBeenCalledWith('sk-ent-abc');
        expect(doc.execCommand).not.toHaveBeenCalled();
    });

    it('HTTP 非 secure context(clipboard undefined)→ execCommand 降级成功', async () => {
        vi.stubGlobal('navigator', {}); // navigator.clipboard === undefined,裸 IP HTTP 真实形态
        const { doc, appended } = stubDocument(true);
        expect(await copyText('sk-ent-abc')).toBe(true);
        expect(doc.execCommand).toHaveBeenCalledWith('copy');
        expect(appended[0]?.value).toBe('sk-ent-abc');
    });

    it('clipboard 写入被拒(权限)→ 仍降级 execCommand', async () => {
        vi.stubGlobal('navigator', {
            clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
        });
        const { doc } = stubDocument(true);
        expect(await copyText('x')).toBe(true);
        expect(doc.execCommand).toHaveBeenCalledWith('copy');
    });

    it('两条路都不可用 → false 不抛', async () => {
        vi.stubGlobal('navigator', {});
        stubDocument(false);
        expect(await copyText('x')).toBe(false);
    });
});
