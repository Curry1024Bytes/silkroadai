/**
 * 上游报错分类/脱敏单测。语料全部是 2026-08-17 从真实上游抓到的原始报文
 * (popreels 事故排查过程中,对 token.xinhankr / 筷子开放平台的实测响应)。
 *
 * 两条不可退让的性质,每条都有守护用例:
 *  ① 对客文案绝不含上游身份(域名/IP/中间商厂商名/上游 request id)——#271;
 *  ② 兜底分支也要说人话(带脱敏后的上游原因,或明说「上游没给原因」)。
 */
import { describe, expect, it } from 'vitest';
import { classifyUpstreamError, friendlyUpstreamError, sanitizeUpstreamText } from '../upstream-error';

/** 真实上游报文语料(逐字,勿改)。 */
const REAL = {
    // 本次事故的上游原文(运营找上游按 request id 查回来的)
    sensitiveText:
        '{"error":{"code":"400","message":"The request failed because the input text \'content[0]\' may contain sensitive information. Request id: 021786935845815e9364cfcb645e8222cc1f22dec5fb736ab25e0","type":"api_error"}}',
    // 同日 zyt 的 2.5 失败:审核结果被包在「素材转换失败」里
    sensitiveImage:
        '{"error":{"code":"400","message":"素材转换失败: 素材处理失败(asset-20260817133221-8kb6b): The request failed because the input image may contain sensitive information. Request ID: 2026081713322146646D100C2ED0C930C8_asset-20260817133221-8kb6b","type":"api_error"}}',
    resolution: '{"error":{"code":"400","message":"当前分辨率 720p 不支持","type":"api_error"}}',
    durationMode:
        '{"error":{"code":"InvalidParameter","message":"the parameter duration specified in the request is not valid for model doubao-seedance-2-0 in r2v Request id: 021786948402615b71a54db2718758900f1b5b7cc45ea65c7ca6e","type":"BadRequest"}}',
    mediaFetch:
        '{"error":{"code":"400","message":"素材转换失败: [Failed to download media from the provided URL. Please check if the link is accessible]","type":"api_error"}}',
    kuaiziModel:
        '{"code":"InvalidParameter","message":"invalid model \\"pro\\", must be one of: doubao-seedance-2-0-260128, doubao-seedance-2-0-fast-260128","type":"BadRequest","request_id":"7f9a72b7476bc7838a470c3df57258da"}',
    balance: '{"error":{"code":"400","message":"账户余额不足5元,请充值 (token.xinhankr.com)","type":"api_error"}}',
};

/** 对客文案里绝不允许出现的东西。 */
const FORBIDDEN = [
    'xinhankr',
    'artsmcp',
    'artsdance',
    'dreamina',
    'kuaizi',
    'aiopenapi',
    'byteplus',
    'volces',
    'volcengine',
    'nginx',
    '021786935845815e9364cfcb645e8222cc1f22dec5fb736ab25e0',
    '7f9a72b7476bc7838a470c3df57258da',
    'http://',
    'https://',
];

describe('脱敏(#271 硬约束)', () => {
    it.each(Object.entries(REAL))('%s 的对客文案不含任何上游身份', (_k, body) => {
        const msg = friendlyUpstreamError(body, 400);
        const lower = msg.toLowerCase();
        for (const bad of FORBIDDEN) expect(lower).not.toContain(bad.toLowerCase());
    });

    it('剥 request id / URL / IP / 厂商名,保留正常文字', () => {
        expect(sanitizeUpstreamText('失败 Request id: 0217869abcdef1234567890abcdef')).toBe('失败');
        expect(sanitizeUpstreamText('bad https://token.xinhankr.com/v1/x 了')).toBe('bad 了');
        expect(sanitizeUpstreamText('连不上 10.0.0.5:3000')).toBe('连不上');
        expect(sanitizeUpstreamText('model artsdance-2-0-pro-260801 无效')).toBe('model 无效');
    });

    it('【不】剥我们自己的素材 id —— 客户要靠它定位是哪张图', () => {
        expect(sanitizeUpstreamText('素材处理失败(asset-20260817133221-8kb6b)')).toContain(
            'asset-20260817133221-8kb6b',
        );
        expect(sanitizeUpstreamText('组 group-20260719153506-b945c6 不存在')).toContain('group-20260719153506-b945c6');
    });
});

