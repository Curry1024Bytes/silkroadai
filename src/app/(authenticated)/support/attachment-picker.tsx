'use client';

/** 工单附件选择器:选图即上传到 /api/portal/tickets/attachments,拿 key 交给父表单随消息提交。 */
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useMessages } from '@/lib/i18n/client';
import { ticketsMessages } from '@/lib/i18n/messages/tickets';
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, type AttachmentMeta } from '@/lib/tickets/attachments';

export type PickedAttachment = AttachmentMeta & { url: string };

export function AttachmentPicker({
    value,
    onChange,
    disabled,
}: {
    value: PickedAttachment[];
    onChange: (next: PickedAttachment[]) => void;
    disabled?: boolean;
}) {
    const m = useMessages(ticketsMessages).detail.attachments;
    const inputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function errorText(code: string, status: number): string {
        const map = m.errors as Record<string, string | ((n: number) => string)>;
        const v = map[code];
        return typeof v === 'string' ? v : m.errors.generic(status);
    }

    async function handleFiles(files: FileList | null) {
        if (!files || files.length === 0) return;
        setError(null);
        const room = MAX_ATTACHMENTS_PER_MESSAGE - value.length;
        if (room <= 0) return setError(m.tooMany);
        const picked = Array.from(files).slice(0, room);
        setUploading(true);
        const next = [...value];
        try {
            for (const file of picked) {
                if (file.size > MAX_ATTACHMENT_BYTES) {
                    setError(m.errors.file_too_large);
                    continue;
                }
                const fd = new FormData();
                fd.append('file', file);
                const r = await fetch('/api/portal/tickets/attachments', {
                    method: 'POST',
                    credentials: 'same-origin',
                    body: fd,
                });
                const data = (await r.json().catch(() => ({}))) as Partial<PickedAttachment> & { error?: string };
                if (!r.ok || !data.key) {
                    setError(errorText(data.error ?? '', r.status));
                    continue;
                }
                next.push({
                    key: data.key,
                    url: data.url ?? '',
                    name: data.name ?? file.name,
                    size: data.size ?? file.size,
                    type: data.type as PickedAttachment['type'],
                });
            }
            onChange(next);
        } finally {
            setUploading(false);
            if (inputRef.current) inputRef.current.value = '';
        }
    }

    return (
        <div data-testid="attachment-picker">
            <p className="m-0 mb-1.5 text-sm font-medium text-muted-ink">{m.label}</p>
            <div className="flex flex-wrap items-center gap-2">
                {value.map((a) => (
                    <span
                        key={a.key}
                        className="inline-flex items-center gap-1 rounded border border-brand-border bg-surface px-2 py-1 text-xs"
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {a.url ? <img src={a.url} alt={a.name} className="h-8 w-8 rounded object-cover" /> : null}
                        <span className="max-w-[120px] truncate" title={a.name}>
                            {a.name}
                        </span>
                        <button
                            type="button"
                            className="ml-1 cursor-pointer border-0 bg-transparent text-minor-ink hover:text-status-error-text"
                            aria-label={m.remove}
                            onClick={() => onChange(value.filter((v) => v.key !== a.key))}
                            disabled={disabled}
                        >
                            ✕
                        </button>
                    </span>
                ))}
                {value.length < MAX_ATTACHMENTS_PER_MESSAGE ? (
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        loading={uploading}
                        disabled={disabled}
                        onClick={() => inputRef.current?.click()}
                    >
                        {uploading ? m.uploading : m.add}
                    </Button>
                ) : null}
                <input
                    ref={inputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    multiple
                    hidden
                    onChange={(e) => void handleFiles(e.target.files)}
                />
            </div>
            {error ? <p className="m-0 mt-1 text-xs text-status-error-text">{error}</p> : null}
        </div>
    );
}
