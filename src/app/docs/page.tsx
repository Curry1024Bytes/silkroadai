/** Public documentation route; authenticated users use /workspace/docs. */
import { getLocale } from '@/lib/i18n/server';
import { DocsContent, docsMetadata } from './docs-content';

export async function generateMetadata() {
    return docsMetadata(await getLocale());
}

export default async function DocsPage() {
    return <DocsContent locale={await getLocale()} />;
}
