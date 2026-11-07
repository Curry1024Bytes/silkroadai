'use client';

import { useState } from 'react';
import type { TicketStatus } from '@prisma/client';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { FormError } from '@/components/ui/FormError';
import { Label } from '@/components/ui/Label';
import { useMessages } from '@/lib/i18n/client';
import { ticketsMessages } from '@/lib/i18n/messages/tickets';
import { AttachmentPicker, type PickedAttachment } from '../attachment-picker';

const TEXTAREA_CLASSES =
    'w-full min-h-[100px] px-3.5 py-2.5 text-[15px] text-ink rounded-lg border border-brand-border bg-surface ' +
    'placeholder:text-minor-ink outline-none transition-shadow duration-150 ease-brand ' +
    'hover:border-muted-ink/40 focus:border-navy focus:shadow-focus disabled:opacity-50';

/**
 * 客户动作区:open / waiting_customer → 回复;resolved → 确认已解决 或 仍未解决(带说明重开);
 * closed → 提示。成功后整页 reload,线程由 server 重新渲染(无客户端状态要保留)。
 */
export function TicketActions({ ticketId, status }: { ticketId: string; status: TicketStatus }) {
    const m = useMessages(ticketsMessages).detail;
    const [body, setBody] = useState('');
    const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
    const [reopenMode, setReopenMode] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function errorText(code: string, httpStatus: number): string {
        const map = m.errors as Record<string, string | ((n: number) => string)>;
        const v = map[code];
        return typeof v === 'string' ? v : m.errors.generic(httpStatus);
    }

    async function post(path: string, payload?: unknown) {
        setBusy(true);
        setError(null);
        try {
            const r = await fetch(`/api/portal/tickets/${ticketId}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: payload === undefined ? undefined : JSON.stringify(payload),
            });
            if (!r.ok) {
                const data = (await r.json().catch(() => ({}))) as { error?: string };
                setError(errorText(data.error ?? '', r.status));
                setBusy(false);
                return;
            }
            window.location.reload();
        } catch {
            setError(m.errors.generic(0));
            setBusy(false);
        }
    }

    if (status === 'closed') {
        return (
            <p className="m-0 rounded-lg border border-brand-border bg-paper-muted px-4 py-3 text-sm text-muted-ink">
                {m.closedNotice}
            </p>
        );
    }

    if (status === 'resolved' && !reopenMode) {
        return (
            <Card as="section" data-testid="ticket-resolved-actions">
                <CardContent>
                    <p className="m-0 mb-3 text-sm text-ink">{m.resolvedNotice}</p>
                    {error ? <FormError severity="banner">{error}</FormError> : null}
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant="primary"
                            size="md"
                            loading={busy}
                            onClick={() => post('/confirm')}
                        >
                            {m.confirm}
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            size="md"
                            disabled={busy}
                            onClick={() => setReopenMode(true)}
                        >
                            {m.reopen}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        );
    }

    const isReopen = status === 'resolved' && reopenMode;
    const canSend = body.trim().length > 0 && !busy;

    return (
        <Card as="section" data-testid="ticket-reply">
            <CardContent>
                {status === 'waiting_customer' ? (
                    <p className="m-0 mb-3 text-sm text-status-warning-text">{m.waitingNotice}</p>
                ) : null}
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (!canSend) return;
                        void post(isReopen ? '/reopen' : '/messages', {
                            body: body.trim(),
                            attachments: attachments.map(({ key, name, size, type }) => ({ key, name, size, type })),
                        });
                    }}
                >
                    <Label htmlFor="ticket-reply-body">{m.reply.label}</Label>
                    <textarea
                        id="ticket-reply-body"
                        value={body}
                        maxLength={5000}
                        onChange={(e) => setBody(e.target.value)}
                        placeholder={isReopen ? m.reopenPlaceholder : m.reply.placeholder}
                        className={TEXTAREA_CLASSES}
                    />
                    <div className="mt-3">
                        <AttachmentPicker value={attachments} onChange={setAttachments} disabled={busy} />
                    </div>
                    {error ? (
                        <div className="mt-2">
                            <FormError severity="banner">{error}</FormError>
                        </div>
                    ) : null}
                    <div className="mt-3 flex items-center gap-2">
                        <Button type="submit" variant="primary" size="md" loading={busy} disabled={!canSend}>
                            {busy ? m.reply.submitting : isReopen ? m.reopenSubmit : m.reply.submit}
                        </Button>
                        {isReopen ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="md"
                                disabled={busy}
                                onClick={() => setReopenMode(false)}
                            >
                                {m.confirm}
                            </Button>
                        ) : null}
                    </div>
                </form>
            </CardContent>
        </Card>
    );
}
