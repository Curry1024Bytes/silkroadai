/** 火山方舟形态翻译纯函数单测(2026-07-26)。 */
import { describe, expect, it } from 'vitest';
import {
    normalizeArkModel,
    arkModelEcho,
    arkStatus,
    stripAssetUri,
    arkFailError,
    buildArkTaskResponse,
} from '../ark-format';

describe('normalizeArkModel', () => {
    it('火山 doubao id → 内部短名(大小写不敏感)', () => {
        expect(normalizeArkModel('doubao-seedance-2-0-260128')).toBe('seedance-2-0');
        expect(normalizeArkModel('DOUBAO-SEEDANCE-2-0-FAST-260128')).toBe('seedance-2-0-fast');
        expect(normalizeArkModel('doubao-seedance-2-0-mini-260615')).toBe('seedance-2-0-mini');
        expect(normalizeArkModel('doubao-seedance-2-5-260628')).toBe('seedance-2-5');
        expect(normalizeArkModel('SEEDANCE-2.5')).toBe('seedance-2-5');
    });
    it('未知/我们自己的名 → 原样(交后续 model_not_found)', () => {
        expect(normalizeArkModel('seedance-2-0-global')).toBe('seedance-2-0-global');
        expect(normalizeArkModel('foo')).toBe('foo');
    });
});

describe('arkModelEcho', () => {
    it('内部短名 → 火山 id 回显;非映射项原样', () => {
        expect(arkModelEcho('seedance-2-0')).toBe('doubao-seedance-2-0-260128');
        expect(arkModelEcho('seedance-2-0-mini')).toBe('doubao-seedance-2-0-mini-260615');
        expect(arkModelEcho('seedance-2-5')).toBe('doubao-seedance-2-5-260628');
        // promax 系回显 BytePlus ModelArk 形(2026-08-06 客户样例)
        expect(arkModelEcho('seedance-2-0-promax')).toBe('byteplus/seedance-2.0');
        expect(arkModelEcho('seedance-2-0-promax-fast')).toBe('byteplus/seedance-2.0-fast');
        expect(arkModelEcho('seedance-2-0-global')).toBe('seedance-2-0-global');
    });

    it('byteplus/ 形别名可作入参(normalizeArkModel)', () => {
        expect(normalizeArkModel('byteplus/seedance-2.0-fast')).toBe('seedance-2-0-promax-fast');
    });
});

describe('arkStatus', () => {
    it('内部状态 → 火山状态', () => {
        expect(arkStatus('completed')).toBe('succeeded');
        expect(arkStatus('in_progress')).toBe('running');
        expect(arkStatus('queued')).toBe('queued');
        expect(arkStatus('failed')).toBe('failed');
    });
});

describe('stripAssetUri', () => {
    it('深遍历剥 asset:// 前缀,裸 id 不变,不改原对象', () => {
        const body = {
            model: 'x',
            content: [
                { type: 'text', text: 'hi' },
                { type: 'image_url', image_url: { url: 'asset://asset-20260101120000-abcdef' } },
                { type: 'image_url', image_url: { url: 'asset-20260101120000-ffffff' } },
                { type: 'image_url', image_url: { url: 'https://x/a.png' } },
            ],
        };
        const out = stripAssetUri(body) as typeof body;
        expect(out.content[1].image_url!.url).toBe('asset-20260101120000-abcdef');
        expect(out.content[2].image_url!.url).toBe('asset-20260101120000-ffffff');
        expect(out.content[3].image_url!.url).toBe('https://x/a.png');
        // 原对象未变
        expect(body.content[1].image_url!.url).toBe('asset://asset-20260101120000-abcdef');
    });
});

describe('arkFailError', () => {
    it('审核类 fail_reason → SensitiveContentDetected;其余 → InternalServiceError', () => {
        expect(arkFailError('output audio may contain sensitive information').code).toBe('SensitiveContentDetected');
        expect(arkFailError('内容审核未通过').code).toBe('SensitiveContentDetected');
        expect(arkFailError('some upstream glitch').code).toBe('InternalServiceError');
        expect(arkFailError(null).code).toBe('InternalServiceError');
    });
});

