import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocked = vi.hoisted(() => ({ resolveAdmin: vi.fn(), preview: vi.fn(), apply: vi.fn() }));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: mocked.resolveAdmin }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/admin/model-publish', () => {
    class ModelPublishError extends Error {
        constructor(
            public code: string,
            message: string,
            public status = 409,
        ) {
            super(message);
        }
    }
    return {
        ModelPublishError,
        previewModelPublish: mocked.preview,
        applyModelPublish: mocked.apply,
    };
});

import { POST } from '@/app/api/admin/model-publish/route';
import { ModelPublishError } from '@/lib/admin/model-publish';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const TOKEN = `${Date.parse('2026-11-16T08:00:00Z')}.${'a'.repeat(64)}`;
const PREVIEW = {
    preview_token: TOKEN,
    channels: [{ id: 12, name: 'GPT 特惠', changes: [{ slug: 'gpt-test', action: 'add' }] }],
    blocked: null,
};
const ADMIN = { role: 'superadmin', tenant_id: 'tenant-a', user: { id: 'admin-1' }, viaBreakGlass: false };

function request(body: unknown = {}, query = '') {
    return new NextRequest(`https://portal.test/api/admin/model-publish${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocked.resolveAdmin.mockResolvedValue(ADMIN);
    mocked.preview.mockResolvedValue(PREVIEW);
    mocked.apply.mockResolvedValue({ preview: PREVIEW, applied: { channels: 1, models: 1 } });
});

describe('POST /api/admin/model-publish', () => {
    it('requires superadmin before reading or publishing configuration', async () => {
        mocked.resolveAdmin.mockResolvedValue(null);
        const req = request({}, '?dryRun=false');
        expect((await POST(req)).status).toBe(401);
        expect(mocked.resolveAdmin).toHaveBeenCalledWith(req, 'superadmin');
        expect(mocked.preview).not.toHaveBeenCalled();
        expect(mocked.apply).not.toHaveBeenCalled();
    });

    it('defaults to a read-only preview scoped to the authenticated tenant', async () => {
        const response = await POST(request());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ dryRun: true, preview: PREVIEW });
        expect(mocked.preview).toHaveBeenCalledWith('tenant-a');
        expect(mocked.apply).not.toHaveBeenCalled();
    });

    it('uses the platform tenant for a break-glass administrator', async () => {
        mocked.resolveAdmin.mockResolvedValue({ ...ADMIN, tenant_id: null, user: null, viaBreakGlass: true });
        const response = await POST(request({ preview_token: TOKEN }, '?dryRun=false'));
        expect(response.status).toBe(200);
        expect(mocked.apply).toHaveBeenCalledWith(PLATFORM_TENANT_ID, null, TOKEN);
    });

    it('applies only an explicit dryRun=false with a preview token', async () => {
        const response = await POST(request({ preview_token: TOKEN }, '?dryRun=false'));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ dryRun: false, applied: { channels: 1, models: 1 } });
        expect(mocked.apply).toHaveBeenCalledWith('tenant-a', 'admin-1', TOKEN);
        expect(mocked.preview).not.toHaveBeenCalled();
    });

    it('rejects publishing without a preview token', async () => {
        const response = await POST(request({}, '?dryRun=false'));
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('preview_required');
        expect(mocked.apply).not.toHaveBeenCalled();
    });

    it.each([
        { tenant_id: 'tenant-b' },
        { preview_token: TOKEN, selected: ['model:gpt-test'] },
        { preview_token: 'x'.repeat(201) },
    ])('rejects tenant overrides and malformed payloads: %j', async (body) => {
        const response = await POST(request(body, '?dryRun=false'));
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('invalid_input');
        expect(mocked.apply).not.toHaveBeenCalled();
        expect(mocked.preview).not.toHaveBeenCalled();
    });

    it('returns a controlled input error for malformed JSON', async () => {
        const req = new NextRequest('https://portal.test/api/admin/model-publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{invalid',
        });
        expect((await POST(req)).status).toBe(400);
        expect(mocked.preview).not.toHaveBeenCalled();
    });

    it('returns expected service errors without exposing channel credentials', async () => {
        mocked.apply.mockRejectedValue(new ModelPublishError('preview_stale', 'new-api 渠道已变化，请重新预览。'));
        const response = await POST(request({ preview_token: TOKEN }, '?dryRun=false'));
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: 'preview_stale', message: 'new-api 渠道已变化，请重新预览。' });
    });

    it('sanitizes unexpected upstream errors', async () => {
        mocked.preview.mockRejectedValue(new Error('api_key=secret-channel-key'));
        const response = await POST(request());
        expect(response.status).toBe(502);
        const body = await response.text();
        expect(body).not.toContain('secret-channel-key');
        expect(body).toContain('model_publish_failed');
    });
});
