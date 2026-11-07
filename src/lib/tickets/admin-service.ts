/**
 * 客诉工单 — 管理员侧业务逻辑(PR2)。鉴权在 route(resolveAdmin ≥ admin),
 * 这里只做 tenantScope(partner admin 只看本租户工单)+ 状态机 + 补额 + 邮件。
 */
import {
    Prisma,
    type Ticket,
    type TicketCategory,
    type TicketPriority,
    type TicketResolution,
    type TicketStatus,
} from '@prisma/client';
import { prisma } from '@/lib/db';
import type { AdminPrincipal } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { adjustCustomerBalance } from '@/lib/billing/admin-adjust';
import { sendTicketUpdatedEmail } from '@/lib/email/send';
import { getQuotaWithCache, type QuotaSnapshot } from '@/lib/newapi/quota-cache';
import { queryLogs } from '@/lib/newapi/client';
import { quotaToCny } from '@/lib/newapi/quota-units';
import { TicketError, userLocale } from './service';
import { appUrl } from './http';
import { canTransition, formatTicketNumber, TICKET_STATUSES } from './status';

export type AdminTicketErrorCode = 'resolution_required' | 'credit_failed' | 'invalid_amount';

export class AdminTicketError extends Error {
    constructor(
        public readonly code: AdminTicketErrorCode,
        public readonly status: number,
    ) {
        super(code);
        this.name = 'AdminTicketError';
    }
}

const PAGE_SIZE = 50;
const EXCERPT_LEN = 300;

function actorOf(admin: AdminPrincipal): string {
    return admin.user ? `staff:${admin.user.email}` : 'staff:break-glass';
}

function staffAuthorId(admin: AdminPrincipal): string {
    return admin.user?.email ?? 'break-glass';
}

/** 工单 where 基底:租户隔离(superadmin 全量)。 */
function scoped(admin: AdminPrincipal, extra: Prisma.TicketWhereInput = {}): Prisma.TicketWhereInput {
    return { ...tenantScope(admin), ...extra };
}

export interface AdminListFilter {
    status: TicketStatus | 'all';
    category?: TicketCategory;
    /** T-000123 / 工单 uuid / 客户邮箱片段 / request_id */
    q?: string;
    page: number;
}

export interface AdminTicketRow {
    id: string;
    number: string;
    subject: string;
    category: TicketCategory;
    status: TicketStatus;
    priority: TicketPriority;
    customer: { id: string; email: string; nickname: string | null };
    request_id: string | null;
    model: string | null;
    disputed_cny: number | null;
    credit_cny: number | null;
    reopen_count: number;
    assignee: string | null;
    last_customer_msg_at: string | null;
    first_reply_at: string | null;
    created_at: string;
    updated_at: string;
}

function toRow(t: Ticket & { user: { id: string; email: string; nickname: string | null } }): AdminTicketRow {
    return {
        id: t.id,
        number: formatTicketNumber(t.number),
        subject: t.subject,
        category: t.category,
        status: t.status,
        priority: t.priority,
        customer: t.user,
        request_id: t.request_id,
        model: t.model,
        disputed_cny: t.disputed_cny ? Number(t.disputed_cny) : null,
        credit_cny: t.credit_cny ? Number(t.credit_cny) : null,
        reopen_count: t.reopen_count,
        assignee: t.assignee,
        last_customer_msg_at: t.last_customer_msg_at?.toISOString() ?? null,
        first_reply_at: t.first_reply_at?.toISOString() ?? null,
        created_at: t.created_at.toISOString(),
        updated_at: t.updated_at.toISOString(),
    };
}

export function searchWhere(q: string): Prisma.TicketWhereInput {
    const s = q.trim();
    const num = /^T-?0*(\d+)$/i.exec(s);
    if (num) return { number: Number(num[1]) };
    if (/^[0-9a-f-]{36}$/i.test(s)) return { id: s };
    if (/^[A-Za-z0-9]{8,80}$/.test(s) && !s.includes('@')) {
        return { OR: [{ request_id: s }, { user: { email: { contains: s, mode: 'insensitive' } } }] };
    }
    return { user: { email: { contains: s, mode: 'insensitive' } } };
}