describe('buildArkTaskResponse', () => {
    const createdAt = new Date('2026-07-24T02:00:00Z');
    it('火山官方形(cn,extended 缺省):只出官方声明字段,不带 draft/service_tier/seed 等', () => {
        const r = buildArkTaskResponse({
            taskId: 'cgt-1',
            internalModel: 'seedance-2-0',
            status: 'succeeded',
            videoUrl: 'https://vod/x.mp4',
            lastFrameUrl: 'https://vod/last.png',
            usage: { completion_tokens: 108872, total_tokens: 108872 },
            createdAt,
            resolution: '720p',
            duration: 5,
            seed: BigInt(999),
            generateAudio: false,
        });
        expect(r.id).toBe('cgt-1');
        expect(r.model).toBe('doubao-seedance-2-0-260128');
        expect(r.status).toBe('succeeded');
        expect((r.content as Record<string, unknown>).video_url).toBe('https://vod/x.mp4');
        expect((r.content as Record<string, unknown>).last_frame_url).toBe('https://vod/last.png');
        expect((r.usage as Record<string, unknown>).completion_tokens).toBe(108872);
        // 火山官方形:usage 不带 tool_usage
        expect((r.usage as Record<string, unknown>).tool_usage).toBeUndefined();
        expect(r.error).toEqual({ code: '', message: '' });
        expect(r.resolution).toBe('720p');
        expect(r.duration).toBe(5);
        expect(r.ratio).toBe('16:9');
        // 官方形不含 BytePlus 扩展字段(即使入参给了 seed/generateAudio 也不输出)
        expect('draft' in r).toBe(false);
        expect('execution_expires_after' in r).toBe(false);
        expect('framespersecond' in r).toBe(false);
        expect('service_tier' in r).toBe(false);
        expect('tools' in r).toBe(false);
        expect('seed' in r).toBe(false);
        expect('generate_audio' in r).toBe(false);
        // 响应键集 = 火山官方声明白名单子集(无未声明字段)
        const officialKeys = new Set([
            'id',
            'model',
            'status',
            'content',
            'error',
            'created_at',
            'updated_at',
            'resolution',
            'ratio',
            'duration',
            'usage',
        ]);
        expect(Object.keys(r).filter((k) => !officialKeys.has(k))).toEqual([]);
    });

    it('BytePlus 形(promax,extended=true):扩展字段 + usage.tool_usage 常驻,ratio/seed/generate_audio 回显', () => {
        const r = buildArkTaskResponse({
            taskId: 'cgt-4',
            internalModel: 'seedance-2-0-promax-fast',
            status: 'succeeded',
            videoUrl: 'https://vod/y.mp4',
            usage: { completion_tokens: 281700, total_tokens: 281700 },
            createdAt,
            resolution: '720p',
            duration: 13,
            ratio: '16:9',
            seed: BigInt(74196),
            generateAudio: false,
            extended: true,
        });
        expect(r.model).toBe('byteplus/seedance-2.0-fast');
        expect(r.draft).toBe(false);
        expect(r.execution_expires_after).toBe(0);
        expect(r.framespersecond).toBe(0);
        expect(r.service_tier).toBe('');
        expect(r.tools).toBeNull();
        expect(r.seed).toBe(74196);
        expect(r.generate_audio).toBe(false);
        expect(r.ratio).toBe('16:9');
        expect((r.usage as Record<string, unknown>).tool_usage).toEqual({ web_search: 0 });
    });
    it('failed:error 对象带火山码,content 空', () => {
        const r = buildArkTaskResponse({
            taskId: 'cgt-2',
            internalModel: 'seedance-2-0-mini',
            status: 'failed',
            failReason: 'output video may contain sensitive information',
            createdAt,
        });
        expect(r.status).toBe('failed');
        expect((r.error as Record<string, unknown>).code).toBe('SensitiveContentDetected');
        // error 形对齐客户样例:仅 {code,message} 两键
        expect(Object.keys(r.error as Record<string, unknown>).sort()).toEqual(['code', 'message']);
        expect(r.content).toEqual({});
    });
    it('running:content 空 error 空串对象,无 usage', () => {
        const r = buildArkTaskResponse({
            taskId: 'cgt-3',
            internalModel: 'seedance-2-0',
            status: 'running',
            createdAt,
        });
        expect(r.status).toBe('running');
        expect(r.content).toEqual({});
        expect(r.error).toEqual({ code: '', message: '' });
        expect(r.usage).toBeUndefined();
    });
});
