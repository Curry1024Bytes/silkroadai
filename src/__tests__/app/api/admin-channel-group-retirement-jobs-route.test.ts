import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({
    auth: vi.fn(),
    group: vi.fn(),
    preview: vi.fn(),
    autoPreview: vi.fn(),
    start: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
}));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: mocks.auth }));
vi.mock('@/lib/db', () => ({ prisma: { channelGroup: { findFirst: mocks.group } } }));
vi.mock('@/lib/admin/channel-group-retirement-job', () => ({
    previewRetirementJob: mocks.preview,
    previewOrphanRetirementJob: mocks.autoPreview,
    startRetirementJob: mocks.start,
    listRetirementJobs: mocks.list,
    getRetirementJob: mocks.get,
    resumeRetirementJob: mocks.resume,
    stopRetirementJob: mocks.stop,
}));
import { POST as groupPOST } from '@/app/api/admin/channel-groups/[id]/retire/route';
import { GET as listGET, POST as orphanPOST } from '@/app/api/admin/channel-group-retirement-jobs/route';
import { GET as jobGET, POST as jobPOST } from '@/app/api/admin/channel-group-retirement-jobs/[id]/route';
import { ChannelGroupRetirementError } from '@/lib/admin/channel-group-retirement';

const admin = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const tenant = '00000000-0000-4000-8000-000000000001';
const context = { params: Promise.resolve({ id: 'group' }) };
const request = (body?: unknown) =>
    new NextRequest('https://llmroute.club/api/admin/channel-group-retirement-jobs', {
        method: body ? 'POST' : 'GET',
        ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
    });
beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue(admin);
    mocks.group.mockResolvedValue({ id: 'group', tenant_id: tenant, key: 'old-tier', newapi_group: 'Old group' });
    mocks.preview.mockResolvedValue({ canApply: true, preview_token: 'signed' });
    mocks.autoPreview.mockResolvedValue({ canApply: true, preview_token: 'signed-auto' });
    mocks.start.mockResolvedValue({ id: 'job', status: 'queued' });
    mocks.list.mockResolvedValue({ jobs: [], orphan_groups: [] });
    mocks.get.mockResolvedValue({ id: 'job' });
    mocks.resume.mockResolvedValue({ id: 'job', status: 'queued' });
    mocks.stop.mockResolvedValue({ id: 'job', status: 'cancelled' });
});
describe('retirement HTTP authorization and durable task contract', () => {
    it.each(['group', 'list', 'orphan', 'get', 'resume', 'stop'])(
        'requires superadmin before %s reads or writes',
        async (kind) => {
            mocks.auth.mockResolvedValue(null);
            const response =
                kind === 'group'
                    ? await groupPOST(request({ action: 'preview' }), context)
                    : kind === 'list'
                      ? await listGET(request())
                      : kind === 'orphan'
                        ? await orphanPOST(request({ action: 'preview' }))
                        : kind === 'get'
                          ? await jobGET(request(), context)
                          : await jobPOST(request({ action: kind }), context);
            expect(response.status).toBe(401);
            expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), 'superadmin');
            for (const [name, mock] of Object.entries(mocks)) if (name !== 'auth') expect(mock).not.toHaveBeenCalled();
        },
    );
    it('locates the selected tenant before upstream inspection', async () => {
        mocks.group.mockResolvedValue(null);
        expect((await groupPOST(request({ action: 'preview' }), context)).status).toBe(404);
        expect(mocks.preview).not.toHaveBeenCalled();
    });
    it('uses persisted tier and group identities for a group preview', async () => {
        expect((await groupPOST(request({ action: 'preview' }), context)).status).toBe(200);
        expect(mocks.preview).toHaveBeenCalledWith(
            {
                groupId: 'group',
                tenantId: tenant,
                tierKey: 'old-tier',
                newapiGroup: 'Old group',
                replacementDefaultId: undefined,
            },
            admin,
        );
    });
    it('apply returns a durable job, never the old immediate Portal-only deletion', async () => {
        const response = await groupPOST(request({ action: 'apply', preview_token: 'signed' }), context);
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ job: { id: 'job', status: 'queued' } });
        expect(mocks.start).toHaveBeenCalledWith(expect.anything(), admin, 'signed');
        expect(mocks.resume).not.toHaveBeenCalled();
    });
    it.each([
        {},
        { action: 'delete' },
        { action: 'apply' },
        { action: 'preview', delete_keys: true },
        { action: 'preview', newapi_group: 'forged' },
    ])('rejects invalid group fields %j', async (body) => {
        expect((await groupPOST(request(body), context)).status).toBe(400);
        expect(mocks.group).not.toHaveBeenCalled();
    });
    it('retains explicit group preview compatibility and supports platform null', async () => {
        expect(
            (
                await orphanPOST(
                    request({ action: 'preview', tenant_id: null, tier_key: 'legacy', newapi_group: 'Old group' }),
                )
            ).status,
        ).toBe(200);
        expect(mocks.preview).toHaveBeenCalledWith(
            { groupId: null, tenantId: null, tierKey: 'legacy', newapiGroup: 'Old group' },
            admin,
        );
    });
    it('automatically resolves orphan ownership without an operator-provided group', async () => {
        const response = await orphanPOST(request({ action: 'preview', tenant_id: null, tier_key: 'legacy' }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ preview: { canApply: true, preview_token: 'signed-auto' } });
        expect(mocks.autoPreview).toHaveBeenCalledWith({ tenantId: null, tierKey: 'legacy' }, admin);
        expect(mocks.preview).not.toHaveBeenCalled();
        expect(mocks.start).not.toHaveBeenCalled();
    });
    it('creates a signed archive-only job without inventing a group name', async () => {
        const response = await orphanPOST(
            request({
                action: 'apply',
                tenant_id: tenant,
                tier_key: 'legacy',
                archive_only: true,
                preview_token: 'signed',
            }),
        );
        expect(response.status).toBe(202);
        expect(mocks.start).toHaveBeenCalledWith(
            { groupId: null, tenantId: tenant, tierKey: 'legacy', newapiGroup: '', archiveOnly: true },
            admin,
            'signed',
        );
        expect(mocks.resume).not.toHaveBeenCalled();
    });
    it('passes the reviewed nonempty group to the signed normal job', async () => {
        const response = await orphanPOST(
            request({
                action: 'apply',
                tenant_id: tenant,
                tier_key: 'legacy',
                newapi_group: 'Reviewed group',
                preview_token: 'signed',
            }),
        );
        expect(response.status).toBe(202);
        expect(mocks.start).toHaveBeenCalledWith(
            { groupId: null, tenantId: tenant, tierKey: 'legacy', newapiGroup: 'Reviewed group' },
            admin,
            'signed',
        );
    });
    it.each([
        { action: 'preview' },
        { action: 'apply', tenant_id: null, tier_key: 'a', newapi_group: 'b' },
        { action: 'preview', tenant_id: 'invalid', tier_key: 'a', newapi_group: 'b' },
        { action: 'preview', tenant_id: null, tier_key: 'a', newapi_group: ' ' },
        { action: 'apply', tenant_id: null, tier_key: 'a', preview_token: 'signed' },
        { action: 'preview', tenant_id: null, tier_key: 'a', archive_only: true },
        { action: 'apply', tenant_id: null, tier_key: 'a', archive_only: true },
        { action: 'apply', tenant_id: null, tier_key: 'a', archive_only: false, preview_token: 'signed' },
        {
            action: 'apply',
            tenant_id: null,
            tier_key: 'a',
            newapi_group: 'b',
            archive_only: true,
            preview_token: 'signed',
        },
    ])('rejects invalid orphan selection %j', async (body) => {
        expect((await orphanPOST(request(body))).status).toBe(400);
        expect(mocks.preview).not.toHaveBeenCalled();
        expect(mocks.autoPreview).not.toHaveBeenCalled();
        expect(mocks.start).not.toHaveBeenCalled();
    });
    it('lists jobs and orphan groups', async () => {
        expect(await (await listGET(request())).json()).toEqual({ jobs: [], orphan_groups: [] });
    });
    it('loads only the selected job', async () => {
        await jobGET(request(), context);
        expect(mocks.get).toHaveBeenCalledWith('group', admin);
    });
    it.each(['resume', 'stop'])('dispatches only %s action', async (action) => {
        expect((await jobPOST(request({ action }), context)).status).toBe(200);
        expect(mocks[action as 'resume' | 'stop']).toHaveBeenCalledWith('group', admin);
    });
    it('rejects extra job action fields', async () => {
        expect((await jobPOST(request({ action: 'stop', force: true }), context)).status).toBe(400);
        expect(mocks.stop).not.toHaveBeenCalled();
    });
    it('preserves known conflicts and strips unknown credential-bearing errors', async () => {
        mocks.resume.mockRejectedValueOnce(new ChannelGroupRetirementError('worker_active', 'wait'));
        expect((await jobPOST(request({ action: 'resume' }), context)).status).toBe(409);
        mocks.resume.mockRejectedValueOnce(new Error('sk-CUSTOMER-SECRET'));
        const response = await jobPOST(request({ action: 'resume' }), context);
        expect(response.status).toBe(500);
        expect(await response.text()).not.toMatch(/SECRET|回滚/);
    });
});
