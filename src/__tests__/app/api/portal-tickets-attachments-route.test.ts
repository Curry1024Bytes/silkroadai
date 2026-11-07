import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a) }));
const mockUpload = vi.fn();
vi.mock('@/lib/r2/client', () => ({ uploadImage: (...a: unknown[]) => mockUpload(...a) }));

import { POST } from '@/app/api/portal/tickets/attachments/route';

const U = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function upload(bytes: Uint8Array | null, name = 'shot.png', type = 'image/png') {
    const fd = new FormData();
    if (bytes) fd.append('file', new File([bytes.slice().buffer as ArrayBuffer], name, { type }));
    return new NextRequest('https://x/api/portal/tickets/attachments', { method: 'POST', body: fd });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: U });
    mockUpload.mockImplementation(async (key: string) => `https://images.silkroadai.io/${key}`);
});

describe('POST /api/portal/tickets/attachments', () => {
    it('401 without session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        expect((await POST(upload(PNG))).status).toBe(401);
    });
    it('400 without file; 415 for non-image bytes even with image/png label', async () => {
        expect((await POST(upload(null))).status).toBe(400);
        expect((await POST(upload(new TextEncoder().encode('<svg/>'), 'x.png', 'image/png'))).status).toBe(415);
        expect(mockUpload).not.toHaveBeenCalled();
    });
    it('413 over 5MB', async () => {
        const big = new Uint8Array(5 * 1024 * 1024 + 1);
        big.set(PNG);
        expect((await POST(upload(big))).status).toBe(413);
    });
    it('201: key scoped to user with sniffed extension, public url returned', async () => {
        const res = await POST(upload(PNG, 'my shot.PNG', 'application/octet-stream'));
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.key).toMatch(new RegExp(`^tickets/${U}/[0-9a-f-]{36}\\.png$`));
        expect(json).toMatchObject({
            type: 'image/png',
            name: 'my shot.PNG',
            size: PNG.length,
            url: expect.stringContaining('images.silkroadai.io/tickets/'),
        });
        expect(mockUpload).toHaveBeenCalledWith(json.key, expect.any(Buffer), 'image/png');
    });
    it('502 when R2 upload fails', async () => {
        mockUpload.mockRejectedValue(new Error('R2_PUBLIC_URL not set'));
        expect((await POST(upload(PNG))).status).toBe(502);
    });
});
