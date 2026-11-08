import { describe, expect, it } from 'vitest';
import {
    buildSvgAuthorBody,
    extractSvg,
    isNativeSvgUnsupported,
    normalizeSvgBackground,
    readSvgAuthorParams,
    svgEffortError,
    svgPaintsCanvas,
    svgRenders,
    svgSafetyError,
    toSvgUsage,
} from '@/lib/image/svg-author';

const NS = 'xmlns="http://www.w3.org/2000/svg"';

describe('svg-author', () => {
    it('读 svg 对象:JSON 嵌套推理强度,缺省为 null', () => {
        expect(readSvgAuthorParams({ model: ' gpt-5.5 ', reasoning: { effort: 'LOW' } })).toEqual({
            model: 'gpt-5.5',
            effort: 'low',
        });
        expect(readSvgAuthorParams({ model: 'gpt-5.5' })).toEqual({ model: 'gpt-5.5', effort: null });
        expect(readSvgAuthorParams(undefined)).toEqual({ model: '', effort: null });
    });

    it('推理强度按官方枚举校验', () => {
        expect(svgEffortError(null)).toBeNull();
        for (const e of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
            expect(svgEffortError(e)).toBeNull();
        expect(svgEffortError('turbo')).toBe(
            "Invalid value: 'turbo'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.",
        );
    });

    it('只认适配器对原生 SVG 的拒绝', () => {
        expect(
            isNativeSvgUnsupported(`{"error":{"message":"Invalid value: 'svg'. Supported values are: 'png'"}}`),
        ).toBe(true);
        expect(isNativeSvgUnsupported('{"error":{"message":"rejected by safety system"}}')).toBe(false);
    });

    it('background 归一', () => {
        expect(normalizeSvgBackground('Transparent')).toBe('transparent');
        expect(normalizeSvgBackground('opaque')).toBe('opaque');
        expect(normalizeSvgBackground('')).toBe('auto');
        expect(normalizeSvgBackground('weird')).toBe('auto');
    });

    it('作者请求体:尺寸写进 viewBox,推理强度只在传了时带上', () => {
        const base = {
            prompt: 'a cat',
            w: 1536,
            h: 1024,
            background: 'opaque' as const,
            referenceB64: 'QUJD',
            referenceMime: 'image/png',
        };
        const b = buildSvgAuthorBody({ ...base, params: { model: 'gpt-5.5', effort: null } });
        expect(b.model).toBe('gpt-5.5');
        expect(b.reasoning_effort).toBeUndefined();
        const text = JSON.stringify(b);
        expect(text).toContain('viewBox=\\"0 0 1536 1024\\"');
        expect(text).toContain('Paint a full-canvas background first.');
        expect(text).toContain('data:image/png;base64,QUJD');
        expect(text).toContain('a cat');
        expect(buildSvgAuthorBody({ ...base, params: { model: 'm', effort: 'high' } }).reasoning_effort).toBe('high');
    });

    it('抽取 SVG:去代码围栏和说明,缺 xmlns 时补上;没有完整 svg → null', () => {
        expect(extractSvg('Here:\n```svg\n<svg viewBox="0 0 1 1"><rect/></svg>\n```\nDone')).toBe(
            `<svg ${NS} viewBox="0 0 1 1"><rect/></svg>`,
        );
        expect(extractSvg(`<svg ${NS}><g/></svg>`)).toBe(`<svg ${NS}><g/></svg>`);
        expect(extractSvg('<svg viewBox="0 0 1 1"><rect')).toBeNull();
        expect(extractSvg('no svg here')).toBeNull();
    });

    it.each([
        ['<svg><script>x</script></svg>', 'script'],
        ['<svg><foreignObject/></svg>', 'foreignObject'],
        ['<svg><image href="a.png"/></svg>', 'embedded image'],
        ['<svg><animate attributeName="x"/></svg>', 'animation'],
        ['<svg onload="x()"></svg>', 'event attribute'],
        ['<svg><a href="https://x.com"><rect/></a></svg>', 'external reference'],
        ['<svg><rect fill="url(https://x.com/a.svg#g)"/></svg>', 'external url'],
        ['<svg><style>@import "x.css";</style></svg>', 'css import'],
        ['<!DOCTYPE svg><svg></svg>', 'doctype'],
    ])('拒绝不安全内容 %s', (svg, why) => {
        expect(svgSafetyError(svg)).toBe(why);
    });

    it('放行内部引用', () => {
        expect(
            svgSafetyError(
                `<svg ${NS}><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><rect fill="url('#g')"/><use href="#g"/></svg>`,
            ),
        ).toBeNull();
    });

    it('librsvg 能渲染才算合格', async () => {
        expect(
            await svgRenders(`<svg ${NS} viewBox="0 0 8 8" width="8" height="8"><rect width="8" height="8"/></svg>`),
        ).toBe(true);
        expect(await svgRenders(`<svg ${NS} viewBox="0 0 8 8"><rect></svg>`)).toBe(false);
    });

    it.each([
        [`<svg ${NS}><title>t</title><rect width="100%" height="100%" fill="#fff"/></svg>`, true],
        [
            `<svg ${NS}><defs><rect id="a" width="1" height="1"/></defs><rect x="0" y="0" width="1024" height="1024"/></svg>`,
            true,
        ],
        [`<svg ${NS}><g><rect width="100%" height="100%" fill="#000"/></g></svg>`, true],
        [`<svg ${NS}><rect width="100%" height="100%" fill="none"/></svg>`, false],
        [`<svg ${NS}><rect width="500" height="1024"/></svg>`, false],
        [`<svg ${NS}><rect x="10" width="100%" height="100%"/></svg>`, false],
        [`<svg ${NS}><circle r="4"/><rect width="100%" height="100%"/></svg>`, false],
    ])('svgPaintsCanvas %s → %s', (svg, want) => {
        expect(svgPaintsCanvas(svg, 1024, 1024)).toBe(want);
    });

    it('作者 usage 换成官方 svg_usage', () => {
        expect(
            toSvgUsage(
                {
                    model: 'gpt-5.5-2026-04-23',
                    usage: {
                        prompt_tokens: 1550,
                        completion_tokens: 166,
                        total_tokens: 1716,
                        completion_tokens_details: { reasoning_tokens: 0 },
                    },
                },
                'gpt-5.5',
            ),
        ).toEqual({
            input_tokens: 1550,
            model: 'gpt-5.5-2026-04-23',
            output_tokens: 166,
            reasoning_tokens: 0,
            total_tokens: 1716,
        });
        expect(toSvgUsage({ usage: { prompt_tokens: 3, completion_tokens: 4 } }, 'gpt-5.5')).toEqual({
            input_tokens: 3,
            model: 'gpt-5.5',
            output_tokens: 4,
            reasoning_tokens: 0,
            total_tokens: 7,
        });
    });
});
