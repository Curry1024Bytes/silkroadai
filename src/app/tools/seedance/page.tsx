import { BackButton } from '@/components/BackButton';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { toolsMessages } from '@/lib/i18n/messages/tools';
import { SeedanceTool } from './seedance-tool';

export async function generateMetadata() {
    const m = pickMessages(toolsMessages, await getLocale());
    return { title: m.seedance.metaTitle, description: m.seedance.metaDescription };
}

export default async function SeedanceToolPage() {
    const m = pickMessages(toolsMessages, await getLocale());
    return (
        <main className="min-h-screen bg-paper text-ink">
            <div className="mx-auto max-w-3xl px-5 py-8">
                <BackButton className="text-sm text-brand-accent hover:underline cursor-pointer border-0 bg-transparent p-0">
                    {m.shared.back}
                </BackButton>
                <h1 className="m-0 mt-4 mb-1 text-2xl font-semibold text-navy">{m.seedance.title}</h1>
                <p className="m-0 mb-6 text-sm text-muted-ink leading-relaxed">{m.seedance.intro}</p>
                <SeedanceTool />
            </div>
        </main>
    );
}
