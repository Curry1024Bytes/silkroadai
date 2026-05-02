import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/config', () => ({
  getEnv: () => ({
    LITELLM_BASE_URL: 'https://test.sub2api.com',
    LITELLM_MASTER_KEY: 'admin-testkey123',
  }),
}));

vi.mock('@/lib/system-config', () => ({
  getSystemConfig: () => Promise.resolve(undefined),
}));

import { listSubscriptions } from '@/lib/litellm/client';

describe('listSubscriptions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should call correct URL with no query params when no params provided', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { items: [], total: 0, page: 1, page_size: 50 } }),
    }) as typeof fetch;

    await listSubscriptions();

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    // URL should end with "subscriptions?" and have no params after the ?
    expect(url).toBe('https://test.sub2api.com/api/v1/admin/subscriptions?');
  });

  it('should build correct query params when all params provided', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { items: [], total: 0, page: 2, page_size: 10 } }),
    }) as typeof fetch;

    await listSubscriptions({
      user_id: 42,
      group_id: 5,
      status: 'active',
      page: 2,
      page_size: 10,
    });

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsedUrl = new URL(url);
    expect(parsedUrl.searchParams.get('user_id')).toBe('42');
    expect(parsedUrl.searchParams.get('group_id')).toBe('5');
    expect(parsedUrl.searchParams.get('status')).toBe('active');
    expect(parsedUrl.searchParams.get('page')).toBe('2');
    expect(parsedUrl.searchParams.get('page_size')).toBe('10');
  });

  it('should parse normal response correctly', async () => {
    const mockSubs = [{ id: 1, user_id: 42, group_id: 5, status: 'active', expires_at: '2026-12-31' }];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { items: mockSubs, total: 1, page: 1, page_size: 50 } }),
    }) as typeof fetch;

    const result = await listSubscriptions({ user_id: 42 });

    expect(result.subscriptions).toEqual(mockSubs);
    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
    expect(result.page_size).toBe(50);
  });

  it('should throw on HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as typeof fetch;

    await expect(listSubscriptions()).rejects.toThrow('Failed to list subscriptions: 500');
  });
});
