/** Run only against a disposable database initialized by the unchanged new-api image. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/newapi-video-cache/index.js';
import { applyPlan, candidates, planRepair, REDIRECT_ERROR, run } from './repair-video-cache-sources.mjs';

const database = JSON.parse(fs.readFileSync('/run/video-cache-repair-database.json', 'utf8'));
if (!/^video_cache_repair_test_[0-9]+$/.test(database.database)) throw new Error('isolated database required');
const config = JSON.parse(fs.readFileSync('/run/video-cache-repair-config.json', 'utf8')).job;
const client = new PrismaClient({ adapter: new PrismaPg({ ...database, max: 2 }) });
const other = new PrismaClient({ adapter: new PrismaPg({ ...database, max: 1 }) });
const now = Math.floor(Date.now() / 1000);
const api = config.providers[0].api_origin;
const media = config.providers[0].media_origin;
const publicId = `task_${'A'.repeat(32)}`;
const upstreamId = `task_${'B'.repeat(32)}`;
const source = `${api}/video-cache/${upstreamId}.mp4`;
const target = `${media}/video-cache/${upstreamId}.mp4`;
const privateData = {
    key: 'fixture-sentinel',
    upstream_task_id: upstreamId,
    upstream_result_url: source,
    video_cache_last_error: `download video for cache: Get "${target}": ${REDIRECT_ERROR}`,
    video_cache_next_retry_at: now + 600,
    video_cache_attempts: 13,
    billing_context: { quota: 98765 },
    future_field: { preserve: true },
};
let assertions = 0;

async function reset() {
    await client.videoCacheTask.deleteMany();
    await client.videoCacheChannel.deleteMany();
    await client.videoCacheChannel.create({ data: { id: 8n, type: 59n, baseUrl: api, key: 'fixture-sentinel' } });
    await client.videoCacheTask.create({
        data: {
            id: 1n,
            taskId: publicId,
            channelId: 8n,
            status: 'SUCCESS',
            platform: '59',
            finishTime: BigInt(now - 60),
            privateData,
        },
    });
}
const get = () => client.videoCacheTask.findUnique({ where: { id: 1n } });
const channel = () =>
    client.videoCacheChannel.findUnique({ where: { id: 8n }, select: { id: true, type: true, baseUrl: true } });

try {
    await reset();
    const before = await get();
    const plans = await candidates(client, config);
    assert.equal(plans.length, 1);
    assertions++;
    assert.equal(JSON.stringify(plans).includes('fixture-sentinel'), false);
    assertions++;
    assert.equal(await applyPlan(client, plans[0], config, config.state_directory), true);
    assertions++;
    assert.deepEqual(await get(), {
        ...before,
        privateData: { ...privateData, upstream_result_url: target, video_cache_next_retry_at: 0 },
    });
    assertions++;
    assert.equal(await applyPlan(client, plans[0], config, config.state_directory), false);
    assertions++;
    assert.equal((await candidates(client, config)).length, 0);
    assertions++;

    // Force a real PostgreSQL serialization failure after reading the snapshot.
    await reset();
    let injected = false;
    let calls = 0;
    const conflicted = client.$extends({
        query: {
            videoCacheTask: {
                async update({ args, query }) {
                    calls++;
                    if (!injected) {
                        injected = true;
                        await other.videoCacheTask.update({
                            where: { id: 1n },
                            data: { privateData: { ...privateData, concurrent_field: 42 } },
                        });
                    }
                    return query(args);
                },
            },
        },
    });
    assert.equal(
        await applyPlan(
            conflicted,
            planRepair(await get(), await channel(), config.providers),
            config,
            config.state_directory,
        ),
        true,
    );
    assertions++;
    assert.ok(calls >= 2);
    assertions++;
    assert.equal((await get()).privateData.concurrent_field, 42);
    assertions++;

    for (const change of [
        { status: 'FAILURE' },
        { finishTime: 1n },
        { privateData: { ...privateData, video_cached_at: now } },
        { privateData: { ...privateData, execution: {} } },
        { privateData: { ...privateData, upstream_result_url: 'https://other.example/video.mp4' } },
    ]) {
        await reset();
        const expected = planRepair(await get(), await channel(), config.providers);
        await other.videoCacheTask.update({ where: { id: 1n }, data: change });
        const changed = await get();
        assert.equal(await applyPlan(client, expected, config, config.state_directory), false);
        assertions++;
        assert.deepEqual(await get(), changed);
        assertions++;
    }
    await reset();
    const expected = planRepair(await get(), await channel(), config.providers);
    await other.videoCacheChannel.update({ where: { id: 8n }, data: { baseUrl: 'https://other.example' } });
    assert.equal(await applyPlan(client, expected, config, config.state_directory), false);
    assertions++;
    console.log(JSON.stringify({ isolated_prisma_assertions: assertions, real_serialization_retry: true }));

    // Optional: download one ALREADY generated public video, without submitting
    // a model request. The copied media capability is root-only test input.
    if (fs.existsSync('/run/video-cache-fixture-media.json')) {
        const mediaFixture = JSON.parse(fs.readFileSync('/run/video-cache-fixture-media.json', 'utf8'));
        await reset();
        const initial = {
            ...privateData,
            upstream_task_id: mediaFixture.upstream_task_id,
            upstream_result_url: mediaFixture.source_url,
            video_cache_last_error: `download video for cache: Get "${mediaFixture.target_url}": ${REDIRECT_ERROR}`,
        };
        await client.videoCacheTask.update({ where: { id: 1n }, data: { privateData: initial } });
        const summary = await run(client, config, true);
        assert.equal(summary.applied, 1);
        console.log(JSON.stringify({ isolated_download_source_repaired: true, waiting_for_newapi_worker: true }));
        let cached = false;
        for (let attempt = 0; attempt < 90; attempt++) {
            const row = await get();
            if (row.privateData.video_cached_at > 0) {
                cached = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        assert.ok(cached, 'unchanged new-api worker must cache the repaired existing artifact');
        console.log(JSON.stringify({ isolated_newapi_worker_cached_video: true, new_generation_requests: 0 }));
    }
} finally {
    await client.$disconnect();
    await other.$disconnect();
}
