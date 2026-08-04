import { redirect } from 'next/navigation';

/**
 * The former Sub2API subscription-channel console is no longer part of the
 * new-api B3 runtime. Keep the URL as a compatibility redirect so bookmarks
 * do not expose a non-functional management surface.
 */
export default function LegacyChannelsRedirect() {
    redirect('/admin/models');
}
