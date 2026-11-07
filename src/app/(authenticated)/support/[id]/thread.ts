/** 把消息 + 事件合成一条按时间排序的线程(server 侧,纯函数;事件文案按 locale 渲染)。 */
import type { Prisma, TicketAuthor } from '@prisma/client';
import type { TicketWithThread } from '@/lib/tickets/service';
import type { TicketsMessages } from '@/lib/i18n/messages/tickets';
import { formatDateTime } from '../session';

export type ThreadItem =
    | { kind: 'message'; id: string; author: TicketAuthor; body: string; time: string; at: number }
    | { kind: 'event'; id: string; type: string; text: string; time: string; at: number };

function str(v: Prisma.JsonValue | undefined, key: string): string | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const x = (v as Record<string, Prisma.JsonValue>)[key];
    return typeof x === 'string' || typeof x === 'number' ? String(x) : null;
}

export function eventText(
    type: string,
    payload: Prisma.JsonValue | null,
    m: TicketsMessages,
    intl: string,
): string | null {
    const p = payload ?? undefined;
    switch (type) {
        case 'created':
            return m.detail.events.created;
        case 'request_located': {
            const model = str(p, 'model') ?? '?';
            const at = Number(str(p, 'created_at') ?? 0);
            const time = at ? formatDateTime(at * 1000, intl) : '';
            const failed = str(p, 'failed') === 'true';
            const cost = Number(str(p, 'cost_cny') ?? 0).toFixed(4);
            return failed ? m.detail.events.locatedFailed(model, time) : m.detail.events.located(model, cost, time);
        }
        case 'status_changed': {
            const to = str(p, 'to');
            if (str(p, 'reason') === 'auto_closed') return m.detail.events.autoClosed;
            return to && to in m.status ? m.detail.events.statusChanged(m.status[to as keyof typeof m.status]) : null;
        }
        case 'credited':
            return m.detail.events.credited(Number(str(p, 'amount_cny') ?? 0).toFixed(2));
        case 'auto_closed':
            return m.detail.events.autoClosed;
        default:
            return null; // 内部事件(assigned 等)客户不看
    }
}

export function buildThread(ticket: TicketWithThread, m: TicketsMessages, intl: string): ThreadItem[] {
    const items: ThreadItem[] = [];
    for (const msg of ticket.messages) {
        items.push({
            kind: 'message',
            id: msg.id,
            author: msg.author_type,
            body: msg.body,
            time: formatDateTime(msg.created_at, intl),
            at: msg.created_at.getTime(),
        });
    }
    for (const ev of ticket.events) {
        const text = eventText(ev.type, ev.payload, m, intl);
        if (!text) continue;
        items.push({
            kind: 'event',
            id: ev.id,
            type: ev.type,
            text,
            time: formatDateTime(ev.created_at, intl),
            at: ev.created_at.getTime(),
        });
    }
    // 同一毫秒内事件排在消息后面(created 事件跟在首条消息之后更自然)
    return items.sort((a, b) => a.at - b.at || (a.kind === 'event' ? 1 : 0) - (b.kind === 'event' ? 1 : 0));
}