export async function listTicketsAdmin(
    admin: AdminPrincipal,
    f: AdminListFilter,
): Promise<{ items: AdminTicketRow[]; total: number; counts: Record<TicketStatus, number> }> {
    const where = scoped(admin, {
        ...(f.status === 'all' ? {} : { status: f.status }),
        ...(f.category ? { category: f.category } : {}),
        ...(f.q ? searchWhere(f.q) : {}),
    });
    // open 队列按「客户等了多久」升序(最久的在前);其它按最近更新。
    const orderBy: Prisma.TicketOrderByWithRelationInput[] =
        f.status === 'open' ? [{ last_customer_msg_at: 'asc' }, { created_at: 'asc' }] : [{ updated_at: 'desc' }];
    const [rows, total, grouped] = await Promise.all([
        prisma.ticket.findMany({
            where,
            orderBy,
            skip: (f.page - 1) * PAGE_SIZE,
            take: PAGE_SIZE,
            include: { user: { select: { id: true, email: true, nickname: true } } },
        }),
        prisma.ticket.count({ where }),
        prisma.ticket.groupBy({ by: ['status'], where: scoped(admin), _count: { _all: true } }),
    ]);
    const counts = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<TicketStatus, number>;
    for (const g of grouped) counts[g.status] = g._count._all;
    return { items: rows.map(toRow), total, counts };
}

export interface AdminLogRow {
    createdAt: number;
    model: string;
    requestId: string;
    tokenName: string;
    costCny: number;
    failed: boolean;
    content: string;
    matched: boolean;
}

export interface AdminTicketContext {
    customer: {
        id: string;
        email: string;
        nickname: string | null;
        username: string | null;
        newapi_user_id: number | null;
        billing_mode: string;
        status: string;
        locale: string;
        created_at: string;
        ticket_count: number;
    };
    balance: (QuotaSnapshot & { remain_cny: number; used_cny: number }) | null;
    recharges: Array<{ id: string; amount: number; source: string; note: string | null; created_at: string }>;
    logs: AdminLogRow[];
    logs_error: string | null;
}

export async function getTicketAdmin(admin: AdminPrincipal, id: string) {
    const ticket = await prisma.ticket.findFirst({
        where: scoped(admin, { id }),
        include: {
            messages: { orderBy: { created_at: 'asc' } },
            events: { orderBy: { created_at: 'asc' } },
            user: {
                select: {
                    id: true,
                    email: true,
                    nickname: true,
                    newapi_username: true,
                    newapi_user_id: true,
                    billing_mode: true,
                    status: true,
                    locale: true,
                    created_at: true,
                },
            },
        },
    });
    if (!ticket) throw new TicketError('not_found', 404);
    return ticket;
}

/** 右栏上下文:余额 / 最近充值 / 最近调用(request_id 命中行标 matched)。每块独立降级。 */
export async function getTicketContext(
    ticket: Awaited<ReturnType<typeof getTicketAdmin>>,
): Promise<AdminTicketContext> {
    const u = ticket.user;
    const [balance, recharges, ticketCount, logsRes] = await Promise.all([
        getQuotaWithCache(u.id).catch(() => null),
        prisma.rechargeLog.findMany({
            where: { user_id: u.id },
            orderBy: { created_at: 'desc' },
            take: 5,
            select: { id: true, amount: true, source: true, note: true, created_at: true },
        }),
        prisma.ticket.count({ where: { user_id: u.id } }),
        u.newapi_user_id != null && u.newapi_username
            ? queryLogs({ username: u.newapi_username, user_id: u.newapi_user_id, type: 0, page: 1, page_size: 50 })
                  .then((r) => ({ items: r.items, error: null as string | null }))
                  .catch((e: unknown) => ({ items: [], error: e instanceof Error ? e.message : String(e) }))
            : Promise.resolve({ items: [], error: 'account_not_provisioned' }),
    ]);
    const logs: AdminLogRow[] = logsRes.items
        .filter((l) => l.user_id === u.newapi_user_id && (l.type === 2 || l.type === 5))
        .map((l) => ({
            createdAt: l.created_at,
            model: l.model_name,
            requestId: l.request_id,
            tokenName: l.token_name,
            costCny: quotaToCny(l.quota),
            failed: l.type === 5,
            content: l.content.slice(0, 200),
            matched: !!ticket.request_id && l.request_id === ticket.request_id,
        }));
    return {
        customer: {
            id: u.id,
            email: u.email,
            nickname: u.nickname,
            username: u.newapi_username,
            newapi_user_id: u.newapi_user_id,
            billing_mode: u.billing_mode,
            status: u.status,
            locale: u.locale,
            created_at: u.created_at.toISOString(),
            ticket_count: ticketCount,
        },
        balance: balance
            ? { ...balance, remain_cny: quotaToCny(balance.remain_quota), used_cny: quotaToCny(balance.used_quota) }
            : null,
        recharges: recharges.map((r) => ({
            id: r.id,
            amount: Number(r.amount),
            source: r.source,
            note: r.note,
            created_at: r.created_at.toISOString(),
        })),
        logs,
        logs_error: logsRes.error,
    };
}

