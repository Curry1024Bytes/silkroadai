/**
 * 客诉工单 — 客户侧业务逻辑(PR1)。管理员侧(回复 / 处置 / 补额)在 PR2。
 *
 * 所有 mutation 走 `prisma.$transaction`;名额 / 频率限制在事务内 count,
 * 多实例下仍可能极小概率超一单,这里不是安全边界,可接受。
 */
import {
    Prisma,
    type Ticket,
    type TicketCategory,
    type TicketEvent,
    type TicketMessage,
    type User,
} from '@prisma/client';
import { prisma } from '@/lib/db';
import type { Locale } from '@/lib/i18n';
import { sendTicketCreatedEmail } from '@/lib/email/send';
import { locateRequest, type LocatedRequest } from './lookup';
import { attachmentsOwnedBy, parseAttachments, type AttachmentMeta } from './attachments';
import { getPublicUrl } from '@/lib/r2/client';
import {
    canTransition,
    ACTIVE_STATUSES,
    CREATE_RATE_LIMIT,
    formatTicketNumber,
    MAX_OPEN_TICKETS_PER_USER,
    MAX_REOPENS,
    requiresRequestId,
} from './status';

export type TicketErrorCode =
    | 'attachment_not_owned'
    | 'request_id_required'
    | 'order_not_found'
    | 'too_many_open_tickets'
    | 'rate_limited'
    | 'not_found'
    | 'invalid_state'
    | 'reopen_limit';

export class TicketError extends Error {
    constructor(
        public readonly code: TicketErrorCode,
        public readonly status: number,
    ) {
        super(code);
        this.name = 'TicketError';
    }
}

export interface CreateTicketInput {
    category: TicketCategory;
    subject: string;
    body: string;
    requestId?: string;
    orderId?: string;
    disputedCny?: number;
    attachments?: AttachmentMeta[];
}

export type TicketListFilter = 'active' | 'resolved' | 'all';

/** 客户侧列表行(server component 直接用,Decimal 已转 number)。 */
export interface TicketSummary {
    id: string;
    number: string;
    subject: string;
    category: TicketCategory;
    status: Ticket['status'];
    createdAt: Date;
    updatedAt: Date;
}

export type TicketWithThread = Ticket & { messages: TicketMessage[]; events: TicketEvent[] };

function localeTag(locale: Locale): string {
    return locale === 'en' ? 'en' : 'zh-CN';
}

export function userLocale(user: Pick<User, 'locale'>): Locale {
    return user.locale?.toLowerCase().startsWith('en') ? 'en' : 'zh';
}

function actorOf(user: Pick<User, 'id'>): string {
    return `customer:${user.id}`;
}

export async function createTicket(
    user: User,
    input: CreateTicketInput,
    opts: { locale: Locale; appUrl: string },
): Promise<Ticket> {
    if (requiresRequestId(input.category) && !input.requestId) {
        throw new TicketError('request_id_required', 400);
    }
    if (!attachmentsOwnedBy(user.id, input.attachments)) throw new TicketError('attachment_not_owned', 400);
    if (input.orderId) {
        const order = await prisma.order.findFirst({
            where: { id: input.orderId, user_id: user.id },
            select: { id: true },
        });
        if (!order) throw new TicketError('order_not_found', 400);
    }

    const ticket = await prisma.$transaction(async (tx) => {
        const [openCount, recentCount] = await Promise.all([
            tx.ticket.count({ where: { user_id: user.id, status: { in: [...ACTIVE_STATUSES] } } }),
            tx.ticket.count({
                where: { user_id: user.id, created_at: { gte: new Date(Date.now() - CREATE_RATE_LIMIT.windowMs) } },
            }),
        ]);
        if (openCount >= MAX_OPEN_TICKETS_PER_USER) throw new TicketError('too_many_open_tickets', 429);
        if (recentCount >= CREATE_RATE_LIMIT.max) throw new TicketError('rate_limited', 429);

        const now = new Date();
        const created = await tx.ticket.create({
            data: {
                user_id: user.id,
                tenant_id: user.tenant_id,
                category: input.category,
                subject: input.subject,
                request_id: input.requestId ?? null,
                order_id: input.orderId ?? null,
                disputed_cny: input.disputedCny != null ? new Prisma.Decimal(input.disputedCny) : null,
                last_customer_msg_at: now,
                messages: {
                    create: {
                        author_type: 'customer',
                        author_id: user.id,
                        body: input.body,
                        attachments: input.attachments?.length ? input.attachments : undefined,
                    },
                },
                events: {
                    create: { type: 'created', actor: actorOf(user), payload: { category: input.category } },
                },
            },
        });
        // 记住客户当前站点语言,后续邮件(客服回复 / 状态变更)按它发。
        if (user.locale !== localeTag(opts.locale)) {
            await tx.user.update({ where: { id: user.id }, data: { locale: localeTag(opts.locale) } });
        }
        return created;
    });

    // ── 提交后的 best-effort 动作:定位调用 + 邮件。失败只记日志,不影响已创建的工单。
    let located: LocatedRequest | null = null;
    if (input.requestId) {
        located = await locateRequest(user, input.requestId);
        if (located) {
            try {
                await attachLocatedRequest(ticket.id, user, located, input.disputedCny == null);
            } catch (e) {
                console.warn(`[tickets] attachLocatedRequest failed for ${ticket.id}:`, e);
            }
        }
    }

    void sendTicketCreatedEmail({
        to: user.email,
        locale: opts.locale,
        number: formatTicketNumber(ticket.number),
        subject: ticket.subject,
        ticketUrl: `${opts.appUrl}/support/${ticket.id}`,
    }).catch((e) => console.warn(`[tickets] created email failed for ${ticket.id}:`, e));

    return ticket;
}

