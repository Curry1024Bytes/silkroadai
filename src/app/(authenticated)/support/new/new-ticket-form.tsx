'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { TicketCategory } from '@prisma/client';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { useMessages } from '@/lib/i18n/client';
import { ticketsMessages } from '@/lib/i18n/messages/tickets';
import { REQUEST_ID_PATTERN, requiresRequestId, TICKET_CATEGORIES } from '@/lib/tickets/status';
import { AttachmentPicker, type PickedAttachment } from '../attachment-picker';

export interface OrderOption {
    id: string;
    label: string;
}

const TEXTAREA_CLASSES =
    'w-full min-h-[140px] px-3.5 py-2.5 text-[15px] text-ink rounded-lg border border-brand-border bg-surface ' +
    'placeholder:text-minor-ink outline-none transition-shadow duration-150 ease-brand ' +
    'hover:border-muted-ink/40 focus:border-navy focus:shadow-focus disabled:opacity-50';

type ErrorKey = keyof (typeof ticketsMessages)['zh']['form']['errors'];

export function NewTicketForm({ orders }: { orders: OrderOption[] }) {
    const m = useMessages(ticketsMessages);
    const [category, setCategory] = useState<TicketCategory>('billing');
    const [subject, setSubject] = useState('');
    const [body, setBody] = useState('');
    const [requestId, setRequestId] = useState('');
    const [orderId, setOrderId] = useState('');
    const [disputed, setDisputed] = useState('');
    const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const needRequestId = requiresRequestId(category);
    const requestIdOk = requestId.trim() === '' ? !needRequestId : REQUEST_ID_PATTERN.test(requestId.trim());
    const canSubmit = subject.trim().length >= 2 && body.trim().length >= 10 && requestIdOk && !submitting;

    function errorText(code: string, status: number): string {
        const map = m.form.errors as Record<string, string | ((n: number) => string)>;
        const v = map[code as ErrorKey];
        if (typeof v === 'string') return v;
        return m.form.errors.generic(status);
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        setError(null);
        try {
            const r = await fetch('/api/portal/tickets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    category,
                    subject: subject.trim(),
                    body: body.trim(),
                    request_id: requestId.trim() || undefined,
                    order_id: category === 'recharge' && orderId ? orderId : undefined,
                    disputed_cny: category === 'billing' && disputed.trim() !== '' ? Number(disputed) : undefined,
                    attachments: attachments.map(({ key, name, size, type }) => ({ key, name, size, type })),
                }),
            });
            const data = (await r.json().catch(() => ({}))) as { error?: string; ticket?: { id: string } };
            if (!r.ok || !data.ticket) {
                setError(errorText(data.error ?? '', r.status));
                setSubmitting(false);
                return;
            }
            window.location.assign(`/support/${data.ticket.id}`);
        } catch {
            setError(m.form.errors.generic(0));
            setSubmitting(false);
        }
    }

    return (
        <Card as="section">
            <CardContent>
                <form onSubmit={handleSubmit} className="flex flex-col gap-5" data-testid="new-ticket-form">
                    <fieldset className="m-0 border-0 p-0">
                        <legend className="mb-1.5 text-sm font-medium text-muted-ink">{m.form.category}</legend>
                        <div className="grid gap-2 sm:grid-cols-2">
                            {TICKET_CATEGORIES.map((c) => (
                                <label
                                    key={c}
                                    className={[
                                        'flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors duration-150 ease-brand',
                                        category === c
                                            ? 'border-navy bg-paper-muted'
                                            : 'border-brand-border hover:border-muted-ink/40',
                                    ].join(' ')}
                                >
                                    <input
                                        type="radio"
                                        name="category"
                                        value={c}
                                        checked={category === c}
                                        onChange={() => setCategory(c)}
                                        className="mt-1"
                                    />
                                    <span>
                                        <span className="block font-medium text-navy">{m.category[c]}</span>
                                        <span className="block text-xs text-muted-ink">{m.categoryHint[c]}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>

                    <div>
                        <Label htmlFor="ticket-subject" required>
                            {m.form.subject}
                        </Label>
                        <Input
                            id="ticket-subject"
                            value={subject}
                            maxLength={120}
                            onChange={(e) => setSubject(e.target.value)}
                            placeholder={m.form.subjectPlaceholder}
                        />
                    </div>

                    <div>
                        <Label htmlFor="ticket-request-id" required={needRequestId}>
                            {m.form.requestId}
                        </Label>
                        <Input
                            id="ticket-request-id"
                            value={requestId}
                            maxLength={80}
                            onChange={(e) => setRequestId(e.target.value)}
                            placeholder={m.form.requestIdPlaceholder}
                            error={requestId.trim() !== '' && !REQUEST_ID_PATTERN.test(requestId.trim())}
                            className="font-mono text-sm"
                        />
                        <p className="m-0 mt-1.5 text-xs text-muted-ink">
                            {m.form.requestIdHint1}{' '}
                            <Link href="/logs" className="text-navy underline decoration-dotted">
                                {m.form.requestIdHintLink}
                            </Link>{' '}
                            {m.form.requestIdHint2}
                            {needRequestId ? (
                                <span className="ml-1 text-status-warning-text">{m.form.requestIdRequired}</span>
                            ) : null}
                        </p>
                    </div>

                    {category === 'recharge' && orders.length > 0 ? (
                        <div>
                            <Label htmlFor="ticket-order">{m.form.order}</Label>
                            <select
                                id="ticket-order"
                                value={orderId}
                                onChange={(e) => setOrderId(e.target.value)}
                                className="h-10 w-full rounded-lg border border-brand-border bg-surface px-3 text-sm text-ink"
                            >
                                <option value="">{m.form.orderNone}</option>
                                {orders.map((o) => (
                                    <option key={o.id} value={o.id}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    ) : null}

                    {category === 'billing' ? (
                        <div>
                            <Label htmlFor="ticket-disputed">{m.form.disputed}</Label>
                            <Input
                                id="ticket-disputed"
                                type="number"
                                min={0}
                                step="0.01"
                                value={disputed}
                                onChange={(e) => setDisputed(e.target.value)}
                                block={false}
                                className="w-40 tabular-nums"
                            />
                            <p className="m-0 mt-1.5 text-xs text-muted-ink">{m.form.disputedHint}</p>
                        </div>
                    ) : null}

                    <div>
                        <Label htmlFor="ticket-body" required>
                            {m.form.body}
                        </Label>
                        <textarea
                            id="ticket-body"
                            value={body}
                            maxLength={5000}
                            onChange={(e) => setBody(e.target.value)}
                            placeholder={m.form.bodyPlaceholder}
                            className={TEXTAREA_CLASSES}
                        />
                    </div>

                    <AttachmentPicker value={attachments} onChange={setAttachments} disabled={submitting} />

                    {error ? <FormError severity="banner">{error}</FormError> : null}

                    <div className="flex items-center gap-3">
                        <Button type="submit" variant="primary" size="md" loading={submitting} disabled={!canSubmit}>
                            {submitting ? m.form.submitting : m.form.submit}
                        </Button>
                        <Button href="/support" variant="ghost" size="md">
                            {m.form.cancel}
                        </Button>
                    </div>
                </form>
            </CardContent>
        </Card>
    );
}
