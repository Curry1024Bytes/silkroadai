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

    it('前缀大小写不敏感:Asset:// / ASSET:// 也剥成裸 id(客户偶发大写,上游只认小写)', () => {
        const body = {
            content: [
                { url: 'Asset://asset-20260101120000-abcdef' },
                { url: 'ASSET://asset-20260101120000-ffffff' },
                { url: 'AsSeT://asset-20260101120000-111111' },
            ],
        };
        const out = stripAssetUri(body) as typeof body;
        expect(out.content[0].url).toBe('asset-20260101120000-abcdef');
        expect(out.content[1].url).toBe('asset-20260101120000-ffffff');
        expect(out.content[2].url).toBe('asset-20260101120000-111111');
    });
});

describe('arkFailError', () => {
    it('审核类 fail_reason → SensitiveContentDetected;其余 → InternalServiceError', () => {
        expect(arkFailError('output audio may contain sensitive information').code).toBe('SensitiveContentDetected');
        expect(arkFailError('内容审核未通过').code).toBe('SensitiveContentDetected');
        expect(arkFailError('some upstream glitch').code).toBe('InternalServiceError');
        expect(arkFailError(null).code).toBe('InternalServiceError');
    });
    it('版权类 fail_reason → CopyrightViolationDetected,message 保留原因', () => {
        const e = arkFailError('The request failed because the output video may be related to copyright restrictions.');
        expect(e.code).toBe('CopyrightViolationDetected');
        expect(e.message).toMatch(/copyright/i);
        expect(arkFailError('内容涉及版权').code).toBe('CopyrightViolationDetected');
    });
});

