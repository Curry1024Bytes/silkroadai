import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedirect = vi.fn();

vi.mock('next/navigation', () => ({
    redirect: (...args: unknown[]) => mockRedirect(...args),
}));

import LegacyChannelsRedirect from '@/app/admin/(console)/channels/page';
import LegacySubscriptionsRedirect from '@/app/admin/(console)/subscriptions/page';

describe('retired admin console routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('/admin/channels redirects to current model management', () => {
        LegacyChannelsRedirect();
        expect(mockRedirect).toHaveBeenCalledWith('/admin/models');
    });

    it('/admin/subscriptions redirects to the admin dashboard', () => {
        LegacySubscriptionsRedirect();
        expect(mockRedirect).toHaveBeenCalledWith('/admin');
    });
});
