/**
 * 工单 SLA(PR3):阈值存 SystemConfig(group=tickets),缺省首复 4h / 解决 24h。
 * 统计只看「仍在客服手上」的工单:open(未首复 → 首复超时;open/waiting 创建超 N 小时 → 解决超时)。
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { AdminPrincipal } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { getSystemConfigs, setSystemConfigs } from '@/lib/system-config';

export const SLA_KEYS = { firstReply: 'tickets.sla_first_reply_hours', resolve: 'tickets.sla_resolve_hours' } as const;
export const SLA_DEFAULTS = { firstReplyHours: 4, resolveHours: 24 } as const;
export const SLA_LIMITS = { min: 1, max: 720 } as const;

export interface TicketSla {
    firstReplyHours: number;
    resolveHours: number;
}

function parseHours(v: string | undefined, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) && n >= SLA_LIMITS.min && n <= SLA_LIMITS.max ? n : fallback;
}

export async function getTicketSla(): Promise<TicketSla> {
    try {
        const cfg = await getSystemConfigs([SLA_KEYS.firstReply, SLA_KEYS.resolve]);
        return {
            firstReplyHours: parseHours(cfg[SLA_KEYS.firstReply], SLA_DEFAULTS.firstReplyHours),
            resolveHours: parseHours(cfg[SLA_KEYS.resolve], SLA_DEFAULTS.resolveHours),
        };
    } catch {
        return { ...SLA_DEFAULTS };
    }
}

export async function setTicketSla(sla: TicketSla): Promise<void> {
    await setSystemConfigs([
        { key: SLA_KEYS.firstReply, value: String(sla.firstReplyHours), group: 'tickets', label: '工单首复 SLA(小时)' },
        { key: SLA_KEYS.resolve, value: String(sla.resolveHours), group: 'tickets', label: '工单解决 SLA(小时)' },
    ]);
}

export interface TicketSlaStats extends TicketSla {
    open: number;
    waitingCustomer: number;
    /** open 且从未首复、创建已超 firstReplyHours */
    breachedFirstReply: number;
    /** open / waiting_customer 且创建已超 resolveHours */
    breachedResolve: number;
    /** 最老的 open 工单等了多少小时(无则 0) */
    oldestOpenHours: number;
}

export async function getTicketSlaStats(admin: AdminPrincipal, now: Date = new Date()): Promise<TicketSlaStats> {
    const sla = await getTicketSla();
    const scope: Prisma.TicketWhereInput = tenantScope(admin);
    const firstReplyCutoff = new Date(now.getTime() - sla.firstReplyHours * 3_600_000);
    const resolveCutoff = new Date(now.getTime() - sla.resolveHours * 3_600_000);
    const [open, waitingCustomer, breachedFirstReply, breachedResolve, oldest] = await Promise.all([
        prisma.ticket.count({ where: { ...scope, status: 'open' } }),
        prisma.ticket.count({ where: { ...scope, status: 'waiting_customer' } }),
        prisma.ticket.count({
            where: { ...scope, status: 'open', first_reply_at: null, created_at: { lt: firstReplyCutoff } },
        }),
        prisma.ticket.count({
            where: { ...scope, status: { in: ['open', 'waiting_customer'] }, created_at: { lt: resolveCutoff } },
        }),
        prisma.ticket.findFirst({
            where: { ...scope, status: 'open' },
            orderBy: { last_customer_msg_at: 'asc' },
            select: { last_customer_msg_at: true, created_at: true },
        }),
    ]);
    const oldestAt = oldest?.last_customer_msg_at ?? oldest?.created_at ?? null;
    return {
        ...sla,
        open,
        waitingCustomer,
        breachedFirstReply,
        breachedResolve,
        oldestOpenHours: oldestAt ? Math.max(0, (now.getTime() - oldestAt.getTime()) / 3_600_000) : 0,
    };
}
