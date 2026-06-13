/**
 * RequestLog 访问审计(数据存储 Phase 1 第③步)。
 *
 * superadmin 每次访问受控查看入口都写一条 `RequestLogAccess`:
 *   - `list`       看了哪批(含筛选摘要)
 *   - `view_meta`  看某条元数据
 *   - `view_input` 拉某条请求原文(客户 prompt)—— 最敏感
 *   - `view_output`拉某条响应原文 —— 最敏感
 *
 * 治理铁律(brief §6.1):看**客户原文**(view_input/view_output)前**必须先写审计成功**
 * 才返回 body —— 写失败则拒绝展示(fail-closed)。`list`/`view_meta` 只看元数据
 * (不含客户内容)→ best-effort(写失败只 warn,不挡)。fail-closed/best-effort 由
 * 调用方决定:本 helper 只负责写,失败抛。
 */
import 'server-only';
import type { AdminPrincipal } from '@/lib/admin/auth';
import { prisma } from '@/lib/db';

export type AccessAction = 'list' | 'view_meta' | 'view_input' | 'view_output';

/** 拉取原文的字节阈值:超过则截断展示 + 提供完整下载。env 可调。 */
export const BODY_MAX_BYTES = Math.max(1024, Number(process.env.REQUEST_LOG_BODY_MAX_BYTES) || 256 * 1024);

/** query 摘要截断长度(审计行不该无限大)。 */
const QUERY_SUMMARY_MAX = 2000;

export interface AccessAuditInput {
    principal: AdminPrincipal;
    action: AccessAction;
    requestLogId?: string | null;
    /** list 的筛选条件摘要(调用方拼);view_* 不需要。 */
    query?: string | null;
    ip?: string | null;
}

/**
 * 写一条访问审计。**失败抛** —— 调用方据此决定:
 *   - view_input/view_output:`await` + catch → 拒绝返回 body(fail-closed)
 *   - list/view_meta:fire-and-forget + catch warn(best-effort,不阻塞看元数据)
 */
export async function writeAccessAudit(input: AccessAuditInput): Promise<void> {
    await prisma.requestLogAccess.create({
        data: {
            actor_user_id: input.principal.user?.id ?? null,
            via_break_glass: input.principal.viaBreakGlass,
            action: input.action,
            request_log_id: input.requestLogId ?? null,
            query: input.query ? input.query.slice(0, QUERY_SUMMARY_MAX) : null,
            ip: input.ip ?? null,
        },
    });
}
