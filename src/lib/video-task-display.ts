import type { VideoTaskBilling } from '@/lib/newapi/log-display';

export type VideoTaskStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'unknown';

export type VideoLogBilling = VideoTaskBilling & { elapsedSec: number | null; task?: CustomerVideoTask };

export interface VideoRequestSummary {
    resolution?: string;
    ratio?: string;
    duration?: number;
    generateAudio?: boolean;
    watermark?: boolean;
    seed?: number;
    hasVideo?: boolean;
}

export interface CustomerVideoTask {
    status: VideoTaskStatus;
    progress: number | null;
    submittedAt: number | null;
    finishedAt: number | null;
    elapsedSec: number | null;
    outputSeconds: number | null;
    outputResolution: string | null;
    outputRatio: string | null;
    request: VideoRequestSummary;
    mediaAvailable: boolean;
}

export function safeVideoRequestSummary(value: unknown): VideoRequestSummary {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const input = value as Record<string, unknown>;
    const result: VideoRequestSummary = {};
    if (typeof input.resolution === 'string' && /^(480|720|1080)p$/.test(input.resolution))
        result.resolution = input.resolution;
    const ratio = input.ratio ?? input.aspect_ratio;
    if (typeof ratio === 'string' && ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive'].includes(ratio))
        result.ratio = ratio;
    if (
        typeof input.duration === 'number' &&
        Number.isFinite(input.duration) &&
        (input.duration === -1 || (input.duration > 0 && input.duration <= 120))
    )
        result.duration = input.duration;
    for (const [source, target] of [
        ['generate_audio', 'generateAudio'],
        ['watermark', 'watermark'],
        ['has_video', 'hasVideo'],
    ] as const)
        if (typeof (input[source] ?? input[target]) === 'boolean')
            result[target] = (input[source] ?? input[target]) as boolean;
    if (
        typeof input.seed === 'number' &&
        Number.isSafeInteger(input.seed) &&
        input.seed >= -1 &&
        input.seed <= 4294967295
    )
        result.seed = input.seed;
    return result;
}
