import { getLocale } from '@/lib/i18n/server';
import { DocsContent, docsMetadata } from '@/app/docs/docs-content';

export async function generateMetadata() {
    return { title: docsMetadata(await getLocale()).title };
}

export default async function WorkspaceDocsPage() {
    return <DocsContent embedded locale={await getLocale()} />;
}
