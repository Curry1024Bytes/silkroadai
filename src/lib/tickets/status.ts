/**
 * 工单状态机 + 业务常量(纯函数,无 IO)。
 *
 *   open ──staff 回复──▶ waiting_customer ──客户回复──▶ open
 *   open / waiting_customer ──staff 解决──▶ resolved ──客户确认 / 7 天无异议──▶ closed
 *   resolved ──客户「未解决」──▶ open(reopen_count+1,超过 MAX_REOPENS 只能 staff 关)
 *   任何状态 ──staff──▶ closed(PR2:必须填 resolution);closed ──staff──▶ open(误关重开)
 *
 * system = 定时任务(PR3):waiting_customer 7 天无回复 → resolved;resolved 7 天 → closed。
 */
import type { TicketCategory, TicketStatus } from '@prisma/client';

export const TICKET_CATEGORIES = [
    'billing',
    'api_error',
    'recharge',
    'account',
    'other',
] as const satisfies readonly TicketCategory[];
export const TICKET_STATUSES = [
    'open',
    'waiting_customer',
    'resolved',
    'closed',
] as const satisfies readonly TicketStatus[];

/** 同一客户同时处于 open / waiting_customer / resolved 的工单上限。 */
export const MAX_OPEN_TICKETS_PER_USER = 5;
/** 创建频率:每用户每小时最多 3 单(只限这一个写入口,不碰 API 面)。 */
export const CREATE_RATE_LIMIT = { max: 3, windowMs: 60 * 60 * 1000 } as const;
/** 客户最多把同一工单重开几次。 */
export const MAX_REOPENS = 3;
/** waiting_customer → resolved、resolved → closed 的自动流转天数(PR3 定时任务用)。 */
export const AUTO_ADVANCE_AFTER_DAYS = 7;

export type TicketActor = 'customer' | 'staff' | 'system';

const TRANSITIONS: Record<TicketActor, Partial<Record<TicketStatus, readonly TicketStatus[]>>> = {
    customer: {
        waiting_customer: ['open'],
        resolved: ['closed', 'open'],
    },
    staff: {
        open: ['waiting_customer', 'resolved', 'closed'],
        waiting_customer: ['open', 'resolved', 'closed'],
        resolved: ['closed', 'open'],
        // 误关可由客服重开;客户侧 closed 是终态。
        closed: ['open'],
    },
    system: {
        waiting_customer: ['resolved'],
        resolved: ['closed'],
    },
};

export function canTransition(actor: TicketActor, from: TicketStatus, to: TicketStatus): boolean {
    return (TRANSITIONS[actor][from] ?? []).includes(to);
}

/** 这些分类没有 request_id 基本没法查,表单强制填写。 */
export function requiresRequestId(category: TicketCategory): boolean {
    return category === 'billing' || category === 'api_error';
}

/** 仍占用「开放工单」名额的状态(closed 以外都算)。 */
export const ACTIVE_STATUSES: readonly TicketStatus[] = ['open', 'waiting_customer', 'resolved'];

export function isActiveStatus(status: TicketStatus): boolean {
    return ACTIVE_STATUSES.includes(status);
}

/** 对客展示编号:T-000123。 */
export function formatTicketNumber(n: number): string {
    return `T-${String(n).padStart(6, '0')}`;
}

/** new-api request_id 形态:字母数字,前 14 位是 UTC 时间戳;放宽到 8–80 位容错。 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9]{8,80}$/;
