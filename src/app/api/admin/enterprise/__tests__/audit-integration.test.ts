/**
 * 审计接线集成测:写操作端点在【成功后】调 auditAdminAction(语义 action + target),
 * 失败(404/400)不留痕;次级管理员(secondary)能过日常端点的门。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, resolveEnterpriseAdmin, auditAdminAction, applyLedgerEntry } = vi.hoisted(() => ({
    db: {
        user: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
        enterpriseKey: { updateMany: vi.fn() },
        enterpriseUpstreamKey: { updateMany: vi.fn(), count: vi.fn() },
        enterpriseAkSk: { updateMany: vi.fn() },
        $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    },
    resolveEnterpriseAdmin: vi.fn(),
    auditAdminAction: vi.fn(),
    applyLedgerEntry: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/enterprise/admin-auth', () => ({ resolveEnterpriseAdmin, auditAdminAction }));
vi.mock('@/lib/admin-auth', () => ({ unauthorizedResponse: () => new Response(null, { status: 401 }) }));
vi.mock('@/lib/billing/ledger', () => ({ applyLedgerEntry }));

import { POST as creditPOST } from '../credit/route';
import { PATCH as keyPATCH } from '../keys/[id]/route';

const req = (url: string, method: string, body?: unknown) =>
    new NextRequest(`http://internal${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

const SECONDARY = { user: { id: 'sec1', email: 'ops@x.com' }, level: 'secondary', viaBreakGlass: false };

beforeEach(() => {
    vi.clearAllMocks();
    resolveEnterpriseAdmin.mockResolvedValue(SECONDARY);
});

describe('credit(次级管理员可用 + 审计)', () => {
    it('成功入账 → audit(action=credit, target=客户邮箱, params 含金额备注)', async () => {
        db.user.findFirst.mockResolvedValue({ id: 'c1', email: 'cust@x.com', tenant_id: null, billing_mode: 'portal' });
        applyLedgerEntry.mockResolvedValue({ balance_after: { toFixed: () => '100.00' } });
        const res = await creditPOST(
            req('/api/admin/enterprise/credit', 'POST', {
                email: 'cust@x.com',
                amount_cny: 100,
                note: '打款 #123',
            }),
        );
        expect(res.status).toBe(200);
        expect(auditAdminAction).toHaveBeenCalledTimes(1);
        const [, admin, action, info] = auditAdminAction.mock.calls[0];
        expect(admin).toBe(SECONDARY);
        expect(action).toBe('credit');
        expect(info.target).toBe('cust@x.com');
        expect(info.params).toMatchObject({ amount_cny: 100, note: '打款 #123' });
    });

    it('客户不存在 404 → 不审计(只记做成了的)', async () => {
        db.user.findFirst.mockResolvedValue(null);
        const res = await creditPOST(
            req('/api/admin/enterprise/credit', 'POST', {
                email: 'nobody@x.com',
                amount_cny: 100,
                note: 'x',
            }),
        );
        expect(res.status).toBe(404);
        expect(auditAdminAction).not.toHaveBeenCalled();
    });
});

describe('keys/[id](启停 + 审计)', () => {
    it('禁用 key → audit(action=key_status)', async () => {
        db.enterpriseKey.updateMany.mockResolvedValue({ count: 1 });
        const res = await keyPATCH(req('/api/admin/enterprise/keys/k1', 'PATCH', { status: 'disabled' }), {
            params: Promise.resolve({ id: 'k1' }),
        });
        expect(res.status).toBe(200);
        expect(auditAdminAction).toHaveBeenCalledWith(
            expect.anything(),
            SECONDARY,
            'key_status',
            expect.objectContaining({ target: 'k1', params: { key_id: 'k1', status: 'disabled' } }),
        );
    });

    it('key 不存在 404 → 不审计', async () => {
        db.enterpriseKey.updateMany.mockResolvedValue({ count: 0 });
        const res = await keyPATCH(req('/api/admin/enterprise/keys/kx', 'PATCH', { status: 'disabled' }), {
            params: Promise.resolve({ id: 'kx' }),
        });
        expect(res.status).toBe(404);
        expect(auditAdminAction).not.toHaveBeenCalled();
    });
});
