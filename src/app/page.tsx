import { redirect } from 'next/navigation';

/**
 * Root → /pay redirect.
 *
 * Forwards ALL query string params, not just `lang`. Important for the OAuth
 * post-callback path: provider callbacks redirect to `/?oauth_error=<code>`
 * on failure, and we want that error visible to the eventual /pay (or the
 * /login it redirects to when unauthenticated). Pre-W4-1 this only forwarded
 * `lang`, swallowing oauth_error.
 */
export default async function Home({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = (await searchParams) ?? {};
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (typeof v === 'string') {
            qs.set(k, v);
        } else if (Array.isArray(v)) {
            // Repeated keys (?k=a&k=b) — preserve order.
            for (const item of v) qs.append(k, item);
        }
    }
    const tail = qs.toString();
    redirect(tail ? `/pay?${tail}` : '/pay');
}
