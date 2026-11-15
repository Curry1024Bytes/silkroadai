import { describe, expect, it } from 'vitest';
import {
    VIDEO_TOKEN_COMBOS,
    formatVideoTokenPrice,
    isTaskUsageExpression,
    parseVideoTokenExpression,
    readVideoTokenPrice,
    rewriteVideoTokenExpression,
    videoTokenInputLabel,
    videoTokenCombosForModel,
    videoTokenKey,
    type VideoTokenCell,
} from '@/lib/admin/pricing-video-token-expression';

/** Verbatim from prod new-api 2026-11-06: doubao-seedance-2-0-mini-260615. */
const LIVE =
    'u("resolution") == "480p" && u("video_input") == "none" ? tier("480p·none", u("tokens") * 3.07 / 1000000) : u("resolution") == "480p" && u("video_input") == "video" ? tier("480p·video", u("tokens") * 1.87 / 1000000) : u("resolution") == "720p" && u("video_input") == "none" ? tier("720p·none", u("tokens") * 3.07 / 1000000) : u("resolution") == "720p" && u("video_input") == "video" ? tier("720p·video", u("tokens") * 1.87 / 1000000) : u("resolution") == "1080p" && u("video_input") == "none" ? tier("1080p·none", u("tokens") * 3.4 / 1000000) : u("resolution") == "1080p" && u("video_input") == "video" ? tier("1080p·video", u("tokens") * 2.07 / 1000000) : u("resolution") == "4k" && u("video_input") == "none" ? tier("4k·none", u("tokens") * 3.4 / 1000000) : tier("4k·video", u("tokens") * 2.07 / 1000000)';

const cells = (prices: number[]): VideoTokenCell[] =>
    VIDEO_TOKEN_COMBOS.map((combo, index) => ({ ...combo, price: prices[index] }));

describe('videoTokenCombosForModel', () => {
    it('uses only 480p and 720p for Seedance 2.0 Mini', () => {
        expect(videoTokenCombosForModel('doubao-seedance-2-0-mini-260615').map(videoTokenKey)).toEqual([
            '480p·none',
            '480p·video',
            '720p·none',
            '720p·video',
        ]);
        expect(videoTokenCombosForModel('seedance-2-0-mini')).toHaveLength(4);
    });

    it('keeps all eight cells for other models and unknown names', () => {
        expect(videoTokenCombosForModel('doubao-seedance-2-0-260128')).toHaveLength(8);
        expect(videoTokenCombosForModel()).toHaveLength(8);
    });

    it('uses the domestic Fast and 2.5 matrices while leaving global names unchanged', () => {
        expect(videoTokenCombosForModel('doubao-seedance-2-0-fast-260128').map(videoTokenKey)).toEqual([
            '480p·none',
            '480p·video',
            '720p·none',
            '720p·video',
        ]);
        expect(videoTokenCombosForModel('doubao-seedance-2-5-260628').map(videoTokenKey)).toEqual([
            '480p·none',
            '480p·video',
            '720p·none',
            '720p·video',
            '1080p·none',
            '1080p·video',
        ]);
        expect(videoTokenCombosForModel('seedance2.5-global-720p')).toHaveLength(8);
        expect(videoTokenCombosForModel('seedance2.0-fast-promax-720p')).toHaveLength(8);
    });
});

describe('parseVideoTokenExpression', () => {
    it('reads the live production formula in canonical order', () => {
        const parsed = parseVideoTokenExpression(LIVE);
        expect(parsed.cells.map((cell) => [videoTokenKey(cell), cell.price])).toEqual([
            ['480p·none', 3.07],
            ['480p·video', 1.87],
            ['720p·none', 3.07],
            ['720p·video', 1.87],
            ['1080p·none', 3.4],
            ['1080p·video', 2.07],
            ['4k·none', 3.4],
            ['4k·video', 2.07],
        ]);
        expect(parsed.fallback).toEqual({ resolution: '4k', video_input: 'video' });
    });

    it('accepts the formula with newlines and extra spacing', () => {
        expect(parseVideoTokenExpression(LIVE.replace(/ \? /g, '\n  ? ')).cells).toEqual(
            parseVideoTokenExpression(LIVE).cells,
        );
    });

    it('rejects a formula missing a cell', () => {
        const short = LIVE.replace(
            'u("resolution") == "4k" && u("video_input") == "none" ? tier("4k·none", u("tokens") * 3.4 / 1000000) : ',
            '',
        );
        expect(() => parseVideoTokenExpression(short)).toThrow(/全部 8 档/);
    });

    it('rejects a label that disagrees with its condition', () => {
        expect(() => parseVideoTokenExpression(LIVE.replace('tier("480p·none"', 'tier("480p·video"'))).toThrow(
            /名称与条件不一致/,
        );
    });

    it('rejects an unknown resolution', () => {
        expect(() => parseVideoTokenExpression(LIVE.replace('"1080p"', '"8k"'))).toThrow(/不认识的分辨率/);
    });

    it('rejects a scale other than per million', () => {
        expect(() => parseVideoTokenExpression(LIVE.replace('* 3.07 / 1000000', '* 3.07 / 1000'))).toThrow(/每百万/);
    });

    it('rejects a usage field it does not price by', () => {
        expect(() =>
            parseVideoTokenExpression(LIVE.replace('u("video_input") == "none"', 'u("audio") == "none"')),
        ).toThrow(/resolution 和 video_input/);
    });

    it('rejects trailing rules after the fallback tier', () => {
        expect(() => parseVideoTokenExpression(`${LIVE} : tier("extra", u("tokens") * 1 / 1000000)`)).toThrow();
    });

    it('rejects a time-conditioned token formula', () => {
        const deepseek =
            'weekday("Asia/Shanghai") >= 1 ? tier("peak", p * 2 + c * 8) : tier("off_peak", p * 1 + c * 4)';
        expect(() => parseVideoTokenExpression(deepseek)).toThrow();
    });
});

