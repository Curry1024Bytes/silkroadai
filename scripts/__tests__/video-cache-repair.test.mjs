import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    applyPlan,
    candidates,
    jobConfigSchema,
    planRepair,
    privateFile,
    REDIRECT_ERROR,
    run,
    TTL_SECONDS,
} from '../repair-video-cache-sources.mjs';

const API = 'https://api.kkone.vip';
const MEDIA = 'https://video.kkone.vip';
const TASK_ID = `task_${'A'.repeat(32)}`;
const UPSTREAM_ID = `task_${'B'.repeat(32)}`;
const SOURCE = `${API}/video-cache/${UPSTREAM_ID}.mp4`;
const TARGET = `${MEDIA}/video-cache/${UPSTREAM_ID}.mp4`;
const ERROR = `download video for cache: Get "${TARGET}": ${REDIRECT_ERROR}`;
const NOW = Math.floor(Date.now() / 1000);
const POLICY = { api_origin: API, media_origin: MEDIA };
const CONFIG = { state_directory: '/unused', batch_size: 25, providers: [POLICY] };
const CHANNEL = { id: 8n, type: 59n, baseUrl: API };
const PRIVATE = {
    key: 'provider-sentinel-never-log',
    upstream_task_id: UPSTREAM_ID,
    upstream_result_url: SOURCE,
    video_cache_last_error: ERROR,
    video_cache_next_retry_at: NOW + 600,
    video_cache_attempts: 13,
    result_url: `http://localhost:3000/video-cache/${TASK_ID}.mp4`,
    billing_context: { quota: 98765 },
    future_field: { preserve: true },
};
function task(overrides = {}, privateOverrides = {}) {
    return {
        id: 1n,
        taskId: TASK_ID,
        channelId: 8n,
        status: 'SUCCESS',
        platform: '59',
        finishTime: BigInt(NOW - 60),
        ...overrides,
        privateData: { ...PRIVATE, ...privateOverrides },
    };
}
function clientFor(row = task(), channel = CHANNEL) {
    const tx = {
        videoCacheTask: { findUnique: vi.fn(async () => row), update: vi.fn(async () => row) },
        videoCacheChannel: { findUnique: vi.fn(async () => channel) },
    };
    const client = {
        videoCacheTask: { findMany: vi.fn(async () => [row]) },
        videoCacheChannel: { findMany: vi.fn(async () => [channel]) },
        $transaction: vi.fn(async (fn) => fn(tx)),
    };
    return { client, tx };
}
const directories = [];
function state() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-cache-policy-'));
    fs.chmodSync(directory, 0o700);
    directories.push(directory);
    return directory;
}
afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
});

describe('verified video cache source policy', () => {
    it.each([
        [59n, '59'],
        [64n, '64'],
        [59n, 'newapi-video'],
        [64n, 'minimax-video'],
    ])('supports channel type %s / %s', (type, platform) => {
        const plan = planRepair(task({ platform }), { ...CHANNEL, type }, [POLICY], NOW);
        expect(plan.target_url).toBe(TARGET);
        expect(JSON.stringify(plan)).not.toContain('provider-sentinel');
        expect(JSON.stringify(plan)).not.toContain('billing_context');
    });
    it('accepts a trailing slash on the configured channel origin', () => {
        expect(planRepair(task(), { ...CHANNEL, baseUrl: API + '/' }, [POLICY], NOW)).not.toBeNull();
    });
    it('accepts generic request provenance snapshots without plugin execution', () => {
        const plan = planRepair(
            task({}, { execution: { request_id: 'request-1', request_path: '/v1/video/generations' } }),
            CHANNEL,
            [POLICY],
            NOW,
        );
        expect(plan.target_url).toBe(TARGET);
    });
    it('rejects plugin execution snapshots', () => {
        expect(
            planRepair(
                task({}, { execution: { request_id: 'request-1', task_plugin: { key: 'plugin' } } }),
                CHANNEL,
                [POLICY],
                NOW,
            ),
        ).toBeNull();
    });
    it.each([
        { status: 'IN_PROGRESS' },
        { status: 'FAILURE' },
        { status: 'QUEUED' },
        { id: 0n },
        { id: '1' },
        { channelId: 99n },
        { platform: '64' },
        { finishTime: 0n },
        { finishTime: BigInt(NOW - TTL_SECONDS) },
        { finishTime: BigInt(NOW + 1) },
        { taskId: '../../secret' },
        { taskId: TASK_ID + '\n' },
    ])('rejects unsafe task case %#', (change) => {
        expect(planRepair(task(change), CHANNEL, [POLICY], NOW)).toBeNull();
    });
    it.each([
        { video_cached_at: NOW - 1 },
        { video_cached_at: 'invalid' },
        { future_field: { unsafe_integer: Number.MAX_SAFE_INTEGER + 1 } },
        { upstream_task_id: '' },
        { upstream_task_id: UPSTREAM_ID + '\n' },
        { upstream_result_url: TARGET },
        { upstream_result_url: SOURCE + '?key=secret' },
        { upstream_result_url: SOURCE + '#fragment' },
        { upstream_result_url: SOURCE.replace('https://', 'https://key@') },
        { upstream_result_url: SOURCE.replace(UPSTREAM_ID, TASK_ID) },
        { video_cache_last_error: 'connection timeout' },
        { video_cache_last_error: ERROR.replace(MEDIA, 'https://evil.example') },
        { video_cache_last_error: ERROR.replace(UPSTREAM_ID, TASK_ID) },
        { video_cache_last_error: ERROR.replace(TARGET, 'http://127.0.0.1/private') },
        { video_cache_last_error: ERROR.replace(TARGET, TARGET + '?key=secret') },
        { video_cache_last_error: ERROR + ' unverified tail' },
    ])('rejects unverified metadata %j', (change) => {
        expect(planRepair(task({}, change), CHANNEL, [POLICY], NOW)).toBeNull();
    });
    it.each(['https://other.example', API + '.evil.example', 'http://api.kkone.vip', API + '/v1'])(
        'rejects another channel base %s',
        (baseUrl) => {
            expect(planRepair(task(), { ...CHANNEL, baseUrl }, [POLICY], NOW)).toBeNull();
        },
    );
    it('requires an explicit policy and matching video channel type', () => {
        expect(planRepair(task(), CHANNEL, [], NOW)).toBeNull();
        expect(planRepair(task(), { ...CHANNEL, type: 1n }, [POLICY], NOW)).toBeNull();
    });
    it.each([
        'http://api.example',
        'https://key@api.example',
        'https://api.example/path',
        'https://api.example:444',
        'https://api.example?x=1',
        'https://api.example\n',
    ])('rejects invalid configured origin %s', (api_origin) => {
        expect(jobConfigSchema.safeParse({ ...CONFIG, providers: [{ ...POLICY, api_origin }] }).success).toBe(false);
    });
    it('rejects ambiguous policies and an unbounded batch', () => {
        for (const change of [
            { providers: [POLICY, POLICY] },
            { providers: [] },
            { batch_size: 101 },
            { state_directory: 'relative' },
        ]) {
            expect(jobConfigSchema.safeParse({ ...CONFIG, ...change }).success).toBe(false);
        }
    });
});

