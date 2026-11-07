import { NextResponse } from 'next/server';
import { AdminTicketError } from './admin-service';
import { TicketError } from './service';

export function adminTicketErrorResponse(e: unknown): NextResponse | null {
    if (e instanceof TicketError || e instanceof AdminTicketError) {
        return NextResponse.json({ error: e.code }, { status: e.status });
    }
    return null;
}
