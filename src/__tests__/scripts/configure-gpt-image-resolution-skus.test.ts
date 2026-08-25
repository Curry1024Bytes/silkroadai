import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = resolve(process.cwd(), 'scripts/configure-gpt-image-resolution-skus.mjs');
const TOKEN = 'a'.repeat(32);

type Channel = {
    id: number;
    type: number;
    status: number;
    name: string;
    group: string;
    base_url: string;
    models: string;
    model_mapping: string | null;
    used_quota: number;
};

function json(res: ServerResponse, body: unknown, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

async function requestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

describe('configure-gpt-image-resolution-skus.mjs', () => {
    let snapshotDir: string;
    let version: string;
    let startTime: number;
    let modelPrice: Record<string, number>;
    let billingModes: Record<string, string>;
    let scheduledDiscounts: Record<string, { enabled: boolean }>;
    let imageResolutionPrices: Record<string, unknown>;
    let channel: Channel;
    let extraChannels: Channel[];
    let channelPuts: Record<string, unknown>[];
    let corruptNextChannelWrite: boolean;
    let server: ReturnType<typeof createServer>;
    let baseUrl: string;

    beforeEach(async () => {
        snapshotDir = mkdtempSync(join(tmpdir(), 'llmroute-gpt-image-test-'));
        version = 'v1.0.0-rc.23';
        startTime = 100;
        modelPrice = { 'gpt-image-2': 0.5, 'gpt-image-2-cf': 0.6, untouched: 42 };
        billingModes = {};
        scheduledDiscounts = {};
        imageResolutionPrices = {};
        channel = {
            id: 12,
            type: 1,
            status: 1,
            name: 'image upstream',
            group: '\u56fe\u7247\u6a21\u578b',
            base_url: 'https://upstream.example',
            models: 'gpt-image-2,gpt-image-2-cf,grok-imagine-image',
            model_mapping: null,
            used_quota: 123,
        };
        extraChannels = [];
        channelPuts = [];
        corruptNextChannelWrite = false;

        server = createServer(async (req, res) => {
            const url = new URL(req.url || '/', 'http://127.0.0.1');
            if (req.method === 'GET' && url.pathname === '/api/status') {
                json(res, { success: true, data: { version, start_time: startTime } });
                return;
            }
            if (req.method === 'GET' && url.pathname === '/api/option/') {
                json(res, {
                    success: true,
                    data: [
                        { key: 'QuotaPerUnit', value: '500000' },
                        { key: 'GroupRatio', value: JSON.stringify({ '\u56fe\u7247\u6a21\u578b': 0.2 }) },
                        { key: 'GroupGroupRatio', value: '{}' },
                        { key: 'ModelPrice', value: JSON.stringify(modelPrice) },
                        { key: 'billing_setting.billing_mode', value: JSON.stringify(billingModes) },
                        { key: 'billing_setting.scheduled_discount', value: JSON.stringify(scheduledDiscounts) },
                        { key: 'ImageResolutionPrice', value: JSON.stringify(imageResolutionPrices) },
                    ],
                });
                return;
            }
            if (req.method === 'PUT' && url.pathname === '/api/option/') {
                const body = await requestBody(req);
                modelPrice = JSON.parse(String(body.value)) as Record<string, number>;
                json(res, { success: true });
                return;
            }
            if (req.method === 'GET' && url.pathname === '/api/channel/12') {
                json(res, { success: true, data: channel });
                return;
            }
            if (req.method === 'GET' && url.pathname === '/api/channel/') {
                const items = [channel, ...extraChannels];
                json(res, { success: true, data: { items, total: items.length } });
                return;
            }
            if (req.method === 'PUT' && url.pathname === '/api/channel/') {
                const body = await requestBody(req);
                channelPuts.push(body);
                channel = {
                    ...channel,
                    type: Number(body.type),
                    group: String(body.group),
                    base_url: String(body.base_url),
                    models: corruptNextChannelWrite ? `${String(body.models)},corrupt` : String(body.models),
                    model_mapping: String(body.model_mapping),
                };
                corruptNextChannelWrite = false;
                json(res, { success: true });
                return;
            }
            json(res, { success: false, message: `unexpected ${req.method} ${url.pathname}` }, 404);
        });
        await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('mock server did not bind TCP');
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        rmSync(snapshotDir, { recursive: true, force: true });
    });

    async function run(...args: string[]) {
        return execFileAsync(process.execPath, [SCRIPT, ...args], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                NEWAPI_ADMIN_TOKEN: TOKEN,
                NEWAPI_BASE_URL: baseUrl,
                NEWAPI_IMAGE_CHANNEL_IDS: '12',
                NEWAPI_IMAGE_GROUP: '\u56fe\u7247\u6a21\u578b',
                NEWAPI_CONFIG_SNAPSHOT_DIR: snapshotDir,
            },
            timeout: 10_000,
        });
    }

    function snapshotFor(phase: string): string {
        const file = readdirSync(snapshotDir).find((name) => name.startsWith(`gpt-image-${phase}-`));
        if (!file) throw new Error(`missing ${phase} snapshot`);
        return join(snapshotDir, file);
    }

    it('requires persisted pricing proof, preserves payload guards, and makes cutover one-way', async () => {
        await run('--phase=pricing', '--apply');
        const pricingSnapshot = snapshotFor('pricing');
        expect(modelPrice).toMatchObject({
            untouched: 42,
            'gpt-image-2-1k': 5,
            'gpt-image-2-2k': 7.5,
            'gpt-image-2-4k': 10,
        });
        expect(channelPuts).toHaveLength(0);

        startTime = 200;
        await run('--phase=prepare', `--pricing-snapshot=${pricingSnapshot}`, '--apply');
        expect(channel.models.split(',')).toEqual([
            'gpt-image-2-cf',
            'grok-imagine-image',
            'gpt-image-2',
            'gpt-image-2-1k',
            'gpt-image-2-2k',
            'gpt-image-2-4k',
        ]);
        expect(channelPuts[0]).toEqual({
            id: 12,
            type: 1,
            group: '\u56fe\u7247\u6a21\u578b',
            base_url: 'https://upstream.example',
            models: channel.models,
            model_mapping: JSON.stringify({
                'gpt-image-2-1k': 'gpt-image-2',
                'gpt-image-2-2k': 'gpt-image-2',
                'gpt-image-2-4k': 'gpt-image-2',
            }),
        });
        expect(channelPuts[0]).not.toHaveProperty('status');

        await expect(run('--phase=cutover', '--apply')).rejects.toMatchObject({
            stderr: expect.stringContaining('--phase=cutover requires --pricing-snapshot'),
        });
        expect(channel.models.split(',')).toContain('gpt-image-2');

        await run('--phase=cutover', `--pricing-snapshot=${pricingSnapshot}`, '--apply');
        expect(channel.models).not.toContain('gpt-image-2,');
        expect(channel.models.split(',')).not.toContain('gpt-image-2');

        await expect(run('--phase=prepare', `--pricing-snapshot=${pricingSnapshot}`, '--apply')).rejects.toMatchObject({
            stderr: expect.stringContaining('prepare cannot reopen a cutover channel'),
        });
    });

    it('blocks channel preparation when API-only pricing disappears after restart', async () => {
        const originalPrice = { ...modelPrice };
        await run('--phase=pricing', '--apply');
        const pricingSnapshot = snapshotFor('pricing');

        // Simulate rc.23 updating only its in-memory OptionMap while MySQL retained the old value.
        modelPrice = originalPrice;
        startTime = 200;
        await expect(run('--phase=prepare', `--pricing-snapshot=${pricingSnapshot}`, '--apply')).rejects.toMatchObject({
            stderr: expect.stringContaining('pricing did not survive restart'),
        });
        expect(channelPuts).toHaveLength(0);
    });

    it('verifies the complete restored state only after a restart and database sync window', async () => {
        const originalPrice = { ...modelPrice };
        await run('--phase=pricing', '--apply');
        const pricingSnapshot = snapshotFor('pricing');
        const priced = { ...modelPrice };

        await run('--phase=restore', `--snapshot=${pricingSnapshot}`, '--apply');
        const restoreSnapshot = snapshotFor('restore');
        expect(modelPrice).toEqual(originalPrice);

        startTime = 200;
        const verified = await run('--phase=verify', `--snapshot=${restoreSnapshot}`, '--expect=after');
        expect(verified.stdout).toContain('Verified snapshot after-state after restart and database sync');

        // Simulate the restore having changed only OptionMap while MySQL retained the priced value.
        modelPrice = priced;
        await expect(run('--phase=verify', `--snapshot=${restoreSnapshot}`, '--expect=after')).rejects.toMatchObject({
            stderr: expect.stringContaining('post-restart after-state verification failed: ModelPrice differs'),
        });
    });

    it('requires the post-restart option sync window before accepting pricing proof', async () => {
        await run('--phase=pricing', '--apply');
        const pricingSnapshot = snapshotFor('pricing');
        startTime = Math.floor(Date.now() / 1000);

        await expect(run('--phase=prepare', `--pricing-snapshot=${pricingSnapshot}`, '--apply')).rejects.toMatchObject({
            stderr: expect.stringContaining('wait until at least 65s'),
        });
        expect(channelPuts).toHaveLength(0);
    });

    it('refuses to overwrite an existing non-canonical alias mapping', async () => {
        await run('--phase=pricing', '--apply');
        const pricingSnapshot = snapshotFor('pricing');
        startTime = 200;
        channel.model_mapping = JSON.stringify({ 'gpt-image-2-1k': 'another-upstream-model' });

        await expect(run('--phase=prepare', `--pricing-snapshot=${pricingSnapshot}`, '--apply')).rejects.toMatchObject({
            stderr: expect.stringContaining(
                'already maps gpt-image-2-1k to another-upstream-model; refusing to overwrite it with gpt-image-2',
            ),
        });
        expect(channelPuts).toHaveLength(0);

        channel.model_mapping = '{}';
        channel.models += ',gpt-image-2-1k';
        await expect(run('--phase=prepare', `--pricing-snapshot=${pricingSnapshot}`, '--apply')).rejects.toMatchObject({
            stderr: expect.stringContaining(
                'reserved fixed-price alias collision(s): #12 gpt-image-2-1k->(native/unmapped)',
            ),
        });
        expect(channelPuts).toHaveLength(0);
    });

    it('blocks global ModelPrice writes when a reserved alias already collides on any channel', async () => {
        const originalPrice = { ...modelPrice };
        const originalModels = channel.models;
        channel.models += ',gpt-image-2-1k';

        await expect(run('--phase=pricing', '--apply')).rejects.toMatchObject({
            stderr: expect.stringContaining('#12 gpt-image-2-1k->(native/unmapped)'),
        });
        expect(modelPrice).toEqual(originalPrice);
        expect(channelPuts).toHaveLength(0);

        channel.models = originalModels;
        extraChannels.push({
            ...channel,
            id: 13,
            name: 'unrelated upstream',
            group: 'default',
            models: 'gpt-image-2-2k',
        });
        await expect(run('--phase=pricing', '--apply')).rejects.toMatchObject({
            stderr: expect.stringContaining('#13 gpt-image-2-2k->(native/unmapped)'),
        });
        expect(modelPrice).toEqual(originalPrice);
        expect(channelPuts).toHaveLength(0);
    });

    it('audits model-mapping chains beyond 32 hops using official rc.23 semantics', async () => {
        const originalPrice = { ...modelPrice };
        const mapping: Record<string, string> = {};
        for (let hop = 0; hop < 40; hop++) {
            mapping[`long-chain-${hop}`] = hop === 39 ? 'gpt-image-2' : `long-chain-${hop + 1}`;
        }
        extraChannels.push({
            ...channel,
            id: 13,
            name: 'deep mapping upstream',
            group: 'default',
            models: 'long-chain-0',
            model_mapping: JSON.stringify(mapping),
        });

        await expect(run('--phase=pricing', '--apply')).rejects.toMatchObject({
            stderr: expect.stringContaining('#13 long-chain-0->gpt-image-2'),
        });
        expect(modelPrice).toEqual(originalPrice);
        expect(channelPuts).toHaveLength(0);
    });

    it('fails closed on unsupported new-api versions and competing billing overrides', async () => {
        version = 'v1.0.0-rc.24';
        await expect(run('--phase=pricing')).rejects.toMatchObject({
            stderr: expect.stringContaining('expected official v1.0.0-rc.23'),
        });

        version = 'v1.0.0-rc.23';
        billingModes['gpt-image-2-1k'] = 'tiered_expr';
        scheduledDiscounts['gpt-image-2-2k'] = { enabled: true };
        imageResolutionPrices['gpt-image-2-4k'] = { '1K': 1, '2K': 2, '4K': 3 };
        await expect(run('--phase=pricing')).rejects.toMatchObject({
            stderr: expect.stringContaining(
                'gpt-image-2-1k:tiered_expr, gpt-image-2-2k:scheduled_discount, gpt-image-2-4k:ImageResolutionPrice',
            ),
        });
    });

    it('keeps verify read-only and creates a fresh proof snapshot for no-op pricing applies', async () => {
        await run('--phase=pricing', '--apply');
        const pricingSnapshot = snapshotFor('pricing');
        const second = await run('--phase=pricing', '--apply');
        expect(second.stdout).toContain('Proof snapshot written');
        expect(readdirSync(snapshotDir).filter((name) => name.startsWith('gpt-image-pricing-'))).toHaveLength(2);

        await expect(
            run('--phase=verify', `--snapshot=${pricingSnapshot}`, '--expect=after', '--apply'),
        ).rejects.toMatchObject({ stderr: expect.stringContaining('--phase=verify is read-only') });
    });

    it('rolls channel state back when write verification fails', async () => {
        await run('--phase=pricing', '--apply');
        const pricingSnapshot = snapshotFor('pricing');
        startTime = 200;
        const before = { ...channel };
        corruptNextChannelWrite = true;

        await expect(run('--phase=prepare', `--pricing-snapshot=${pricingSnapshot}`, '--apply')).rejects.toMatchObject({
            stderr: expect.stringContaining('Automatic rollback verified'),
        });
        expect(channel.models).toBe(before.models);
        expect(JSON.parse(channel.model_mapping || '{}')).toEqual({});
        expect(channelPuts).toHaveLength(2);
    });

    it('rejects partially invalid channel ID lists instead of silently narrowing scope', async () => {
        await expect(
            execFileAsync(process.execPath, [SCRIPT, '--phase=pricing'], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    NEWAPI_ADMIN_TOKEN: TOKEN,
                    NEWAPI_BASE_URL: baseUrl,
                    NEWAPI_IMAGE_CHANNEL_IDS: '12,13x',
                    NEWAPI_IMAGE_GROUP: '\u56fe\u7247\u6a21\u578b',
                    NEWAPI_CONFIG_SNAPSHOT_DIR: snapshotDir,
                },
            }),
        ).rejects.toMatchObject({ stderr: expect.stringContaining('contains invalid value(s): 13x') });
        expect(channelPuts).toHaveLength(0);
    });

    it('writes snapshots without credentials', async () => {
        await run('--phase=pricing', '--apply');
        const snapshot = readFileSync(snapshotFor('pricing'), 'utf8');
        expect(snapshot).not.toContain(TOKEN);
        expect(JSON.parse(snapshot)).toMatchObject({ phase: 'pricing', runtime_start_time: 100 });
    });
});
