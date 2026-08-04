import { redirect } from 'next/navigation';

/**
 * Subscription management still depends on the retired Sub2API/LiteLLM shim.
 * Preserve the route without presenting controls that cannot affect new-api.
 */
export default function LegacySubscriptionsRedirect() {
    redirect('/admin');
}
