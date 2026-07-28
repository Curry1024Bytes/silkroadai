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
        expect(arkModelEcho('seedance-2-0-promax')).toBe('seedance-2-0-promax');
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
    it('succeeded:video_url 嵌套 content + usage + error:null + 元数据平铺', () => {
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
        });
        expect(r.id).toBe('cgt-1');
        expect(r.model).toBe('doubao-seedance-2-0-260128');
        expect(r.status).toBe('succeeded');
        expect((r.content as Record<string, unknown>).video_url).toBe('https://vod/x.mp4');
        expect((r.content as Record<string, unknown>).last_frame_url).toBe('https://vod/last.png');
        expect((r.usage as Record<string, unknown>).completion_tokens).toBe(108872);
        expect(r.error).toBeNull();
        expect(r.resolution).toBe('720p');
        expect(r.duration).toBe(5);
        expect(typeof r.created_at).toBe('number');
        expect(r.created_at).toBe(Math.floor(createdAt.getTime() / 1000));
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
        expect(r.content).toEqual({});
    });
    it('running:content 空 error null,无 usage', () => {
        const r = buildArkTaskResponse({
            taskId: 'cgt-3',
            internalModel: 'seedance-2-0',
            status: 'running',
            createdAt,
        });
        expect(r.status).toBe('running');
        expect(r.content).toEqual({});
        expect(r.error).toBeNull();
        expect(r.usage).toBeUndefined();
    });
});
