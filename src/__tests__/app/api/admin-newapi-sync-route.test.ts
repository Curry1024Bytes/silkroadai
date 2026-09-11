import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocked = vi.hoisted(() => ({ resolveAdmin: vi.fn(), preview: vi.fn(), apply: vi.fn() }));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: mocked.resolveAdmin }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/admin/newapi-sync', () => {
    class NewApiSyncError extends Error {
        constructor(
            public code: string,
            message: string,
            public status = 409,
        ) {
            super(message);
        }
    }
    return { NewApiSyncError, previewNewApiSync: mocked.preview, applyNewApiSync: mocked.apply };
});

import { POST } from '@/app/api/admin/newapi-sync/route';
import { NewApiSyncError } from '@/lib/admin/newapi-sync';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const TOKEN = `${Date.parse('2026-09-11T08:00:00Z')}.${'a'.repeat(64)}`;
const PREVIEW = { preview_token: TOKEN, items: [], warnings: [], unchanged: { groups: 1, models: 2, prices: 3 } };
const ADMIN = { role: 'superadmin', tenant_id: 'tenant-a', user: { id: 'admin-1' }, viaBreakGlass: false };
const SELECTION = { preview_token: TOKEN, selected: ['model:gpt-test'], activate: [] };

function request(body: unknown = {}, query = '') {
    return new NextRequest(`https://portal.test/api/admin/newapi-sync${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocked.resolveAdmin.mockResolvedValue(ADMIN);
    mocked.preview.mockResolvedValue(PREVIEW);
    mocked.apply.mockResolvedValue({ preview: PREVIEW, applied: { groups: 0, models: 1, prices: 0 } });
});

describe('POST /api/admin/newapi-sync', () => {
    it('requires superadmin before reading source, parsing intent or writing changes', async () => {
        mocked.resolveAdmin.mockResolvedValue(null);
        const req = request(SELECTION, '?dryRun=false');
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

    it('uses the platform tenant for a break-glass administrator without tenant_id', async () => {
        mocked.resolveAdmin.mockResolvedValue({ ...ADMIN, tenant_id: null, user: null, viaBreakGlass: true });
        const response = await POST(request(SELECTION, '?dryRun=false'));
        expect(response.status).toBe(200);
        expect(mocked.apply).toHaveBeenCalledWith(PLATFORM_TENANT_ID, null, TOKEN, {
            selected: SELECTION.selected,
            activate: [],
        });
    });

    it('applies only an explicit dryRun=false with the signed token and chosen operations', async () => {
        const response = await POST(request({ ...SELECTION, activate: ['model:gpt-test'] }, '?dryRun=false'));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ dryRun: false, applied: { groups: 0, models: 1, prices: 0 } });
        expect(mocked.apply).toHaveBeenCalledWith('tenant-a', 'admin-1', TOKEN, {
            selected: ['model:gpt-test'],
            activate: ['model:gpt-test'],
        });
        expect(mocked.preview).not.toHaveBeenCalled();
    });

    it.each([{ selected: ['model:gpt-test'] }, { preview_token: TOKEN }, { preview_token: TOKEN, selected: [] }])(
        'rejects applying without both a preview and a nonempty selection: %j',
        async (body) => {
            const response = await POST(request(body, '?dryRun=false'));
            expect(response.status).toBe(400);
            expect((await response.json()).error).toBe('preview_required');
            expect(mocked.apply).not.toHaveBeenCalled();
        },
    );

    it.each([{ tenant_id: 'tenant-b' }, { selected: 'all' }, { preview_token: 'x'.repeat(101) }, { activate: [7] }])(
        'rejects tenant overrides and malformed payloads before accessing data: %j',
        async (body) => {
            const response = await POST(request(body, '?dryRun=false'));
            expect(response.status).toBe(400);
            expect((await response.json()).error).toBe('invalid_input');
            expect(mocked.apply).not.toHaveBeenCalled();
            expect(mocked.preview).not.toHaveBeenCalled();
        },
    );

    it('returns a controlled error for malformed JSON', async () => {
        const response = await POST(
            new NextRequest('https://portal.test/api/admin/newapi-sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{invalid',
            }),
        );
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('invalid_input');
        expect(mocked.preview).not.toHaveBeenCalled();
    });

    it('returns the service stale-preview error without performing another preview implicitly', async () => {
        mocked.apply.mockRejectedValue(new NewApiSyncError('preview_stale', '配置已变化，请重新预览。'));
        const response = await POST(request(SELECTION, '?dryRun=false'));
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: 'preview_stale', message: '配置已变化，请重新预览。' });
        expect(mocked.preview).not.toHaveBeenCalled();
    });

    it.each(['P2034', 'P2025', 'P2002'])(
        'turns concurrent database conflict %s into a fresh-preview request',
        async (code) => {
            mocked.apply.mockRejectedValue({ code, meta: { secret: 'db-password-sensitive' } });
            const response = await POST(request(SELECTION, '?dryRun=false'));
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual({
                error: 'preview_stale',
                message: '配置正在被修改，请重新预览后再确认。',
            });
        },
    );

    it.each(['preview', 'apply'] as const)('does not expose a sensitive raw exception from %s', async (operation) => {
        const secret = 'sk-upstream-private-credential';
        mocked[operation].mockRejectedValue(
            new Error(`http://internal-newapi:3000/channel api_key=${secret} password=database-secret`),
        );
        const response = await POST(
            request(operation === 'apply' ? SELECTION : {}, operation === 'apply' ? '?dryRun=false' : ''),
        );
        expect(response.status).toBe(502);
        const text = await response.text();
        expect(text).toContain('sync_failed');
        expect(text).not.toContain(secret);
        expect(text).not.toContain('database-secret');
        expect(text).not.toContain('internal-newapi');
    });
});