describe('分类精度 —— 客户要能照着报错自己改', () => {
    it('提示词被安全审核拒 → 说明是【提示词】,不是图', () => {
        const r = classifyUpstreamError(REAL.sensitiveText, 400);
        expect(r.category).toBe('content_safety');
        expect(r.message).toContain('提示词');
        expect(r.message).not.toContain('参考图');
    });

    it('参考图被安全审核拒 → 说明是【参考图】并带上素材 id', () => {
        const r = classifyUpstreamError(REAL.sensitiveImage, 400);
        expect(r.category).toBe('content_safety');
        expect(r.message).toContain('参考图');
        // 审核必须先于「素材」判 —— 否则会被误报成下载失败
        expect(r.message).not.toContain('下载失败');
        expect(r.message).toContain('asset-20260817133221-8kb6b');
    });

    it('素材真的拉不到 → 才是下载失败', () => {
        const r = classifyUpstreamError(REAL.mediaFetch, 400);
        expect(r.category).toBe('media_fetch');
        expect(r.message).toContain('下载失败');
    });

    it('分辨率不支持 → 分辨率类,且带上游原因', () => {
        const r = classifyUpstreamError(REAL.resolution, 400);
        expect(r.category).toBe('resolution');
        expect(r.message).toContain('分辨率');
        expect(r.message).toContain('720p');
    });

    it('duration 按模式不合法 → 提示参考模式会影响可选时长', () => {
        const r = classifyUpstreamError(REAL.durationMode, 400);
        expect(r.category).toBe('duration');
        expect(r.message).toContain('时长');
        expect(r.message).toContain('参考');
    });

    it('上游账户余额问题 → 归到服务方,不让客户以为是自己余额', () => {
        const r = classifyUpstreamError(REAL.balance, 400);
        expect(r.category).toBe('upstream_account');
        expect(r.message).toContain('服务方');
        // 不把「余额不足」原文抛给客户(会被误读成客户自己欠费)
        expect(r.message).not.toContain('账户余额不足5元');
    });

    it('限流 → 可重试文案', () => {
        expect(classifyUpstreamError('{"message":"rate limit exceeded"}', 429).category).toBe('rate_limited');
        expect(classifyUpstreamError('{"message":"whatever"}', 429).category).toBe('rate_limited');
    });

    it('版权 → 版权类', () => {
        const r = classifyUpstreamError('{"error":{"message":"copyright violation detected in input image"}}', 400);
        expect(r.category).toBe('copyright');
        expect(r.message).toContain('版权');
    });

    it('任务不存在 → 任务失效', () => {
        expect(classifyUpstreamError('{"error":{"message":"任务不存在"}}', 400).category).toBe('task_gone');
    });
});

describe('兜底也要说人话(本次事故的核心痛点)', () => {
    it('未命中已知类 → 带出脱敏后的上游原因,不再是一句 upstream rejected the request', () => {
        const r = classifyUpstreamError('{"error":{"message":"model is temporarily offline for maintenance"}}', 400);
        expect(r.category).toBe('unknown');
        expect(r.message).toContain('temporarily offline for maintenance');
        expect(r.message).not.toBe('upstream rejected the request');
    });

    it('上游只给空体 → 明说「上游未返回具体原因」,并提示提供请求时间', () => {
        const r = classifyUpstreamError('', 400);
        expect(r.category).toBe('unknown');
        expect(r.message).toContain('未返回具体原因');
        expect(r.message).toContain('请求时间');
    });

    it('非 JSON(HTML 错误页)→ 不崩,且不泄露 server 标识', () => {
        const r = classifyUpstreamError(
            '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>',
            502,
        );
        expect(r.message).not.toContain('nginx');
        expect(r.message).toContain('上游暂时不可用');
    });

    it('5xx → 可重试', () => {
        expect(classifyUpstreamError('{"error":{"message":"internal error"}}', 500).category).toBe(
            'upstream_unavailable',
        );
    });
});
