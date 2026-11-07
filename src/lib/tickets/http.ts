/** 工单 API 公共小件:错误映射 + 参数校验(route handler 复用)。 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { TicketError } from './service';

export const UuidSchema = z.string().uuid();

export function ticketErrorResponse(e: unknown): NextResponse | null {
    if (e instanceof TicketError) return NextResponse.json({ error: e.code }, { status: e.status });
    return null;
}

/** 邮件里的绝对链接:生产 NEXT_PUBLIC_APP_URL,缺省主站。 */
export function appUrl(): string {
    return (process.env.NEXT_PUBLIC_APP_URL || 'https://silkroadai.io').replace(/\/$/, '');
}

export async function readJson(req: Request): Promise<unknown | undefined> {
    try {
        return await req.json();
    } catch {
        return undefined;
    }
}
