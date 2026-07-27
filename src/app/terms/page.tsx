import { LegalDocPage } from '@/components/LegalDocPage';

export const dynamic = 'force-dynamic';
export const metadata = { title: '服务条款 — LLmRoute' };

export default async function TermsPage() {
    return <LegalDocPage file="service-terms.md" />;
}
