import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';

const { db, dnsLookup } = vi.hoisted(() => ({
    db: { seedanceVideoTask: { updateMany: vi.fn(), findUnique: vi.fn() } },
    dnsLookup: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('../request-log', () => ({ writeRequestLog: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup }));
import { deliverTaskCallback, validateCallbackUrl } from '../callback';
import { callbackLookup } from '../callback-network';

let row: {
    status: string;
    billed: boolean;
    callback_status: string;
    callback_url: string;
    user_id: string;
    model: string;
};
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PORTAL_ENTERPRISE_CALLBACK_ENABLED', 'true');
    row = {
        status: 'completed',
        billed: true,
        callback_status: 'pending',
        callback_url: 'https://hooks.example.com/event',
        user_id: 'u1',
        model: 'seedance-2-0',
    };
    db.seedanceVideoTask.findUnique.mockImplementation(async () => ({ ...row }));
    db.seedanceVideoTask.updateMany.mockImplementation(async ({ where, data }) => {
        if (
            (where.status && where.status !== row.status) ||
            (where.callback_status && where.callback_status !== row.callback_status) ||
            (where.billed !== undefined && where.billed !== row.billed)
        )
            return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
    });
});
afterEach(() => vi.unstubAllEnvs());

const done = { id: 'task', status: 'completed' };
describe('callback opt-in and terminal state safety', () => {
    it('default-disabled delivery does not claim a row or send a notification', async () => {
        vi.stubEnv('PORTAL_ENTERPRISE_CALLBACK_ENABLED', '');
        const fetchImpl = vi.fn();
        expect(await deliverTaskCallback('task', done, { fetchImpl })).toBe('skipped');
        expect(db.seedanceVideoTask.updateMany).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it.each(['queued', 'in_progress', 'failed'])(
        'cannot send a stale success after persisted status is %s',
        async (status) => {
            row.status = status;
            const fetchImpl = vi.fn();
            expect(await deliverTaskCallback('task', done, { fetchImpl })).toBe('skipped');
            expect(fetchImpl).not.toHaveBeenCalled();
        },
    );
    it('cannot send a stale failure for a completed/billed task', async () => {
        const fetchImpl = vi.fn();
        expect(await deliverTaskCallback('task', { status: 'failed' }, { fetchImpl })).toBe('skipped');
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('simultaneous poll and reconciliation acquire one callback attempt', async () => {
        let release!: () => void;
        const fetchImpl = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    release = () => resolve(new Response(null, { status: 204 }));
                }),
        );
        const first = deliverTaskCallback('task', done, { fetchImpl, delaysMs: [0] });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        expect(await deliverTaskCallback('task', done, { fetchImpl, delaysMs: [0] })).toBe('skipped');
        release();
        expect(await first).toBe('sent');
        expect(row.callback_status).toBe('sent');
    });
    it('an interrupted sending attempt is not blindly replayed', async () => {
        row.callback_status = 'sending';
        const fetchImpl = vi.fn();
        expect(await deliverTaskCallback('task', done, { fetchImpl })).toBe('skipped');
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('revalidates a corrupted persisted destination before any request', async () => {
        row.callback_url = 'http://169.254.169.254/latest/meta-data';
        const fetchImpl = vi.fn();
        expect(await deliverTaskCallback('task', done, { fetchImpl, delaysMs: [0] })).toBe('failed');
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('callback destination safety', () => {
    it.each([
        'http://localhost./hook',
        'http://x.localhost/hook',
        'http://user:secret@hooks.example.com/hook',
        'http://100.64.1.2/hook',
        'http://2130706433/hook',
        'http://0x7f000001/hook',
        'http://198.18.1.2/hook',
        'http://224.0.0.1/hook',
    ])('rejects %s', (url) => {
        expect(validateCallbackUrl(url)).toMatchObject({ ok: false });
    });
    it('checks the exact DNS address returned to the connection and rejects mixed private/public answers', async () => {
        dnsLookup.mockResolvedValueOnce([
            { address: '1.1.1.1', family: 4 },
            { address: '127.0.0.1', family: 4 },
        ]);
        const result = await new Promise((resolve) =>
            callbackLookup('hooks.example.com', {}, (error, address) => resolve({ error, address })),
        );
        expect(result).toMatchObject({ error: expect.any(Error) });
        dnsLookup.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]);
        await expect(
            new Promise((resolve) =>
                callbackLookup('hooks.example.com', {}, (error, address, family) =>
                    resolve({ error, address, family }),
                ),
            ),
        ).resolves.toEqual({ error: null, address: '1.1.1.1', family: 4 });
    });
    it('a public-looking hostname resolving to loopback never reaches a local HTTP service', async () => {
        const received = vi.fn();
        const server = createServer((_req, res) => {
            received();
            res.writeHead(204);
            res.end();
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('missing local listener');
            row.callback_url = `http://public-callback.example:${address.port}/hook`;
            dnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
            expect(await deliverTaskCallback('task', done, { delaysMs: [0] })).toBe('failed');
            expect(dnsLookup).toHaveBeenCalled();
            expect(received).not.toHaveBeenCalled();
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });
});
