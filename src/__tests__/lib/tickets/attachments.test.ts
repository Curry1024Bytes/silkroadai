import { describe, expect, it } from 'vitest';
import {
    attachmentKey,
    attachmentsOwnedBy,
    AttachmentListSchema,
    parseAttachments,
    sniffImageMime,
} from '@/lib/tickets/attachments';

const U = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const F = '0b0b0b0b-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('attachments', () => {
    it('sniffs png / jpeg / gif / webp by magic bytes, rejects others', () => {
        expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
        expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
        expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
        expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe(
            'image/webp',
        );
        expect(sniffImageMime(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
        expect(sniffImageMime(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    });
    it('key is scoped under the user id', () => {
        expect(attachmentKey(U, F, 'image/jpeg')).toBe(`tickets/${U}/${F}.jpg`);
    });
    it('ownership: foreign keys rejected, own keys accepted, undefined ok', () => {
        const own = { key: `tickets/${U}/${F}.png`, name: 'a.png', size: 10, type: 'image/png' as const };
        const foreign = { ...own, key: `tickets/${F}/${F}.png` };
        expect(attachmentsOwnedBy(U, [own])).toBe(true);
        expect(attachmentsOwnedBy(U, [own, foreign])).toBe(false);
        expect(attachmentsOwnedBy(U, undefined)).toBe(true);
    });
    it('schema caps at 3 and rejects path tricks; parseAttachments tolerates junk', () => {
        const own = { key: `tickets/${U}/${F}.png`, name: 'a.png', size: 10, type: 'image/png' };
        expect(AttachmentListSchema.safeParse([own, own, own, own]).success).toBe(false);
        expect(AttachmentListSchema.safeParse([{ ...own, key: `tickets/${U}/../x.png` }]).success).toBe(false);
        expect(AttachmentListSchema.safeParse([{ ...own, type: 'image/svg+xml' }]).success).toBe(false);
        expect(parseAttachments(null)).toEqual([]);
        expect(parseAttachments([own, { bogus: 1 }])).toEqual([]);
        expect(parseAttachments([own])).toEqual([own]);
    });
});
