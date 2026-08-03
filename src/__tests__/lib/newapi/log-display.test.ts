/**
 * log-display 计费口径判断 —— 决定「调用日志」Tokens 列显不显示。
 *
 * 核心:gpt-image-2 / az-gpt-image-2 是【按 token 计费】(ModelRatio,model_price=-1),token 就是
 * 计费依据,必须显示;Gemini 生图是【按张计费】(ModelPrice≥0),token 是噪声,显示 "—"。
 * 判据优先用每条请求真实计费口径 other.model_price,缺失才回退模型名(gpt-image 族恒按 token)。
 */
import { describe, expect, it } from 'vitest';
import { parseModelPrice, isPerImageBilled, isImageModel, parseCacheTokens } from '@/lib/newapi/log-display';

// 线上实测样本(见诊断):gpt-image-2 model_price=-1 / model_ratio=0.9286;gemini 生图 model_price 设值 / ratio=0
const GPT_IMAGE_OTHER = '{"model_price":-1,"model_ratio":0.9285714285714286,"completion_ratio":6}';
const GEMINI_IMAGE_OTHER = '{"model_price":0.014286,"model_ratio":0}';
const LLM_OTHER = '{"model_price":-1,"model_ratio":2,"completion_ratio":4}';

describe('parseModelPrice', () => {
    it('从 other JSON 取 model_price(含 -1)', () => {
        expect(parseModelPrice(GPT_IMAGE_OTHER)).toBe(-1);
        expect(parseModelPrice(GEMINI_IMAGE_OTHER)).toBeCloseTo(0.014286);
    });
    it('缺字段 / 空 / 非法 JSON → null', () => {
        expect(parseModelPrice('{"model_ratio":2}')).toBeNull();
        expect(parseModelPrice('')).toBeNull();
        expect(parseModelPrice(null)).toBeNull();
        expect(parseModelPrice(undefined)).toBeNull();
        expect(parseModelPrice('not json')).toBeNull();
    });
});

describe('isPerImageBilled', () => {
    it('优先用 other.model_price:≥0 = 按张(藏 token);-1 = 按 token(显示)', () => {
        expect(isPerImageBilled(GEMINI_IMAGE_OTHER, 'gemini-3-pro-image-preview')).toBe(true); // 按张
        expect(isPerImageBilled(GPT_IMAGE_OTHER, 'gpt-image-2')).toBe(false); // 按 token → 显示
        expect(isPerImageBilled(LLM_OTHER, 'gpt-5.4')).toBe(false); // LLM 按 token
    });

    it('other.model_price 优先级高于模型名(名字含 image 但 model_price=-1 → 显示)', () => {
        // gpt-image-2 名字含 "image",老逻辑会误藏;真实计费口径 model_price=-1 → 显示
        expect(isPerImageBilled(GPT_IMAGE_OTHER, 'gpt-image-2')).toBe(false);
    });

    it('other 缺失 → 回退模型名;gpt-image 族恒按 token(即使缺 other 也显示)', () => {
        expect(isPerImageBilled(null, 'gpt-image-2')).toBe(false); // gpt-image 族 → 显示
        expect(isPerImageBilled('', 'az-gpt-image-2')).toBe(false); // gpt-image 族 → 显示
        expect(isPerImageBilled(undefined, 'gemini-3-pro-image-preview')).toBe(true); // 名字生图 → 藏
        expect(isPerImageBilled(null, 'dall-e-3')).toBe(true); // 名字生图 → 藏
        expect(isPerImageBilled(null, 'gpt-5.4')).toBe(false); // LLM → 显示
    });
});

describe('parseCacheTokens', () => {
    // 线上实测样本(claude prompt-cache 行):prompt_tokens=2 而缓存读 127,885 —— 缓存单列才说得清费用
    const CLAUDE_CACHE_OTHER =
        '{"cache_ratio":0.1,"cache_tokens":127885,"cache_creation_ratio":1.25,"cache_creation_tokens":178,"claude":true}';

    it('从 other JSON 取 cache_tokens(读)/ cache_creation_tokens(写)', () => {
        expect(parseCacheTokens(CLAUDE_CACHE_OTHER)).toEqual({ read: 127_885, write: 178 });
    });

    it('无缓存字段 / 空串 / null / 解析失败 → 0/0', () => {
        expect(parseCacheTokens('{"model_price":-1}')).toEqual({ read: 0, write: 0 });
        expect(parseCacheTokens('')).toEqual({ read: 0, write: 0 });
        expect(parseCacheTokens(null)).toEqual({ read: 0, write: 0 });
        expect(parseCacheTokens('not-json')).toEqual({ read: 0, write: 0 });
    });

    it('非数值 / 负数 → 按 0(防御上游脏数据)', () => {
        expect(parseCacheTokens('{"cache_tokens":"127885","cache_creation_tokens":-3}')).toEqual({
            read: 0,
            write: 0,
        });
    });
});

describe('isImageModel', () => {
    it('名字含 image/dall-e/imagen 命中', () => {
        for (const m of ['gpt-image-2', 'gemini-3-pro-image-preview', 'dall-e-3', 'imagen-4']) {
            expect(isImageModel(m), m).toBe(true);
        }
    });
    it('非生图名(含 LLM / 视频 / 空)不命中', () => {
        for (const m of ['gpt-5.4', 'claude-opus-4-8', 'seedance-2.0-720', '']) {
            expect(isImageModel(m), m).toBe(false);
        }
    });
});
