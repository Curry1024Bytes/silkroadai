import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { costReferenceKey } from './actual-margin';

const amount = z.string().regex(/^-?\d{1,12}(?:\.\d{1,8})?$/);
const rate = z
    .string()
    .regex(/^\d{1,12}(?:\.\d{1,8})?$/)
    .refine((value) => Number(value) > 0);
const entrySchema = z
    .strictObject({
        channel_id: z.number().int().min(1).max(2_147_483_647),
        reference_kind: z.enum(['task', 'upstream', 'request']),
        reference_id: z
            .string()
            .trim()
            .min(1)
            .max(192)
            .regex(/^[A-Za-z0-9_.:/-]+$/),
        amount,
        currency: z.string().regex(/^[A-Z][A-Z0-9_]{1,11}$/),
        cny_per_unit: rate,
        status: z.enum(['verified', 'estimated']),
        evidence: z.string().trim().min(1).max(240),
    })
    .refine((row) => row.currency !== 'CNY' || Number(row.cny_per_unit) === 1);
export const marginImportSchema = z.strictObject({ entries: z.array(entrySchema).min(1).max(1_000) });
type Entry = z.infer<typeof entrySchema>;

export class MarginImportConflict extends Error {}

const fields = (row: Entry) => ({
    amount: row.amount,
    currency: row.currency,
    cny_per_unit: row.cny_per_unit,
    status: row.status,
    evidence: row.evidence,
});
const identity = (row: Entry) => ({
    channel_id: row.channel_id,
    reference_kind: row.reference_kind,
    reference_id: row.reference_id,
});

export async function importMarginCosts(tx: Prisma.TransactionClient, entries: Entry[], actorId: string | null) {
    const keys = new Set(entries.map((row) => costReferenceKey(row.channel_id, row.reference_kind, row.reference_id)));
    if (keys.size !== entries.length) throw new MarginImportConflict('duplicate_in_batch');
    const ordered = [...entries].sort((a, b) =>
        costReferenceKey(a.channel_id, a.reference_kind, a.reference_id).localeCompare(
            costReferenceKey(b.channel_id, b.reference_kind, b.reference_id),
        ),
    );
    const inserted = await tx.upstreamMarginCost.createMany({
        data: ordered.map((row) => ({ ...row, imported_by: actorId })),
        skipDuplicates: true,
    });
    const rows = await tx.upstreamMarginCost.findMany({ where: { OR: ordered.map(identity) } });
    const byKey = new Map(
        rows.map((row) => [costReferenceKey(row.channel_id, row.reference_kind, row.reference_id), row]),
    );
    let promoted = 0;
    for (const row of ordered) {
        const existing = byKey.get(costReferenceKey(row.channel_id, row.reference_kind, row.reference_id));
        if (!existing) throw new MarginImportConflict('conflicting_cost');
        if (
            existing.amount.equals(row.amount) &&
            existing.currency === row.currency &&
            existing.cny_per_unit.equals(row.cny_per_unit) &&
            existing.status === row.status &&
            existing.evidence === row.evidence
        )
            continue;
        if (existing.status === 'estimated' && row.status === 'verified') {
            const change = await tx.upstreamMarginCost.updateMany({
                where: { id: existing.id, status: 'estimated' },
                data: { ...fields(row), imported_by: actorId },
            });
            if (change.count === 1) {
                promoted++;
                continue;
            }
        }
        throw new MarginImportConflict('conflicting_cost');
    }
    return { inserted: inserted.count, promoted, duplicates: ordered.length - inserted.count - promoted };
}