/** 命中日志后回填 model / token / 争议金额,并留 request_located 事件(线程里按 locale 渲染)。 */
export async function attachLocatedRequest(
    ticketId: string,
    user: Pick<User, 'id'>,
    located: LocatedRequest,
    fillDisputed: boolean,
): Promise<void> {
    const token = await prisma.newApiToken.findFirst({
        where: { user_id: user.id, newapi_token_id: located.newapiTokenId },
        select: { id: true },
    });
    await prisma.$transaction([
        prisma.ticket.update({
            where: { id: ticketId },
            data: {
                model: located.model.slice(0, 200),
                token_id: token?.id ?? null,
                ...(fillDisputed && !located.failed
                    ? { disputed_cny: new Prisma.Decimal(located.costCny.toFixed(4)) }
                    : {}),
            },
        }),
        prisma.ticketEvent.create({
            data: {
                ticket_id: ticketId,
                type: 'request_located',
                actor: 'system',
                payload: {
                    request_id: located.requestId,
                    model: located.model,
                    cost_cny: Number(located.costCny.toFixed(4)),
                    created_at: located.createdAt,
                    failed: located.failed,
                },
            },
        }),
    ]);
}

export async function listTicketsForUser(userId: string, filter: TicketListFilter): Promise<TicketSummary[]> {
    const where: Prisma.TicketWhereInput = { user_id: userId };
    if (filter === 'active') where.status = { in: ['open', 'waiting_customer'] };
    else if (filter === 'resolved') where.status = { in: ['resolved', 'closed'] };
    const rows = await prisma.ticket.findMany({
        where,
        orderBy: { updated_at: 'desc' },
        take: 100,
        select: {
            id: true,
            number: true,
            subject: true,
            category: true,
            status: true,
            created_at: true,
            updated_at: true,
        },
    });
    return rows.map((r) => ({
        id: r.id,
        number: formatTicketNumber(r.number),
        subject: r.subject,
        category: r.category,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    }));
}

/** 客户看自己的工单:IDOR 用 user_id 一起查,不存在和不是自己的都 404;内部备注过滤。 */
export async function getTicketForUser(ticketId: string, userId: string): Promise<TicketWithThread | null> {
    return prisma.ticket.findFirst({
        where: { id: ticketId, user_id: userId },
        include: {
            messages: { where: { internal: false }, orderBy: { created_at: 'asc' } },
            events: { orderBy: { created_at: 'asc' } },
        },
    });
}

async function requireOwnTicket(tx: Prisma.TransactionClient, ticketId: string, userId: string): Promise<Ticket> {
    const ticket = await tx.ticket.findFirst({ where: { id: ticketId, user_id: userId } });
    if (!ticket) throw new TicketError('not_found', 404);
    return ticket;
}

