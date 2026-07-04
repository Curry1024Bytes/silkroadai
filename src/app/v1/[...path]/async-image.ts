/**
 * 异步生图任务的 DB + 响应信封层(纯数据,不 import route.ts,避免循环依赖)。
 *
 * 契约(对齐客户参考平台的嵌套信封):
 *   提交  POST /v1/images/{generations,edits}?async=true  → { code, message, data:{ task_id, status, submit_time } }
 *   查询  GET  /v1/images/tasks/{task_id}                  → { code, message, data:{ 任务信封, data:{OpenAI 图结果} } }
 *
 * 后台执行(跑 handleImagesDalle、存图)在 route.ts 里做,完成后回调本文件的
 * saveTaskSuccess / saveTaskFailure 落库。计费不变(后台真调 new-api)。
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';

/** 在途任务超过此龄仍 IN_PROGRESS = 视为孤儿(portal 重启杀掉了后台任务)→ 查询时判 FAILURE。
 *  取 10 分钟:实测最慢生图 ~230s,10min 足够覆盖正常慢图、又能兜住重启遗留。 */
const MAX_TASK_AGE_MS = 10 * 60 * 1000;

export type ImageTaskEndpoint = 'generations' | 'edits';

/** 32-hex,不带前缀/连字符(对齐参考平台 `3dad96708a77485e97ac7ef652796d7b`)。 */
export function newImageTaskId(): string {
    return randomUUID().replace(/-/g, '');
}

export async function createImageTask(
    taskId: string,
    userId: string,
    model: string | null,
    endpoint: ImageTaskEndpoint,
): Promise<void> {
    await prisma.imageTask.create({
        data: { task_id: taskId, user_id: userId, model, endpoint, status: 'IN_PROGRESS' },
    });
}

export async function markImageTaskStarted(taskId: string): Promise<void> {
    // best-effort:落 start_time,失败不影响生图本身
    await prisma.imageTask.update({ where: { task_id: taskId }, data: { started_at: new Date() } }).catch(() => {});
}

/** 成功:内层 OpenAI 图结果(data/model/created/usage)落库。 */
export async function saveImageTaskSuccess(taskId: string, resultJson: unknown): Promise<void> {
    await prisma.imageTask
        .update({
            where: { task_id: taskId },
            data: {
                status: 'SUCCESS',
                result_json: resultJson as never,
                fail_reason: null,
                finished_at: new Date(),
            },
        })
        .catch((e: unknown) => console.error('[async-image] saveSuccess failed', taskId, e));
}

export async function saveImageTaskFailure(taskId: string, reason: string): Promise<void> {
    await prisma.imageTask
        .update({
            where: { task_id: taskId },
            data: { status: 'FAILURE', fail_reason: reason.slice(0, 2000), finished_at: new Date() },
        })
        .catch((e: unknown) => console.error('[async-image] saveFailure failed', taskId, e));
}

type ImageTaskRow = {
    task_id: string;
    user_id: string;
    status: string;
    model: string | null;
    endpoint: string;
    result_json: unknown;
    fail_reason: string | null;
    started_at: Date | null;
    finished_at: Date | null;
    created_at: Date;
};

/** 按 task_id + user_id 取任务(IDOR:非本人 = 当作不存在)。孤儿(IN_PROGRESS 超龄)判 FAILURE。 */
export async function getImageTask(taskId: string, userId: string): Promise<ImageTaskRow | null> {
    const row = (await prisma.imageTask.findUnique({ where: { task_id: taskId } })) as ImageTaskRow | null;
    if (!row || row.user_id !== userId) return null;
    if (row.status === 'IN_PROGRESS' && Date.now() - row.created_at.getTime() > MAX_TASK_AGE_MS) {
        await saveImageTaskFailure(taskId, 'task expired (server restarted or timed out); please resubmit');
        return { ...row, status: 'FAILURE', fail_reason: 'task expired; please resubmit', finished_at: new Date() };
    }
    return row;
}

const unix = (d: Date | null): number => (d ? Math.floor(d.getTime() / 1000) : 0);

/** 提交响应信封。 */
export function buildSubmitEnvelope(taskId: string, submitTime: Date): Record<string, unknown> {
    return {
        code: 'success',
        message: '',
        data: { task_id: taskId, status: 'IN_PROGRESS', submit_time: unix(submitTime) },
    };
}

/** 查询响应信封(对齐参考平台三层嵌套:data.data.data[0].url)。 */
export function buildQueryEnvelope(row: ImageTaskRow): Record<string, unknown> {
    const progress = row.status === 'SUCCESS' ? '100%' : row.status === 'IN_PROGRESS' ? '0%' : '';
    return {
        code: 'success',
        message: '',
        data: {
            task_id: row.task_id,
            platform: 'sync-task',
            action: 'image-sync',
            status: row.status,
            fail_reason: row.fail_reason ?? '',
            submit_time: unix(row.created_at),
            start_time: unix(row.started_at),
            finish_time: unix(row.finished_at),
            progress,
            data: row.status === 'SUCCESS' ? (row.result_json ?? null) : null,
            search_item: '',
        },
    };
}

/** 查不到 / 非本人(IDOR:两者不可区分)。 */
export function notFoundEnvelope(): Record<string, unknown> {
    return { code: 'not_found', message: 'task not found', data: null };
}

/** 任务完成回调(webhook)的 topic。data 用与查询响应一致的 data,客户 handler 与轮询同一套解析。 */
export const WEBHOOK_TOPIC = 'image_task_completed';

/** 构造 webhook 载荷(内部,无 IDOR):`{ topic, data }`,data 即查询响应的 data。任务不存在 → null。 */
export async function buildWebhookForTask(taskId: string): Promise<{ topic: string; data: unknown } | null> {
    const row = (await prisma.imageTask.findUnique({ where: { task_id: taskId } })) as ImageTaskRow | null;
    if (!row) return null;
    return { topic: WEBHOOK_TOPIC, data: buildQueryEnvelope(row).data };
}
