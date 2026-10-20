/**
 * Bounded compatibility for a provider's verified public-video redirect.
 * No HTTP/provider/model calls. new-api alone downloads and expires the video.
 * Database mutations use Prisma serializable transactions; no raw SQL.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const TTL_SECONDS = 48 * 60 * 60;
export const REDIRECT_ERROR = 'credentialed video cache request cannot redirect across origins';
const TASK_ID = /^task_[A-Za-z0-9]{32}$/;
const PLATFORMS = new Map([
    [59n, new Set(['59', 'newapi-video', 'newapi_video'])],
    [64n, new Set(['64', 'minimax-video', 'minimax_video'])],
]);
const origin = z
    .string()
    .regex(/^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)+$/)
    .refine((value) => value === value.trim());
export const jobConfigSchema = z
    .object({
        state_directory: z.string().refine((value) => path.isAbsolute(value)),
        batch_size: z.number().int().min(1).max(100),
        providers: z
            .array(z.object({ api_origin: origin, media_origin: origin }).strict())
            .min(1)
            .max(20),
    })
    .strict()
    .refine(
        ({ providers }) =>
            new Set(providers.map((entry) => entry.api_origin)).size === providers.length &&
            providers.every((entry) => entry.api_origin !== entry.media_origin),
    );

function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeJsonNumbers(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
    if (Array.isArray(value)) return value.every(safeJsonNumbers);
    if (record(value)) return Object.values(value).every(safeJsonNumbers);
    return true;
}

/** Return only non-credential metadata. The private JSON is never journaled. */
export function planRepair(task, channel, providers, now = Math.floor(Date.now() / 1000)) {
    const data = task?.privateData;
    if (
        !record(data) ||
        !safeJsonNumbers(data) ||
        !channel ||
        task.status !== 'SUCCESS' ||
        typeof task.id !== 'bigint' ||
        task.id <= 0n ||
        typeof task.channelId !== 'bigint' ||
        task.channelId !== channel.id ||
        typeof task.finishTime !== 'bigint' ||
        task.finishTime > BigInt(now) ||
        task.finishTime <= BigInt(now - TTL_SECONDS) ||
        typeof task.taskId !== 'string' ||
        task.taskId.length !== 37 ||
        !TASK_ID.test(task.taskId) ||
        typeof data.upstream_task_id !== 'string' ||
        data.upstream_task_id.length !== 37 ||
        !TASK_ID.test(data.upstream_task_id) ||
        ![undefined, null, 0].includes(data.video_cached_at) ||
        data.execution != null ||
        !PLATFORMS.get(channel.type)?.has(task.platform)
    )
        return null;
    for (const provider of providers) {
        if (![provider.api_origin, provider.api_origin + '/'].includes(channel.baseUrl)) continue;
        const suffix = `/video-cache/${data.upstream_task_id}.mp4`;
        const source = provider.api_origin + suffix;
        const target = provider.media_origin + suffix;
        const expectedError = `download video for cache: Get "${target}": ${REDIRECT_ERROR}`;
        if (data.upstream_result_url !== source || data.video_cache_last_error !== expectedError) return null;
        return {
            id: String(task.id),
            task_id: task.taskId,
            channel_id: String(channel.id),
            channel_type: String(channel.type),
            base_url: channel.baseUrl,
            platform: task.platform,
            finish_time: String(task.finishTime),
            upstream_task_id: data.upstream_task_id,
            source_url: source,
            target_url: target,
            cache_error: expectedError,
        };
    }
    return null;
}

export async function candidates(client, config, now = Math.floor(Date.now() / 1000)) {
    const channels = await client.videoCacheChannel.findMany({
        select: { id: true, type: true, baseUrl: true },
        where: {
            type: { in: [59n, 64n] },
            baseUrl: { in: config.providers.flatMap((entry) => [entry.api_origin, entry.api_origin + '/']) },
        },
    });
    if (!channels.length) return [];
    const byId = new Map(channels.map((channel) => [String(channel.id), channel]));
    const tasks = await client.videoCacheTask.findMany({
        where: {
            channelId: { in: channels.map((channel) => channel.id) },
            status: 'SUCCESS',
            finishTime: { gt: BigInt(now - TTL_SECONDS), lte: BigInt(now) },
            AND: [
                { privateData: { path: ['video_cache_last_error'], string_contains: REDIRECT_ERROR } },
                {
                    OR: config.providers.map((entry) => ({
                        privateData: {
                            path: ['upstream_result_url'],
                            string_starts_with: entry.api_origin + '/video-cache/',
                        },
                    })),
                },
            ],
        },
        orderBy: [{ finishTime: 'asc' }, { id: 'asc' }],
        take: config.batch_size,
    });
    return tasks
        .map((task) => planRepair(task, byId.get(String(task.channelId)), config.providers, now))
        .filter(Boolean);
}

