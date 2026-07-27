/** Public documentation route; authenticated users use /workspace/docs. */
import { DOCS_METADATA, DocsContent } from './docs-content';

export const metadata = DOCS_METADATA;

export default function DocsPage() {
    return <DocsContent />;
}