describe('Prisma maintenance writes', () => {
    it('is read-only by default, with no provider or model requests', async () => {
        const { client } = clientFor();
        const fetch = vi.spyOn(globalThis, 'fetch');
        expect(await run(client, CONFIG)).toEqual({ mode: 'dry-run', eligible: 1, applied: 0, raced: 0 });
        expect(client.$transaction).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('preserves every unrelated JSON field and writes a private backup first', async () => {
        const { client, tx } = clientFor();
        const directory = state();
        tx.videoCacheTask.update.mockImplementation(async (query) => {
            const files = fs.readdirSync(directory).filter((name) => name.endsWith('.before.json'));
            expect(files).toHaveLength(1);
            const file = path.join(directory, files[0]);
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
            expect(fs.readFileSync(file, 'utf8')).not.toContain('provider-sentinel');
            expect(query.data).toEqual({
                privateData: { ...PRIVATE, upstream_result_url: TARGET, video_cache_next_retry_at: 0 },
            });
        });
        expect(await applyPlan(client, planRepair(task(), CHANNEL, [POLICY]), CONFIG, directory)).toBe(true);
        expect(client.$transaction.mock.calls[0][1]).toEqual({
            isolationLevel: 'Serializable',
            maxWait: 2000,
            timeout: 10000,
        });
    });
    it('does not write if the durable backup fails', async () => {
        const { client, tx } = clientFor();
        await expect(
            applyPlan(client, planRepair(task(), CHANNEL, [POLICY]), CONFIG, state(), () => {
                throw new Error('disk full');
            }),
        ).rejects.toThrow('disk full');
        expect(tx.videoCacheTask.update).not.toHaveBeenCalled();
    });
    it('rechecks task/source/channel state inside the transaction', async () => {
        const expected = planRepair(task(), CHANNEL, [POLICY]);
        for (const { client, tx } of [
            clientFor(task({ status: 'FAILURE' })),
            clientFor(task({}, { video_cached_at: NOW })),
            clientFor(task(), { ...CHANNEL, baseUrl: 'https://other.example' }),
        ]) {
            expect(await applyPlan(client, expected, CONFIG, state())).toBe(false);
            expect(tx.videoCacheTask.update).not.toHaveBeenCalled();
        }
    });
    it('rereads and preserves fields after a serializable conflict', async () => {
        const { client, tx } = clientFor(task({}, { concurrently_added: 'preserved' }));
        client.$transaction.mockRejectedValueOnce({ code: 'P2034' });
        expect(await applyPlan(client, planRepair(task(), CHANNEL, [POLICY]), CONFIG, state())).toBe(true);
        expect(client.$transaction).toHaveBeenCalledTimes(2);
        expect(tx.videoCacheTask.update.mock.calls[0][0].data.privateData.concurrently_added).toBe('preserved');
    });
    it('does not retry an unknown transaction error or report it as success', async () => {
        const { client } = clientFor();
        client.$transaction.mockRejectedValueOnce(new Error('unknown outcome'));
        await expect(applyPlan(client, planRepair(task(), CHANNEL, [POLICY]), CONFIG, state())).rejects.toThrow(
            'unknown outcome',
        );
        expect(client.$transaction).toHaveBeenCalledTimes(1);
    });
    it('does not read tasks if no configured channel matches', async () => {
        const { client } = clientFor();
        client.videoCacheChannel.findMany.mockResolvedValueOnce([]);
        expect(await candidates(client, CONFIG)).toEqual([]);
        expect(client.videoCacheTask.findMany).not.toHaveBeenCalled();
    });
    it('records only counts in operational summaries', async () => {
        const { client } = clientFor();
        const directory = state();
        const summary = await run(client, { ...CONFIG, state_directory: directory }, true);
        expect(summary.applied).toBe(1);
        expect(fs.readFileSync(path.join(directory, 'last-run.json'), 'utf8')).not.toContain(TASK_ID);
    });
    it('refuses a symlink as an audit file', () => {
        const directory = state();
        const victim = path.join(directory, 'victim');
        const link = path.join(directory, 'symlink');
        fs.writeFileSync(victim, 'unchanged');
        fs.symlinkSync(victim, link);
        expect(() => privateFile(link, { changed: true })).toThrow();
        expect(fs.readFileSync(victim, 'utf8')).toBe('unchanged');
    });
});
