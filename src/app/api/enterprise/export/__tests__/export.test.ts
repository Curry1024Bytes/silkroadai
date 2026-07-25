/** 导出 CSV route 单测(2026-07-26):鉴权 401 / CSV 头 + BOM + 折扣列 / 流水导出。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, requireEnterpriseUser, reconcileStaleTasks } = vi.hoisted(() => ({
    db: {
        seedanceVideoTask: { findMany: vi.fn() },
        account: { findUnique: vi.fn() },
        ledgerEntry: { findMany: vi.fn() },
    },
    requireEnterpriseUser: vi.fn(),
    reconcileStaleTasks: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/enterprise/session', () => ({ requireEnterpriseUser }));
vi.mock('@/lib/enterprise/reconcile', () => ({ reconcileStaleTasks }));

import { GET as logsGET } from '../logs/route';
import { GET as billingGET } from '../billing/route';

const req = (url: string) => new NextRequest(`http://internal${url}`);

beforeEach(() => {
    vi.clearAllMocks();
    requireEnterpriseUser.mockResolvedValue({ id: 'u1', tenant_id: null });
    reconcileStaleTasks.mockResolvedValue(undefined);
});

describe('GET /api/enterprise/export/logs', () => {
    it('未登录 → 401', async () => {
        requireEnterpriseUser.mockResolvedValue(null);
        expect((await logsGET(req('/api/enterprise/export/logs'))).status).toBe(401);
    });

    it('导出前先对账;CSV 带 BOM/attachment/折扣列;失败原因入列', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue([
            {
                id: 'cgt-1',
                model: 'seedance-2-0',
                resolution: '720p',
                has_video: false,
                duration: 5,
                status: 'completed',
                fail_reason: null,
                tokens: BigInt(1_000_000),
                cost_cny: '39.1',
                billed: true,
                created_at: new Date('2026-07-24T02:00:00Z'),
            },
            {
                id: 'cgt-2',
                model: 'seedance-2-0',
                resolution: '720p',
                has_video: false,
                duration: 5,
                status: 'failed',
                fail_reason: 'sensitive content',
                tokens: null,
                cost_cny: null,
                billed: false,
                created_at: new Date('2026-07-24T03:00:00Z'),
            },
        ]);
        const res = await logsGET(req('/api/enterprise/export/logs?status=completed'));
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/csv');
        expect(res.headers.get('Content-Disposition')).toContain('attachment');
        expect(reconcileStaleTasks).toHaveBeenCalledWith('u1');
        // Response.text() 按标准剥 BOM,读字节验 UTF-8 BOM(EF BB BF,Excel 中文不乱码)
        const buf = Buffer.from(await res.arrayBuffer());
        expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
        const body = buf.toString('utf-8');
        expect(body).toContain('官方价(¥)');
        expect(body).toContain('8.5折'); // 39.1 / (39.1/0.85) = 0.85
        expect(body).toContain('46.0000'); // 官方价 = 39.1/0.85
        expect(body).toContain('sensitive content'); // 失败原因
    });

    it('超 5 万条 → 400 too_many_rows', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue(new Array(50_001).fill(null).map(() => ({})));
        const res = await logsGET(req('/api/enterprise/export/logs'));
        expect(res.status).toBe(400);
    });
});

describe('GET /api/enterprise/export/billing', () => {
    it('未登录 → 401', async () => {
        requireEnterpriseUser.mockResolvedValue(null);
        expect((await billingGET(req('/api/enterprise/export/billing'))).status).toBe(401);
    });

    it('CSV 含类型中文 + 金额 4 位', async () => {
        db.account.findUnique.mockResolvedValue({ id: 'acc1' });
        db.ledgerEntry.findMany.mockResolvedValue([
            {
                kind: 'charge',
                amount_cny: '-2.128448',
                balance_after: '100',
                note: 'seedance-2-0-mini',
                created_at: new Date('2026-07-24T02:00:00Z'),
            },
        ]);
        const res = await billingGET(req('/api/enterprise/export/billing?kind=charge'));
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('消费');
        expect(body).toContain('-2.1284');
        expect(body).toContain('seedance-2-0-mini');
    });

    it('无 Account → 空 CSV(仅表头),不 500', async () => {
        db.account.findUnique.mockResolvedValue(null);
        const res = await billingGET(req('/api/enterprise/export/billing'));
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('时间(北京)');
    });
});