describe('buildArkTaskResponse', () => {
    const createdAt = new Date('2026-07-24T02:00:00Z');
    it('火山官方形(cn,extended 缺省):只出官方声明字段(draft=false 常驻),不带 upstream_id 等', () => {
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
        // 官方形不含 volc 专属字段;draft 是官方 SDK 任务体字段(2026-10-08 起常驻,非正片不出 draft_task_id)
        expect(r.draft).toBe(false);
        expect('draft_task_id' in r).toBe(false);
        expect('upstream_id' in r).toBe(false);
        // 2026-09 火山官方查询响应新增字段(此前按旧文档只出 11 个,客户按新文档校验就缺项):
        // 上游(xinhankr)不回显 → 落库提交参数 / 官方默认值
        expect(r.execution_expires_after).toBe(172800);
        expect(r.framespersecond).toBe(24);
        expect(r.generate_audio).toBe(false);
        expect(r.seed).toBe(999);
        expect(r.service_tier).toBe('default');
        expect(r.output_format).toBe('mp4');
        expect(r.frames).toBe(24 * 5 + 1);
        // 客户没传 safety_identifier / tools → 省略(官方:未设置不返回 / 未使用工具不返回)
        expect('safety_identifier' in r).toBe(false);
        expect('tools' in r).toBe(false);
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
            'execution_expires_after',
            'frames',
            'framespersecond',
            'generate_audio',
            'output_format',
            'safety_identifier',
            'seed',
            'service_tier',
            'tools',
            'draft', // 官方 SDK 任务体字段(2026-10-08 样片模式起常驻)
            'draft_task_id',
        ]);
        expect(Object.keys(r).filter((k) => !officialKeys.has(k))).toEqual([]);
    });

    it('cn 官方形:落库的 safety_identifier / output_format / tools 回显;智能时长未定时省略 frames', () => {
        const r = buildArkTaskResponse({
            taskId: 'cgt-1b',
            internalModel: 'seedance-2-5',
            status: 'running',
            createdAt,
            resolution: '480p',
            duration: -1,
            submitted: { safetyIdentifier: 'end-user-42', outputFormat: 'mov', tools: [{ type: 'web_search' }] },
        });
        expect(r.safety_identifier).toBe('end-user-42');
        expect(r.output_format).toBe('mov');
        expect(r.tools).toEqual([{ type: 'web_search' }]);
        expect('frames' in r).toBe(false);
        // execution_expires_after:客户传了回显客户值(官方创建参数),没传给官方默认
        const withExp = buildArkTaskResponse({
            taskId: 'cgt-1e',
            internalModel: 'seedance-2-5',
            status: 'running',
            createdAt,
            submitted: { executionExpiresAfter: 3600 },
        });
        expect(withExp.execution_expires_after).toBe(3600);
        expect(r.execution_expires_after).toBe(172800);
        // 存量行三列 NULL → 缺省 mp4、省略 safety_identifier/tools
        const old = buildArkTaskResponse({
            taskId: 'cgt-1c',
            internalModel: 'seedance-2-5',
            status: 'running',
            createdAt,
            submitted: { safetyIdentifier: null, outputFormat: null, tools: null },
        });
        expect(old.output_format).toBe('mp4');
        expect('safety_identifier' in old).toBe(false);
        expect('tools' in old).toBe(false);
    });

    it('cn 官方形 + 上游真值(国内版 2.5 480p 走 service-inference.ai):上游 > 落库 > 默认,时间戳取上游', () => {
        const r = buildArkTaskResponse({
            taskId: 'cgt-1d',
            internalModel: 'seedance-2-5',
            status: 'succeeded',
            videoUrl: 'https://vod/x.mp4',
            usage: { completion_tokens: 38830, total_tokens: 38830 },
            createdAt,
            resolution: '480p',
            duration: 4,
            generateAudio: true,
            submitted: { safetyIdentifier: 'stored-id', outputFormat: 'mp4', tools: null },
            upstreamMeta: {
                framespersecond: 24,
                generateAudio: false,
                executionExpiresAfter: 172800,
                seed: 53041,
                createdAt: 1790091874,
                updatedAt: 1790092007,
                lastFrameUrl: '',
                outputFormat: 'mov',
                safetyIdentifier: 'upstream-id',
                serviceTier: 'default',
                frames: 97,
            },
        });
        expect(r.output_format).toBe('mov');
        expect(r.safety_identifier).toBe('upstream-id');
        expect(r.generate_audio).toBe(false);
        expect(r.seed).toBe(53041);
        expect(r.frames).toBe(97);
        expect(r.created_at).toBe(1790091874);
        expect(r.updated_at).toBe(1790092007);
        // 成功态 content 恒有 last_frame_url(无尾帧为空串)
        expect((r.content as Record<string, unknown>).last_frame_url).toBe('');
        expect(r.draft).toBe(false);
    });

    // 2026-10-08 样片模式:draft 回显 = 上游真值 > 落库 > false;正片任务回显客户样片号 draft_task_id。
    it('样片模式回显:样片任务 draft=true(上游真值);正片任务带 draft_task_id(客户样片号)', () => {
        const draft = buildArkTaskResponse({
            taskId: 'cgt-draft',
            internalModel: 'seedance-2-5',
            status: 'succeeded',
            videoUrl: 'https://vod/d.mp4',
            createdAt,
            duration: 5,
            submitted: { draft: true, draftTaskId: null },
            upstreamMeta: { draft: true },
        });
        expect(draft.draft).toBe(true);
        expect('draft_task_id' in draft).toBe(false);
        const final = buildArkTaskResponse({
            taskId: 'cgt-final',
            internalModel: 'seedance-2-5',
            status: 'running',
            createdAt,
            duration: 5,
            submitted: { draft: null, draftTaskId: 'cgt-draft' },
        });
        expect(final.draft).toBe(false);
        expect(final.draft_task_id).toBe('cgt-draft');
        // volc 形同样出 draft_task_id
        const volc = buildArkTaskResponse({
            taskId: 'cgt-vf',
            internalModel: 'doubao-seedance-2.5',
            status: 'running',
            createdAt,
            duration: 5,
            submitted: { draftTaskId: 'cgt-vd' },
            volcMeta: { draft: false },
        });
        expect(volc.draft).toBe(false);
        expect(volc.draft_task_id).toBe('cgt-vd');
    });

    it('volc 形也补齐 output_format / safety_identifier / frames(上游 metadata 真值优先)', () => {
        const r = buildArkTaskResponse({
            taskId: 'cgt-v1',
            internalModel: 'doubao-seedance-2.0',
            status: 'succeeded',
            videoUrl: 'https://vod/x.mp4',
            createdAt,
            duration: 4,
            submitted: { safetyIdentifier: null, outputFormat: null, tools: null },
            volcMeta: {
                framespersecond: 24,
                seed: 1,
                outputFormat: 'mp4',
                safetyIdentifier: 'probe-001',
                serviceTier: 'default',
            },
        });
        expect(r.output_format).toBe('mp4');
        expect(r.safety_identifier).toBe('probe-001');
        expect(r.frames).toBe(97);
        expect(r.service_tier).toBe('default');
        expect(r.draft).toBe(false);
        expect(r.tools).toEqual([]); // volc 基准:tools 恒在(客户契约)
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

    // 2026-08-26 客户实测:volc 客户传火山原生 id 被按 cn 解释 → 403 region_mismatch。
    it('volc 调用方:火山原生 id → 火山渠道对客名;非 volc 仍归一到国内版短名', () => {
        const pairs: Array<[string, string, string]> = [
            ['doubao-seedance-2-5-260628', 'doubao-seedance-2.5', 'seedance-2-5'],
            ['doubao-seedance-2-0-260128', 'doubao-seedance-2.0', 'seedance-2-0'],
            ['doubao-seedance-2-0-fast-260128', 'doubao-seedance-2.0-fast', 'seedance-2-0-fast'],
            ['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2.0-mini', 'seedance-2-0-mini'],
        ];
        for (const [ark, volc, cn] of pairs) {
            expect(normalizeArkModel(ark, true)).toBe(volc);
            expect(normalizeArkModel(ark)).toBe(cn);
        }
    });

    it('volc 渠道 ark 面回显火山原生 id(而不是我们发明的点分名)', () => {
        expect(arkModelEcho('doubao-seedance-2.5')).toBe('doubao-seedance-2-5-260628');
        expect(arkModelEcho('doubao-seedance-2.0')).toBe('doubao-seedance-2-0-260128');
    });

    // 其余渠道(cn/global/promax)不带 upstream_id —— 火山官方形没有这个字段,
    // 它只是给 volc 客户契约脚本的别名。
    it('非 volc 渠道不带 upstream_id', () => {
        const r = buildArkTaskResponse({
            taskId: 'cgt-x',
            internalModel: 'seedance-2-0',
            status: 'running',
            createdAt: new Date(1700000000000),
        });
        expect(r).not.toHaveProperty('upstream_id');
    });

    it('volc 渠道带 upstream_id 且等于 id', () => {
        const r = buildArkTaskResponse({
            taskId: 'cgt-20260827125333-rjzv8',
            internalModel: 'doubao-seedance-2.5',
            status: 'running',
            createdAt: new Date(1700000000000),
            volcMeta: {},
        });
        expect(r.upstream_id).toBe('cgt-20260827125333-rjzv8');
        // 客户脚本的正则
        expect(String(r.upstream_id)).toMatch(/^cgt-\d{14}-[A-Za-z0-9]+$/);
    });
});
