import { LegalDocPage } from '@/components/LegalDocPage';

export const dynamic = 'force-dynamic';
export const metadata = { title: '退款政策 — LLmRoute' };

export default async function RefundPage() {
    return <LegalDocPage file="refund-policy.md" />;
}
