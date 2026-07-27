import { LegalDocPage } from '@/components/LegalDocPage';

export const dynamic = 'force-dynamic';
export const metadata = { title: '隐私政策 — LLmRoute' };

export default async function PrivacyPage() {
    return <LegalDocPage file="privacy-policy.md" />;
}
