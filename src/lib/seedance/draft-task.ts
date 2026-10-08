/**
 * 样片模式第二步「按样片出正片」(火山官方 draft / draft_task,2026-10-08)。
 *
 * 官方契约(volcengine-python-sdk create_task_content_param.py):
 *   content: [{ type: 'draft_task', draft_task: { id: '<样片任务号>' } }]
 * 查询响应带 `draft`(bool)+ `draft_task_id`。提示词 / 参考素材 / 时长 / 比例 / 音频等由样片沿用,
 * 正片可重指定 resolution。
 *
 * 我们的任务号是自造的 cgt-(与方舟真号无关,见 svcinf-client.makeArkTaskId),而上游
 * service-inference.ai **不翻译** draft_task.id(2026-10-08 实测:传 mvt- 号方舟原样回
 * 「received: mvt-…」拒)—— 必须把客户样片号 → volc_id_map 拿 mvt- 受理号 → GET 上游任务
 * 取 metadata.id(方舟真号)→ 替换进 draft_task.id 再发。归属 / 完成态由 proxy 先按库行校验,
 * 这里只做号的翻译与上游状态二次确认。
 */
import 'server-only';
import { toUpstreamId } from '@/lib/enterprise/volc-id-map';
import { fetchSvcinfArkTaskId, isSvcinfTaskId, type SvcinfConfig } from './svcinf-client';

export class DraftTaskError extends Error {}

export interface DraftTaskRef {
    id: string;
}

/**
 * 从 body.content 抽 draft_task 引用(官方形)。无 → null;形状不对 / 多个 → 抛 DraftTaskError(调用方 400)。
 * 兼容客户把 id 写成 `draft_task.task_id` / `draft_task_id` 的常见手误。
 */
export function extractDraftTaskRef(body: Record<string, unknown>): DraftTaskRef | null {
    const content = body.content;
    if (!Array.isArray(content)) return null;
    const items = content.filter((c) => (c as { type?: unknown })?.type === 'draft_task');
    if (items.length === 0) return null;
    if (items.length > 1) throw new DraftTaskError('content 里只能有一个 draft_task 引用');
    const o = items[0] as { draft_task?: unknown; draft_task_id?: unknown };
    const dt = o.draft_task as { id?: unknown; task_id?: unknown } | undefined;
    const raw = dt?.id ?? dt?.task_id ?? o.draft_task_id;
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) throw new DraftTaskError('draft_task.id 必填(样片任务号,形如 cgt-…)');
    return { id };
}

/** 把 content 里 draft_task 的 id 换成上游认的号(其余项原样)。 */
export function rewriteDraftTaskId(content: unknown[], upstreamArkId: string): unknown[] {
    return content.map((c) =>
        (c as { type?: unknown })?.type === 'draft_task'
            ? { type: 'draft_task', draft_task: { id: upstreamArkId } }
            : c,
    );
}

export type DraftTaskResolve =
    | { ok: true; arkId: string }
    | { ok: false; status: number; code: string; message: string };

/**
 * 客户样片号 → 方舟真号。
 *  - 非 service-inference.ai 任务(存量 xinhankr 号 / 查不到映射)→ 400:那条线出的样片我们没法出正片
 *  - 上游任务未完成 / 取不到 metadata.id → 400 / 502
 */
export async function resolveDraftTaskArkId(
    cfg: SvcinfConfig,
    clientDraftId: string,
    log: string,
): Promise<DraftTaskResolve> {
    const upstreamId = await toUpstreamId(clientDraftId);
    if (!isSvcinfTaskId(upstreamId)) {
        return {
            ok: false,
            status: 400,
            code: 'invalid_request',
            message: `draft_task.id ${clientDraftId} 不是可出正片的样片任务(需 doubao-seedance-2-5 且 draft:true 生成)`,
        };
    }
    const r = await fetchSvcinfArkTaskId(cfg, upstreamId, log);
    if (!r.ok) {
        return { ok: false, status: 502, code: 'upstream_unreachable', message: '样片任务查询失败,请稍后重试' };
    }
    if (r.status !== 'completed') {
        return {
            ok: false,
            status: 400,
            code: 'invalid_request',
            message: `样片任务 ${clientDraftId} 尚未完成(当前 ${r.status || 'unknown'}),完成后再出正片`,
        };
    }
    if (!r.arkId) {
        console.warn(`[${log}] draft task has no ark id in metadata`, { clientDraftId, upstreamId });
        return { ok: false, status: 502, code: 'upstream_error', message: '样片任务缺少上游任务号,无法出正片' };
    }
    return { ok: true, arkId: r.arkId };
}