export function privateFile(filename, value) {
    const descriptor = fs.openSync(
        filename,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
    );
    try {
        fs.writeFileSync(descriptor, JSON.stringify(value) + '\n');
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

export function saveIntent(directory, plan) {
    const name = `${Date.now()}-${crypto.randomUUID()}.before.json`;
    const filename = path.join(directory, name);
    privateFile(filename, { prepared_at: Math.floor(Date.now() / 1000), plan });
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    return filename;
}

/** Serializable snapshot + retry prevents overwriting concurrently added JSON. */
export async function applyPlan(client, expected, config, state, backup = saveIntent) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const result = await client.$transaction(
                async (tx) => {
                    const task = await tx.videoCacheTask.findUnique({ where: { id: BigInt(expected.id) } });
                    if (!task) return null;
                    const channel = await tx.videoCacheChannel.findUnique({
                        where: { id: task.channelId },
                        select: { id: true, type: true, baseUrl: true },
                    });
                    const current = planRepair(task, channel, config.providers);
                    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return null;
                    const intent = backup(state, current);
                    await tx.videoCacheTask.update({
                        where: { id: task.id },
                        data: {
                            privateData: {
                                ...task.privateData,
                                upstream_result_url: current.target_url,
                                video_cache_next_retry_at: 0,
                            },
                        },
                    });
                    return intent;
                },
                { isolationLevel: 'Serializable', maxWait: 2000, timeout: 10_000 },
            );
            if (!result) return false;
            privateFile(result + '.applied.json', { applied_at: Math.floor(Date.now() / 1000), id: expected.id });
            return true;
        } catch (error) {
            if (error?.code === 'P2034' && attempt < 2) continue;
            throw error;
        }
    }
    return false;
}

export async function run(client, config, apply = false) {
    const plans = await candidates(client, config);
    const summary = { mode: apply ? 'apply' : 'dry-run', eligible: plans.length, applied: 0, raced: 0 };
    if (!apply) return summary;
    const state = config.state_directory;
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(state);
    if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077)
        throw new Error('private_state_required');
    for (const plan of plans) {
        if (await applyPlan(client, plan, config, state)) summary.applied++;
        else summary.raced++;
    }
    const temporary = path.join(state, `last-run-${crypto.randomUUID()}.tmp`);
    privateFile(temporary, { finished_at: Math.floor(Date.now() / 1000), ...summary });
    fs.renameSync(temporary, path.join(state, 'last-run.json'));
    return summary;
}

async function main() {
    process.umask(0o077);
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--apply')) throw new Error('invalid_arguments');
    const config = jobConfigSchema.parse(
        JSON.parse(fs.readFileSync('/run/video-cache-repair-config.json', 'utf8')).job,
    );
    const database = JSON.parse(fs.readFileSync('/run/video-cache-repair-database.json', 'utf8'));
    const { PrismaClient } = await import('../src/generated/newapi-video-cache/index.js');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const client = new PrismaClient({ adapter: new PrismaPg({ ...database, max: 1, connectionTimeoutMillis: 3000 }) });
    try {
        console.log(JSON.stringify(await run(client, config, args.includes('--apply'))));
    } finally {
        await client.$disconnect();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((error) => {
        // Prisma errors can contain connection details and private media URLs.
        console.error(
            JSON.stringify({
                error: 'video_cache_source_repair_failed',
                kind: error?.constructor?.name,
                ...(typeof error?.code === 'string' && /^P\d{4}$/.test(error.code) ? { code: error.code } : {}),
            }),
        );
        process.exitCode = 1;
    });
}
