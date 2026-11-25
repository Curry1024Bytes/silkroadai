import 'server-only';

import { prisma } from '@/lib/db';
import { resolveLogIdentity } from '@/lib/reqlog/identity';
import { readSdSpecialTaskTimings } from '@/lib/sd-special-video-delivery';
import { isSdSpecialPublicModel, sdSpecialPublicModelForSku } from '@/lib/sd-special-video';
import { readCustomerVideoTasks, type ReadCustomerVideoTask } from '@/lib/customer-video-tasks';
import { safeVideoRequestSummary, type CustomerVideoTask, type VideoLogBilling } from '@/lib/video-task-display';

const aspectRatios = new Set(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']);
const officialModel = /^(?:doubao-seedance|artsdance)-[A-Za-z0-9.-]+$/;

export function recordsVideoMetadata(model: unknown): model is string {
    return typeof model === 'string' && (isSdSpecialPublicModel(model) || officialModel.test(model));
}

export type VideoLogDisplay = {
    model: string;
    video: VideoLogBilling | null;
};

export async function recordSdSpecialVideoMetadata(
    authHeader: string | null,
    request: Record<string, unknown>,
    response: unknown,
): Promise<void> {
    const model = request.model;
    if (!recordsVideoMetadata(model)) return;
    const summary = safeVideoRequestSummary(request);
    const special = isSdSpecialPublicModel(model);
    if (special && !summary.resolution) return;
    const references = special ? request.references : request.content;
    const hasVideo = Array.isArray(references)
        ? references.some((item) => item?.type === 'video' || item?.type === 'video_url')
        : special
          ? false
          : undefined;
    if (hasVideo !== undefined) summary.hasVideo = hasVideo;
    const envelope = response as Record<string, unknown> | null;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return;
    const task =
        envelope.data && typeof envelope.data === 'object' ? (envelope.data as Record<string, unknown>) : envelope;
    if (typeof task.id !== 'string' || !/^task_[A-Za-z0-9]{32}$/.test(task.id)) return;
    const taskId = task.id;
    try {
        const identity = await resolveLogIdentity(authHeader);
        if (!identity.user_id) return;
        const userId = identity.user_id;
        await prisma.$transaction(
            (tx) =>
                tx.sdVideoTaskMetadata.createMany({
                    data: [
                        {
                            task_id: taskId,
                            user_id: userId,
                            public_model: model,
                            resolution: summary.resolution ?? null,
                            has_video: hasVideo ?? null,
                            aspect_ratio: summary.ratio && aspectRatios.has(summary.ratio) ? summary.ratio : null,
                            request_summary: { ...summary },
                        },
                    ],
                    skipDuplicates: true,
                }),
            { maxWait: 2000, timeout: 2000 },
        );
    } catch {
        console.warn('[sd-video-metadata] task metadata could not be saved');
    }
}

export async function enrichSdSpecialVideoLogs<Display extends VideoLogDisplay>(
    rows: Display[],
    owner: { userId: string; newapiUserId: number },
): Promise<Display[]> {
    const taskIds = [
        ...new Set(
            rows.flatMap((row) => {
                const id = row.video?.taskId;
                const model = sdSpecialPublicModelForSku(row.model) ?? row.model;
                return id && recordsVideoMetadata(model) && /^task_[A-Za-z0-9]{32}$/.test(id) ? [id] : [];
            }),
        ),
    ];
    const snapshots = new Map<
        string,
        {
            public_model: string;
            resolution: string | null;
            has_video: boolean | null;
            aspect_ratio: string | null;
            request_summary?: unknown;
        }
    >();
    let timings = new Map<string, { model: string; elapsedSec: number }>();
    let tasks = new Map<string, ReadCustomerVideoTask>();
    if (taskIds.length) {
        const [saved, completed] = await Promise.allSettled([
            Promise.resolve().then(() =>
                prisma.sdVideoTaskMetadata.findMany({
                    where: { user_id: owner.userId, task_id: { in: taskIds } },
                    select: {
                        task_id: true,
                        public_model: true,
                        resolution: true,
                        has_video: true,
                        aspect_ratio: true,
                        request_summary: true,
                    },
                }),
            ),
            readCustomerVideoTasks(owner.newapiUserId, taskIds),
        ]);
        if (saved.status === 'fulfilled') {
            for (const snapshot of saved.value) snapshots.set(snapshot.task_id, snapshot);
        } else console.warn('[sd-video-metadata] saved specifications unavailable');
        if (completed.status === 'fulfilled') tasks = completed.value;
        else console.warn('[video-task-metadata] task details unavailable');
        const fallbackIds = rows.flatMap((row) => {
            const model = sdSpecialPublicModelForSku(row.model) ?? row.model;
            const id = row.video?.taskId;
            return id && isSdSpecialPublicModel(model) && !tasks.has(id) ? [id] : [];
        });
        if (fallbackIds.length) {
            try {
                timings = await readSdSpecialTaskTimings(owner.newapiUserId, [...new Set(fallbackIds)]);
            } catch {
                console.warn('[sd-video-metadata] task timing unavailable');
            }
        }
    }
    return rows.map((row) => {
        const model = sdSpecialPublicModelForSku(row.model) ?? row.model;
        const video = row.video;
        if (!video?.taskId) return { ...row, model };
        const saved = snapshots.get(video.taskId);
        const snapshot = saved?.public_model === model ? saved : null;
        const timing = timings.get(video.taskId);
        const lookup = tasks.get(video.taskId);
        const details = lookup?.model === model ? lookup.display : undefined;
        const elapsedSec = details
            ? details.elapsedSec
            : timing?.model === model
              ? timing.elapsedSec
              : video.elapsedSec;
        const request = { ...details?.request, ...safeVideoRequestSummary(snapshot?.request_summary) };
        const emptyTask: CustomerVideoTask = {
            status: 'unknown',
            progress: null,
            submittedAt: null,
            finishedAt: null,
            elapsedSec,
            outputSeconds: null,
            outputResolution: null,
            outputRatio: null,
            mediaAvailable: false,
            request,
        };
        const task = details ? { ...details, request } : Object.keys(request).length ? emptyTask : undefined;
        return {
            ...row,
            model,
            video: {
                ...video,
                resolution: video.resolution ?? snapshot?.resolution ?? null,
                videoInput:
                    video.videoInput ?? (snapshot?.has_video == null ? null : snapshot.has_video ? 'video' : 'none'),
                ratio: video.ratio ?? snapshot?.aspect_ratio ?? null,
                elapsedSec,
                ...(task ? { task } : {}),
            },
        };
    });
}
