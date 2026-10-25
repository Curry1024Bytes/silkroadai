import { beforeEach, describe, expect, it, vi } from 'vitest';
const { table, tx, db } = vi.hoisted(() => {
    const table = new Map<string, Record<string, unknown>>();
    const tx = { volcIdMap: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } };
    const db = { $transaction: vi.fn(), volcIdMap: { findUnique: vi.fn() } };
    return { table, tx, db };
});
vi.mock('@/lib/db', () => ({ prisma: db }));
import { rememberVolcId, toUpstreamTask } from '../volc-id-map';
import { persistSvcinfTaskReference } from '@/lib/seedance/svcinf-client';

beforeEach(() => {
    vi.clearAllMocks();
    table.clear();
    const read = async ({ where }: { where: { vendor_id: string } }) => table.get(where.vendor_id) ?? null;
    db.volcIdMap.findUnique.mockImplementation(read);
    tx.volcIdMap.findUnique.mockImplementation(read);
    tx.volcIdMap.create.mockImplementation(async ({ data }) => {
        table.set(data.vendor_id, data);
        return data;
    });
    tx.volcIdMap.update.mockImplementation(async ({ where, data }) => {
        Object.assign(table.get(where.vendor_id)!, data);
        return table.get(where.vendor_id);
    });
    db.$transaction.mockImplementation(async (fn) => fn(tx));
});

describe('creation API version and accepted-task recovery', () => {
    it('saves the creation version and refuses another task or a later conflicting version', async () => {
        await rememberVolcId('cgt-a', 'mvt-original', 'task', 'u1', 'v1');
        expect(await toUpstreamTask('cgt-a')).toEqual({ upstreamId: 'mvt-original', apiVersion: 'v1' });
        await expect(rememberVolcId('cgt-a', 'mvt-other', 'task', 'u1', 'v2')).rejects.toThrow();
        await expect(rememberVolcId('cgt-a', 'mvt-original', 'task', 'u1', 'v2')).rejects.toThrow();
        expect(await toUpstreamTask('cgt-a')).toEqual({ upstreamId: 'mvt-original', apiVersion: 'v1' });
    });
    it('a database read outage is not treated as an unknown mapping', async () => {
        db.volcIdMap.findUnique.mockRejectedValueOnce(new Error('db unavailable'));
        await expect(toUpstreamTask('cgt-a')).rejects.toMatchObject({ status: 503 });
    });
    it('after upstream acceptance a mapping write failure returns a recoverable task without another POST', async () => {
        tx.volcIdMap.create.mockRejectedValueOnce(new Error('database unavailable after acceptance'));
        const id = await persistSvcinfTaskReference('cgt-client', 'mvt-accepted', 'v1');
        expect(id).toMatch(/^cgt-svc-recovery-v1-/);
        db.volcIdMap.findUnique.mockRejectedValue(new Error('database still unavailable'));
        expect(await toUpstreamTask(id)).toEqual({ upstreamId: 'mvt-accepted', apiVersion: 'v1' });
        expect(db.volcIdMap.findUnique).not.toHaveBeenCalled();
        expect(tx.volcIdMap.create).toHaveBeenCalledTimes(1);
    });
});