function notifyCustomer(
    ticket: Pick<Ticket, 'id' | 'number' | 'subject'>,
    user: { email: string; locale: string },
    kind: 'staff_reply' | 'resolved' | 'closed',
    excerpt?: string,
): void {
    void sendTicketUpdatedEmail({
        to: user.email,
        locale: userLocale(user),
        number: formatTicketNumber(ticket.number),
        subject: ticket.subject,
        ticketUrl: `${appUrl()}/support/${ticket.id}`,
        kind,
        excerpt,
    }).catch((e) => console.warn(`[tickets/admin] ${kind} email failed for ${ticket.id}:`, e));
}

/** 客服回复:对客可见 → open/waiting_customer 进 waiting_customer + 首复时间 + 邮件;内部备注只落消息。 */
export async function staffReply(admin: AdminPrincipal, id: string, body: string, internal: boolean) {
    const result = await prisma.$transaction(async (tx) => {
        const ticket = await tx.ticket.findFirst({
            where: scoped(admin, { id }),
            include: { user: { select: { email: true, locale: true } } },
        });
        if (!ticket) throw new TicketError('not_found', 404);
        if (ticket.status === 'closed' && !internal) throw new TicketError('invalid_state', 409);
        const message = await tx.ticketMessage.create({
            data: { ticket_id: ticket.id, author_type: 'staff', author_id: staffAuthorId(admin), body, internal },
        });
        if (internal) return { ticket, message, statusChanged: false };
        const now = new Date();
        const nextStatus: TicketStatus =
            ticket.status === 'open' || ticket.status === 'waiting_customer' ? 'waiting_customer' : ticket.status;
        await tx.ticket.update({
            where: { id: ticket.id },
            data: {
                status: nextStatus,
                last_staff_msg_at: now,
                ...(ticket.first_reply_at ? {} : { first_reply_at: now }),
            },
        });
        if (nextStatus !== ticket.status) {
            await tx.ticketEvent.create({
                data: {
                    ticket_id: ticket.id,
                    type: 'status_changed',
                    actor: actorOf(admin),
                    payload: { from: ticket.status, to: nextStatus, reason: 'staff_reply' },
                },
            });
        }
        return { ticket, message, statusChanged: nextStatus !== ticket.status };
    });
    if (!internal) notifyCustomer(result.ticket, result.ticket.user, 'staff_reply', body.slice(0, EXCERPT_LEN));
    return result.message;
}

export interface ResolveInput {
    resolution: TicketResolution;
    /** 补额 ¥(> 0 才调用 add_quota)。 */
    creditCny?: number;
    /** 对客可见的处理说明(可选,作为一条 staff 消息)。 */
    note?: string;
}

/**
 * 处置 = (可选)补额 → 工单 resolved + resolution + credit_cny 累加 + 事件 + 邮件。
 * 补额先于 DB 事务:钱到账是不可逆的外部副作用,先做;事务失败只会少一条留痕
 * (RechargeLog / analyticsEvent 已由 adjustCustomerBalance 写),不会出现「记了补额却没补」。
 */
