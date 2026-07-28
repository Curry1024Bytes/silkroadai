/**
 * 真人视觉认证 Action 单测(2026-07-29,「火山」渠道):
 * CreateVisualValidateSession / GetVisualValidateResult 翻译到 provider + 火山 envelope。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { resolveEnterpriseAuth, createSession, getGroupId } = vi.hoisted(() => ({
    resolveEnterpriseAuth: vi.fn(),
    createSession: vi.fn(),
    getGroupId: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/enterprise/keys', () => ({ resolveEnterpriseAuth }));
vi.mock('@/lib/enterprise/assets', () => ({
    AssetError: class AssetError extends Error {},
    deleteAsset: vi.fn(),
    fetchAssetFromUrl: vi.fn(),
    newAssetId: vi.fn(),
    storeAsset: vi.fn(),
}));
vi.mock('@/lib/enterprise/real-person', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/lib/enterprise/real-person')>();
    return { ...mod, createVisualValidateSession: createSession, getVisualValidateGroupId: getGroupId };
});

import { POST } from '../route';
import { RealPersonError } from '@/lib/enterprise/real-person';

const CUSTOMER = { ok: true, customer: { userId: 'u1', tenantId: null, keyId: 'k1', upstreamKey: 'up' } };

function req(action: string, body?: unknown): NextRequest {
    return new NextRequest(`http://128.241.232.23/api?Action=${action}&Version=2024-01-01`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-ent-' + 'a'.repeat(48), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    resolveEnterpriseAuth.mockResolvedValue(CUSTOMER);
});

describe('CreateVisualValidateSession', () => {
    it('成功 → 火山 envelope 返 BytedToken/H5Link/ExpiresIn', async () => {
        createSession.mockResolvedValue({ bytedToken: 'byted-x', h5Link: 'https://ark/h5', expiresIn: 120 });
        const res = await POST(req('CreateVisualValidateSession', { CallbackURL: 'https://cb', ProjectName: '' }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as { ResponseMetadata: { Action: string }; Result: Record<string, unknown> };
        expect(j.ResponseMetadata.Action).toBe('CreateVisualValidateSession');
        expect(j.Result).toEqual({ BytedToken: 'byted-x', H5Link: 'https://ark/h5', ExpiresIn: 120 });
    });

    it('无 ExpiresIn 时省略该字段', async () => {
        createSession.mockResolvedValue({ bytedToken: 'byted-y', h5Link: 'https://ark/h5' });
        const res = await POST(req('CreateVisualValidateSession', {}));
        const j = (await res.json()) as { Result: Record<string, unknown> };
        expect(j.Result).toEqual({ BytedToken: 'byted-y', H5Link: 'https://ark/h5' });
    });

    it('上游未配置 → 503 火山 Error envelope', async () => {
        createSession.mockRejectedValue(new RealPersonError(503, 'ServiceUnavailable', '真人认证渠道未配置'));
        const res = await POST(req('CreateVisualValidateSession', {}));
        expect(res.status).toBe(503);
        const j = (await res.json()) as { ResponseMetadata: { Error: { Code: string } } };
        expect(j.ResponseMetadata.Error.Code).toBe('ServiceUnavailable');
    });

    it('key 无效 → 401,不打上游', async () => {
        resolveEnterpriseAuth.mockResolvedValue({ ok: false, status: 401, code: 'x', message: 'bad key' });
        const res = await POST(req('CreateVisualValidateSession', {}));
        expect(res.status).toBe(401);
        expect(createSession).not.toHaveBeenCalled();
    });
});

describe('GetVisualValidateResult', () => {
    it('成功 → 返 GroupId', async () => {
        getGroupId.mockResolvedValue('group-20260729-abc');
        const res = await POST(req('GetVisualValidateResult', { BytedToken: 'byted-x', ProjectName: '' }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as { Result: { GroupId: string } };
        expect(j.Result.GroupId).toBe('group-20260729-abc');
        expect(getGroupId).toHaveBeenCalledWith('byted-x');
    });

    it('缺 BytedToken → 400', async () => {
        const res = await POST(req('GetVisualValidateResult', {}));
        expect(res.status).toBe(400);
        expect(getGroupId).not.toHaveBeenCalled();
    });

    it('认证未完成 → 404 ValidateNotReady(透传上游 message)', async () => {
        getGroupId.mockRejectedValue(new RealPersonError(404, 'ValidateNotReady', '用户未完成认证'));
        const res = await POST(req('GetVisualValidateResult', { BytedToken: 'byted-pending' }));
        expect(res.status).toBe(404);
        const j = (await res.json()) as { ResponseMetadata: { Error: { Code: string; Message: string } } };
        expect(j.ResponseMetadata.Error.Code).toBe('ValidateNotReady');
        expect(j.ResponseMetadata.Error.Message).toBe('用户未完成认证');
    });
});
