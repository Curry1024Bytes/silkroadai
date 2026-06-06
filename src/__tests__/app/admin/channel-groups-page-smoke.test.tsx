import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

// /admin/channel-groups is a 'use client' page reading next/navigation hooks;
// mock them so renderToString produces the initial (loading) markup under node.
// It sits behind the (console) server auth gate (covered by the P1 layout test).
vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/admin/channel-groups',
}));

import ChannelGroupsPage from '@/app/admin/(console)/channel-groups/page';

describe('admin channel-groups page — SSR smoke (P3)', () => {
    it('renders without crashing', () => {
        const html = renderToString(<ChannelGroupsPage />);
        expect(html.length).toBeGreaterThan(0);
    });
});