/** 客户追加留言:waiting_customer → open;resolved 状态下留言等同「未解决」走 reopen。 */
export async function addCustomerMessage(
    ticketId: string,
    user: User,
    body: string,
    attachments?: AttachmentMeta[],
): Promise<TicketMessage> {
    if (!attachmentsOwnedBy(user.id, attachments)) throw new TicketError('attachment_not_owned', 400);
    return prisma.$transaction(async (tx) => {
        const ticket = await requireOwnTicket(tx, ticketId, user.id);
        if (ticket.status === 'closed') throw new TicketError('invalid_state', 409);
        if (ticket.status === 'resolved') throw new TicketError('invalid_state', 409);
        const now = new Date();
        const message = await tx.ticketMessage.create({
            data: {
                ticket_id: ticket.id,
                author_type: 'customer',
                author_id: user.id,
                body,
                attachments: attachments?.length ? attachments : undefined,
            },
        });
        const nextStatus = ticket.status === 'waiting_customer' ? 'open' : ticket.status;
        await tx.ticket.update({
            where: { id: ticket.id },
            data: { status: nextStatus, last_customer_msg_at: now },
        });
        if (nextStatus !== ticket.status) {
            await tx.ticketEvent.create({
                data: {
                    ticket_id: ticket.id,
                    type: 'status_changed',
                    actor: actorOf(user),
                    payload: { from: ticket.status, to: nextStatus },
                },
            });
        }
        return message;
    });
}

/** 客户确认「已解决」→ closed。 */
export async function confirmResolved(ticketId: string, user: User): Promise<Ticket> {
    return prisma.$transaction(async (tx) => {
        const ticket = await requireOwnTicket(tx, ticketId, user.id);
        if (!canTransition('customer', ticket.status, 'closed')) throw new TicketError('invalid_state', 409);
        const updated = await tx.ticket.update({
            where: { id: ticket.id },
            data: { status: 'closed', closed_at: new Date() },
        });
        await tx.ticketEvent.create({
            data: {
                ticket_id: ticket.id,
                type: 'status_changed',
                actor: actorOf(user),
                payload: { from: ticket.status, to: 'closed', reason: 'customer_confirmed' },
            },
        });
        return updated;
    });
}

/** 客户「仍未解决」→ open,附带说明;超过 MAX_REOPENS 次拒绝(只能客服关)。 */
export async function reopenTicket(
    ticketId: string,
    user: User,
    body: string,
    attachments?: AttachmentMeta[],
): Promise<Ticket> {
    if (!attachmentsOwnedBy(user.id, attachments)) throw new TicketError('attachment_not_owned', 400);
    return prisma.$transaction(async (tx) => {
        const ticket = await requireOwnTicket(tx, ticketId, user.id);
        if (!canTransition('customer', ticket.status, 'open')) throw new TicketError('invalid_state', 409);
        if (ticket.reopen_count >= MAX_REOPENS) throw new TicketError('reopen_limit', 409);
        const now = new Date();
        await tx.ticketMessage.create({
            data: {
                ticket_id: ticket.id,
                author_type: 'customer',
                author_id: user.id,
                body,
                attachments: attachments?.length ? attachments : undefined,
            },
        });
        const updated = await tx.ticket.update({
            where: { id: ticket.id },
            data: { status: 'open', reopen_count: { increment: 1 }, resolved_at: null, last_customer_msg_at: now },
        });
        await tx.ticketEvent.create({
            data: {
                ticket_id: ticket.id,
                type: 'status_changed',
                actor: actorOf(user),
                payload: { from: ticket.status, to: 'open', reason: 'customer_reopened' },
            },
        });
        return updated;
    });
}

/** API 出参形态:Decimal → number、Date → ISO。 */
export function serializeTicket(t: Ticket) {
    return {
        id: t.id,
        number: formatTicketNumber(t.number),
        category: t.category,
        status: t.status,
        priority: t.priority,
        subject: t.subject,
        request_id: t.request_id,
        order_id: t.order_id,
        model: t.model,
        disputed_cny: t.disputed_cny ? Number(t.disputed_cny) : null,
        resolution: t.resolution,
        credit_cny: t.credit_cny ? Number(t.credit_cny) : null,
        reopen_count: t.reopen_count,
        created_at: t.created_at.toISOString(),
        updated_at: t.updated_at.toISOString(),
        resolved_at: t.resolved_at?.toISOString() ?? null,
        closed_at: t.closed_at?.toISOString() ?? null,
    };
}

export function serializeMessage(m: TicketMessage) {
    return {
        id: m.id,
        author_type: m.author_type,
        body: m.body,
        attachments: attachmentsWithUrl(m.attachments),
        created_at: m.created_at.toISOString(),
    };
}

/** Json 列 → 带公网 URL 的附件列表(R2 env 缺失时 url=null,只显示文件名)。 */
export function attachmentsWithUrl(json: unknown): Array<AttachmentMeta & { url: string | null }> {
    return parseAttachments(json).map((a) => {
        let url: string | null = null;
        try {
            url = getPublicUrl(a.key);
        } catch {
            url = null;
        }
        return { ...a, url };
    });
}

export function serializeEvent(e: TicketEvent) {
    return { id: e.id, type: e.type, payload: e.payload, created_at: e.created_at.toISOString() };
}
