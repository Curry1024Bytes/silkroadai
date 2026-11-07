/**
 * 工单自动流转(PR3)。每小时一轮,镜像 balance-alert 的 CAS 写法(多实例不双发):
 *   waiting_customer 且客服最后回复 ≥ 7 天无客户回应 → resolved(auto_resolved,发「请确认」邮件)
 *   resolved 且 resolved_at ≥ 7 天无客户动作           → closed(auto_closed,发「已关闭」邮件)
 * 每张工单 updateMany 带状态 + 时间谓词当 claim;count=0 = 别的实例已处理,跳过。
 */
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { sendTicketUpdatedEmail } from '@/lib/email/send';
import { appUrl } from '@/lib/tickets/http';
import { userLocale } from '@/lib/tickets/service';
import { AUTO_ADVANCE_AFTER_DAYS, formatTicketNumber } from '@/lib/tickets/status';

const INTERVAL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 200;
let timer: ReturnType<typeof setInterval> | null = null;

export interface AutoAdvanceResult {
    autoResolved: number;
    autoClosed: number;
    raceLost: number;
    errors: number;
}

export async function scanAndAdvance(now: Date = new Date()): Promise<AutoAdvanceResult> {
    const cutoff = new Date(now.getTime() - AUTO_ADVANCE_AFTER_DAYS * 24 * 60 * 60 * 1000);
    const result: AutoAdvanceResult = { autoResolved: 0, autoClosed: 0, raceLost: 0, errors: 0 };

    const stale = await prisma.ticket.findMany({
        where: {
            OR: [
                { status: 'waiting_customer', last_staff_msg_at: { lt: cutoff } },
                { status: 'resolved', resolved_at: { lt: cutoff } },
            ],
        },
        take: BATCH_SIZE,
        orderBy: { updated_at: 'asc' },
        select: {
            id: true,
            number: true,
            subject: true,
            status: true,
            user: { select: { email: true, locale: true } },
        },
    });

    for (const t of stale) {
        try {
            const toResolved = t.status === 'waiting_customer';
            const claim = await prisma.ticket.updateMany({
                where: toResolved
                    ? { id: t.id, status: 'waiting_customer', last_staff_msg_at: { lt: cutoff } }
                    : { id: t.id, status: 'resolved', resolved_at: { lt: cutoff } },
                data: toResolved ? { status: 'resolved', resolved_at: now } : { status: 'closed', closed_at: now },
            });
            if (claim.count === 0) {
                result.raceLost++;
                continue;
            }
            await prisma.ticketEvent.create({
                data: {
                    ticket_id: t.id,
                    type: 'status_changed',
                    actor: 'system',
                    payload: toResolved
                        ? { from: 'waiting_customer', to: 'resolved', reason: 'auto_resolved' }
                        : { from: 'resolved', to: 'closed', reason: 'auto_closed' },
                },
            });
            if (toResolved) result.autoResolved++;
            else result.autoClosed++;
            await sendTicketUpdatedEmail({
                to: t.user.email,
                locale: userLocale(t.user),
                number: formatTicketNumber(t.number),
                subject: t.subject,
                ticketUrl: `${appUrl()}/support/${t.id}`,
                kind: toResolved ? 'resolved' : 'closed',
            }).catch((e) => console.warn(`[ticket-auto-advance] email failed for ${t.id}:`, e));
        } catch (err) {
            result.errors++;
            console.error(`[ticket-auto-advance] ticket ${t.id} failed:`, err);
            Sentry.captureException(err, { tags: { area: 'ticket-auto-advance', ticket_id: t.id } });
        }
    }

    if (result.autoResolved || result.autoClosed || result.errors) {
        console.log(
            `[ticket-auto-advance] resolved=${result.autoResolved} closed=${result.autoClosed} raceLost=${result.raceLost} errors=${result.errors}`,
        );
    }
    return result;
}

export function startTicketAutoAdvanceScheduler(): void {
    if (timer) return;
    const tick = () =>
        scanAndAdvance().catch((err) => {
            console.error('[ticket-auto-advance] scan failed:', err);
            Sentry.captureException(err, { tags: { area: 'ticket-auto-advance-scheduler' } });
        });
    // 首轮延后 2 分钟,避开启动风暴(ratio-reconcile 同款)。
    setTimeout(tick, 2 * 60 * 1000);
    timer = setInterval(tick, INTERVAL_MS);
    console.log('Ticket auto-advance scheduler started');
}

export function stopTicketAutoAdvanceScheduler(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