describe('isTaskUsageExpression', () => {
    it('is true only for formulas that read task usage', () => {
        expect(isTaskUsageExpression(LIVE)).toBe(true);
        expect(isTaskUsageExpression('len <= 32000 ? tier("base", p * 2 + c * 8) : tier("t2", p * 4 + c * 16)')).toBe(
            false,
        );
        expect(isTaskUsageExpression('p * 2 + c * 8')).toBe(false);
        expect(isTaskUsageExpression(undefined)).toBe(false);
    });
});

describe('readVideoTokenPrice / formatVideoTokenPrice', () => {
    it('reads plain decimals', () => {
        expect(readVideoTokenPrice('3.07')).toBe(3.07);
        expect(readVideoTokenPrice('0')).toBe(0);
    });

    it('rejects exponents, signs and blanks', () => {
        for (const text of ['3e2', '-1', '', ' 3.07', '.5', '3.']) expect(() => readVideoTokenPrice(text)).toThrow();
    });

    it('round-trips a formatted coefficient', () => {
        for (const value of [0.01, 3.07, 10.27, 1234.56]) {
            expect(readVideoTokenPrice(formatVideoTokenPrice(value))).toBe(value);
        }
    });

    it('refuses to format a non-positive or out-of-range coefficient', () => {
        for (const value of [0, -1, Number.NaN, 2_000_000]) expect(() => formatVideoTokenPrice(value)).toThrow();
    });
});

describe('rewriteVideoTokenExpression', () => {
    it('replaces only the price literals and keeps everything else byte-for-byte', () => {
        const next = cells([1, 2, 3, 4, 5, 6, 7, 8]);
        const rewritten = rewriteVideoTokenExpression(LIVE, next);
        expect(parseVideoTokenExpression(rewritten).cells).toEqual(next);
        // Structure survives: same conditions, labels, order and fallback.
        const strip = (text: string) => text.replace(/\* [\d.]+ \//g, '* X /');
        expect(strip(rewritten)).toBe(strip(LIVE));
    });

    it('is a no-op when the prices are unchanged', () => {
        expect(rewriteVideoTokenExpression(LIVE, parseVideoTokenExpression(LIVE).cells)).toBe(LIVE);
    });

    it('rejects an incomplete set of prices', () => {
        expect(() => rewriteVideoTokenExpression(LIVE, cells([1, 2, 3, 4, 5, 6, 7, 8]).slice(0, 7))).toThrow(
            /全部 8 档/,
        );
    });

    it('reduces the legacy eight-tier Mini formula to its four supported tiers', () => {
        const miniCells: VideoTokenCell[] = [
            { resolution: '480p', video_input: 'none', price: 1.23 },
            { resolution: '480p', video_input: 'video', price: 0.87 },
            { resolution: '720p', video_input: 'none', price: 2.34 },
            { resolution: '720p', video_input: 'video', price: 1.65 },
        ];

        const rewritten = rewriteVideoTokenExpression(LIVE, miniCells, 'doubao-seedance-2-0-mini-260615');
        const parsed = parseVideoTokenExpression(rewritten, 'doubao-seedance-2-0-mini-260615');

        expect(rewritten).not.toContain('1080p');
        expect(rewritten).not.toContain('4k');
        expect(parsed.cells).toEqual(miniCells);
        expect(parsed.fallback).toEqual({ resolution: '720p', video_input: 'video' });
    });

    it('keeps the version prefix when reducing a legacy Mini formula', () => {
        const miniCells: VideoTokenCell[] = [
            { resolution: '480p', video_input: 'none', price: 1 },
            { resolution: '480p', video_input: 'video', price: 2 },
            { resolution: '720p', video_input: 'none', price: 3 },
            { resolution: '720p', video_input: 'video', price: 4 },
        ];
        const rewritten = rewriteVideoTokenExpression(`v1:${LIVE}`, miniCells, 'doubao-seedance-2-0-mini-260615');

        expect(rewritten.startsWith('v1:')).toBe(true);
        expect(parseVideoTokenExpression(rewritten, 'doubao-seedance-2-0-mini-260615').cells).toEqual(miniCells);
    });

    it.each([
        ['doubao-seedance-2-0-fast-260128', 4],
        ['doubao-seedance-2-0-mini-260615', 4],
        ['doubao-seedance-2-5-260628', 6],
    ])('reduces legacy eight-tier formulas for %s', (model, count) => {
        const expected = videoTokenCombosForModel(model).map((combo, index) => ({ ...combo, price: index + 1.25 }));
        const rewritten = rewriteVideoTokenExpression(LIVE, expected, model);
        expect(parseVideoTokenExpression(rewritten, model).cells).toEqual(expected);
        expect(rewritten.match(/tier\(/g)).toHaveLength(count);
        expect(rewritten).not.toContain('4k');
        if (count === 4) expect(rewritten).not.toContain('1080p');
    });
});

describe('videoTokenInputLabel', () => {
    it('labels both reference-video states in each language', () => {
        expect(videoTokenInputLabel('none')).toBe('无参考视频');
        expect(videoTokenInputLabel('video')).toBe('有参考视频');
        expect(videoTokenInputLabel('none', true)).toBe('no reference video');
        expect(videoTokenInputLabel('video', true)).toBe('with reference video');
    });
});