export async function resolveTicketAdmin(admin: AdminPrincipal, id: string, input: ResolveInput) {
    const ticket = await prisma.ticket.findFirst({
        where: scoped(admin, { id }),
        include: {
            user: {
                select: {
                    id: true,
                    email: true,
                    locale: true,
                    tenant_id: true,
                    billing_mode: true,
                    newapi_user_id: true,
                },
            },
        },
    });
    if (!ticket) throw new TicketError('not_found', 404);
    if (!canTransition('staff', ticket.status, 'resolved')) throw new TicketError('invalid_state', 409);

    const credit = input.creditCny ?? 0;
    if (!Number.isFinite(credit) || credit < 0) throw new AdminTicketError('invalid_amount', 400);
    let balanceAfter: number | null = null;
    if (credit > 0) {
        try {
            const r = await adjustCustomerBalance(ticket.user, {
                amountCny: credit,
                note: `工单 ${formatTicketNumber(ticket.number)} 补额${input.note ? `:${input.note.slice(0, 200)}` : ''}`,
                adjustedBy: admin.user?.id ?? null,
                viaBreakGlass: admin.viaBreakGlass,
                extra: { ticket_id: ticket.id },
            });
            balanceAfter = r.balance_cny;
        } catch (e) {
            console.error(`[tickets/admin] credit failed for ${ticket.id}:`, e);
            throw new AdminTicketError('credit_failed', 502);
        }
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
        const t = await tx.ticket.update({
            where: { id: ticket.id },
            data: {
                status: 'resolved',
                resolution: input.resolution,
                resolved_at: now,
                last_staff_msg_at: now,
                ...(ticket.first_reply_at ? {} : { first_reply_at: now }),
                ...(credit > 0
                    ? { credit_cny: new Prisma.Decimal((Number(ticket.credit_cny ?? 0) + credit).toFixed(4)) }
                    : {}),
            },
        });
        if (input.note) {
            await tx.ticketMessage.create({
                data: { ticket_id: ticket.id, author_type: 'staff', author_id: staffAuthorId(admin), body: input.note },
            });
        }
        if (credit > 0) {
            await tx.ticketEvent.create({
                data: {
                    ticket_id: ticket.id,
                    type: 'credited',
                    actor: actorOf(admin),
                    payload: { amount_cny: credit, balance_after_cny: balanceAfter },
                },
            });
        }
        await tx.ticketEvent.create({
            data: {
                ticket_id: ticket.id,
                type: 'status_changed',
                actor: actorOf(admin),
                payload: {
                    from: ticket.status,
                    to: 'resolved',
                    reason: 'staff_resolved',
                    resolution: input.resolution,
                },
            },
        });
        return t;
    });
    notifyCustomer(updated, ticket.user, 'resolved', input.note?.slice(0, EXCERPT_LEN));
    return { ticket: updated, balance_after_cny: balanceAfter };
}

export interface AdminUpdateInput {
    status?: 'closed' | 'open';
    priority?: TicketPriority;
    assignee?: string | null;
    resolution?: TicketResolution;
}

/** 改优先级 / 指派 / 关闭(必须有 resolution)/ 客服重开。 */
export async function updateTicketAdmin(admin: AdminPrincipal, id: string, input: AdminUpdateInput) {
    const result = await prisma.$transaction(async (tx) => {
        const ticket = await tx.ticket.findFirst({
            where: scoped(admin, { id }),
            include: { user: { select: { email: true, locale: true } } },
        });
        if (!ticket) throw new TicketError('not_found', 404);
        const data: Prisma.TicketUpdateInput = {};
        const events: Prisma.TicketEventCreateManyInput[] = [];
        if (input.priority && input.priority !== ticket.priority) {
            data.priority = input.priority;
            events.push({
                ticket_id: ticket.id,
                type: 'priority_changed',
                actor: actorOf(admin),
                payload: { from: ticket.priority, to: input.priority },
            });
        }
        if (input.assignee !== undefined && input.assignee !== ticket.assignee) {
            data.assignee = input.assignee;
            events.push({
                ticket_id: ticket.id,
                type: 'assigned',
                actor: actorOf(admin),
                payload: { to: input.assignee },
            });
        }
        if (input.resolution && input.resolution !== ticket.resolution) data.resolution = input.resolution;
        let closed = false;
        if (input.status === 'closed') {
            if (!canTransition('staff', ticket.status, 'closed')) throw new TicketError('invalid_state', 409);
            if (!(input.resolution ?? ticket.resolution)) throw new AdminTicketError('resolution_required', 400);
            data.status = 'closed';
            data.closed_at = new Date();
            closed = true;
            events.push({
                ticket_id: ticket.id,
                type: 'status_changed',
                actor: actorOf(admin),
                payload: { from: ticket.status, to: 'closed', reason: 'staff_closed' },
            });
        } else if (input.status === 'open') {
            if (!canTransition('staff', ticket.status, 'open')) throw new TicketError('invalid_state', 409);
            data.status = 'open';
            data.resolved_at = null;
            data.closed_at = null;
            events.push({
                ticket_id: ticket.id,
                type: 'status_changed',
                actor: actorOf(admin),
                payload: { from: ticket.status, to: 'open', reason: 'staff_reopened' },
            });
        }
        const updated = Object.keys(data).length ? await tx.ticket.update({ where: { id: ticket.id }, data }) : ticket;
        if (events.length) await tx.ticketEvent.createMany({ data: events });
        return { ticket: updated, user: ticket.user, closed };
    });
    if (result.closed) notifyCustomer(result.ticket, result.user, 'closed');
    return result.ticket;
}
