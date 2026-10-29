/**
 * log-display 计费口径判断 —— 决定「调用日志」Tokens 列显不显示。
 *
 * 核心:gpt-image-2 / az-gpt-image-2 是【按 token 计费】(ModelRatio,model_price=-1),
 * gpt-image-2-{1,2,4}k 是【按张计费】(ModelPrice≥0)。判据优先用每条请求真实口径,
 * 缺失才回退到这三个明确的固定价别名。
 */
import { describe, expect, it } from 'vitest';
import {
    parseModelPrice,
    isPerImageBilled,
    isImageModel,
    parseCacheTokens,
    isSettlementRefund,
    parseSettlementRefundDetails,
    refundKindOf,
    settlementRefundContent,
    unmatchedFailureRefundContent,
} from '@/lib/newapi/log-display';

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

    it('other 缺失 → 三个固定价别名按张,canonical/az 仍按 token', () => {
        expect(isPerImageBilled(null, 'gpt-image-2')).toBe(false); // gpt-image 族 → 显示
        expect(isPerImageBilled('', 'az-gpt-image-2')).toBe(false); // gpt-image 族 → 显示
        for (const model of ['gpt-image-2-1k', 'gpt-image-2-2k', 'gpt-image-2-4k']) {
            expect(isPerImageBilled(null, model), model).toBe(true);
        }
        expect(isPerImageBilled(undefined, 'gemini-3-pro-image-preview')).toBe(true); // 名字生图 → 藏
        expect(isPerImageBilled(null, 'dall-e-3')).toBe(true); // 名字生图 → 藏
        expect(isPerImageBilled(null, 'gpt-5.4')).toBe(false); // LLM → 显示
    });

    it('other.model_price 始终优先:别名真实走 -1 时仍显示 token', () => {
        expect(isPerImageBilled(GPT_IMAGE_OTHER, 'gpt-image-2-4k')).toBe(false);
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

describe('settlement refunds', () => {
    // new-api 只在实际 < 预扣时记 type=6 结算退款(差额为退款额),实际 > 预扣记的是 type=2 补扣
    const SETTLEMENT = {
        type: 6,
        quota: 49800,
        other: '{"task_id":"task_1","pre_consumed_quota":934700,"actual_quota":884900}',
        content: '任务用量表达式结算',
    };

    it('other 含预扣/实际 quota → 判为结算退款并解析细节', () => {
        expect(isSettlementRefund(SETTLEMENT)).toBe(true);
        expect(parseSettlementRefundDetails(SETTLEMENT)).toEqual({
            preConsumedQuota: 934700,
            actualQuota: 884900,
        });
    });

    it('结算说明:退款额 + 预扣 + 实际', () => {
        expect(settlementRefundContent(SETTLEMENT, (q) => `¥${(q / 1e6).toFixed(4)}`)).toBe(
            '按实际用量结算，退还多扣的 ¥0.0498（预扣 ¥0.9347，实际 ¥0.8849）',
        );
    });

    it('refundKindOf:结算退款 / 失败退款 / 非 type=6', () => {
        expect(refundKindOf(SETTLEMENT)).toBe('settlement');
        expect(refundKindOf({ type: 6, other: '{"task_id":"task_1"}', content: '' })).toBe('failure');
        expect(refundKindOf({ type: 6, other: '{bad json', content: '' })).toBe('failure');
        expect(refundKindOf({ type: 2, other: SETTLEMENT.other })).toBeNull();
        expect(refundKindOf({ type: 5, content: 'boom' })).toBeNull();
    });

    it('配不上预扣行的失败退款说明带退款额', () => {
        expect(unmatchedFailureRefundContent('¥2.00')).toContain('已自动退还预扣的 ¥2.00');
    });

    it('失败退款、坏 JSON、旧数据缺 other → 不误判', () => {
        expect(isSettlementRefund({ type: 6, other: '{"task_id":"task_1"}', content: '' })).toBe(false);
        expect(isSettlementRefund({ type: 6, other: '{bad json', content: '' })).toBe(false);
        expect(isSettlementRefund({ type: 6, other: undefined, content: '' })).toBe(false);
    });

    it('坏 JSON 但 content 是结算原因 → 兼容判为结算退款', () => {
        expect(isSettlementRefund({ type: 6, other: '{bad json', content: 'adaptor计费调整' })).toBe(true);
        expect(parseSettlementRefundDetails({ type: 6, other: '{bad json', content: 'adaptor计费调整' })).toEqual({
            preConsumedQuota: null,
            actualQuota: null,
        });
    });

    it('非 type=6 不判为结算退款', () => {
        expect(isSettlementRefund({ type: 2, other: '{"pre_consumed_quota":1,"actual_quota":2}' })).toBe(false);
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
