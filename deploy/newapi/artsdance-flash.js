const model = 'artsdance-2-5-flash-261101';
const taskPath = '/api/v3/contents/generations/tasks';
const sizes = { '480p': [854, 480], '720p': [1280, 720] };
const roles = {
    image_url: ['first_frame', 'last_frame', 'reference_image'],
    video_url: ['reference_video'],
    audio_url: ['reference_audio'],
};

export const meta = {
    apiVersion: 1,
    key: 'llmroute_artsdance_flash',
    name: 'Seedance 2.5 Flash',
    version: '0.1.0',
    author: { name: 'LLmRoute' },
    models: [model],
    fetchMode: 'per_task',
    protocols: ['openai_video'],
    usageSchema: {
        resolution: { enum: ['480p', '720p'] },
        video_input: { enum: ['none', 'video'] },
        tokens: { type: 'number', unit: 'token', description: 'Billed tokens' },
    },
    usageExamples: [{ label: '480p · 4s', facts: { resolution: '480p', video_input: 'none', tokens: 38430 } }],
};

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function httpsUrl(value) {
    return typeof value === 'string' && /^https:\/\/[^\s\x00-\x1f]+$/i.test(value) ? value : null;
}

function normalizeContent(item) {
    if (!isObject(item)) throw new Error('Invalid content item');
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim())
        return { type: 'text', text: item.text };
    if (!Object.hasOwn(roles, item.type)) throw new Error('Unsupported content type');
    const url = httpsUrl(item[item.type]?.url);
    if (!url) throw new Error('Reference media requires an HTTPS URL');
    const role = item.role ?? roles[item.type][roles[item.type].length - 1];
    if (!roles[item.type].includes(role)) throw new Error('Unsupported reference media role');
    return { type: item.type, role, [item.type]: { url } };
}

function decodeRequest(ctx) {
    const input = ctx.body?.value;
    if (ctx.body?.kind !== 'json' || !isObject(input)) throw new Error('JSON object required');
    if (input.model !== model || ctx.model !== model) throw new Error('Invalid model');
    const metadata = input.metadata ?? {};
    if (!isObject(metadata)) throw new Error('metadata must be an object');
    if (input.callback_url || metadata.callback_url) throw new Error('callback_url is not supported');
    const resolution = String(input.resolution ?? metadata.resolution ?? '720p').toLowerCase();
    if (!Object.hasOwn(sizes, resolution)) throw new Error('Expected 480p or 720p');
    const duration = Number(input.duration ?? input.seconds ?? metadata.duration ?? 4);
    const ratio = input.ratio ?? metadata.ratio ?? '16:9';
    if (duration !== 4 || ratio !== '16:9') throw new Error('Flash pilot requires 4 seconds and a 16:9 aspect ratio');
    const rawContent =
        input.content ?? metadata.content ?? (input.prompt ? [{ type: 'text', text: input.prompt }] : []);
    if (!Array.isArray(rawContent) || !rawContent.length) throw new Error('content is required');
    const content = rawContent.map(normalizeContent);
    const generateAudio = input.generate_audio ?? metadata.generate_audio;
    if (generateAudio != null && typeof generateAudio !== 'boolean') throw new Error('generate_audio must be boolean');
    return {
        kind: 'submit',
        model,
        action: content.some((item) => item.type !== 'text') ? 'image_to_video' : 'text_to_video',
        requestBody: {
            model,
            resolution,
            ratio,
            duration,
            content,
            ...(generateAudio == null ? {} : { generate_audio: generateAudio }),
        },
    };
}

export const protocols = {
    openai_video: {
        decodeRequest,
        render(_ctx, task) {
            return {
                resolution: task.data?.resolution,
                ratio: task.data?.ratio,
                duration: task.data?.duration,
            };
        },
    },
};

export function extractUsage(ctx) {
    const { resolution, duration, content } = ctx.requestBody;
    const [width, height] = sizes[resolution];
    return {
        resolution,
        tokens: Math.ceil((duration * width * height * 24) / 1024),
        video_input: content.some((item) => item.type === 'video_url') ? 'video' : 'none',
    };
}

function supplierRequest(ctx, path, method) {
    return {
        url: ctx.baseUrl.replace(/\/$/, '') + path,
        method,
        headers: { Authorization: 'Bearer ' + ctx.apiKey, 'Content-Type': 'application/json' },
    };
}

export function buildSubmitRequest(ctx) {
    return { ...supplierRequest(ctx, taskPath, 'POST'), body: ctx.requestBody };
}

export function parseSubmitResponse(_ctx, response) {
    const id = response.body?.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Missing upstream task ID');
    return { taskId: id, taskData: { id } };
}

export function buildQueryRequest(ctx) {
    return supplierRequest(ctx, taskPath + '/' + encodeURIComponent(ctx.taskId), 'GET');
}

function completedUsage(body) {
    if (body?.status !== 'succeeded') return null;
    const resolution = body.content?.resolution ?? body.resolution;
    const tokens = [body.usage?.completion_tokens, body.usage?.total_tokens]
        .map(Number)
        .find((value) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647);
    if (!tokens || !Object.hasOwn(sizes, resolution)) return null;
    return { tokens, resolution };
}

export function parseTaskResult(_ctx, body) {
    if (body?.status === 'queued') return { status: 'QUEUED', progress: '10%' };
    if (body?.status === 'running') return { status: 'IN_PROGRESS', progress: '50%' };
    if (body?.status === 'succeeded') {
        const url = httpsUrl(body.content?.video_url);
        if (url && completedUsage(body)) return { status: 'SUCCESS', progress: '100%', url };
        return { status: 'IN_PROGRESS', progress: '90%' };
    }
    if (['failed', 'expired', 'cancelled'].includes(body?.status))
        return { status: 'FAILURE', progress: '100%', reason: 'Video generation failed' };
    throw new Error('Unknown upstream task status');
}

export function extractUsageOnComplete(_task, _result, body) {
    return completedUsage(body) ?? {};
}

export function listArtifacts(task) {
    return task.status === 'SUCCESS' && httpsUrl(task.data?.content?.video_url)
        ? [{ key: 'video', type: 'video', mimeType: 'video/mp4' }]
        : [];
}

export function buildContentRequest(ctx) {
    const url = httpsUrl(ctx.data?.content?.video_url);
    if (ctx.artifactKey !== 'video' || !url) throw new Error('artifact_not_found');
    return { url, method: ctx.clientRequest.method, credentialless: true };
}
