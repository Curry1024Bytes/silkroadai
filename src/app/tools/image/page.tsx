import { BackButton } from '@/components/BackButton';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { toolsMessages } from '@/lib/i18n/messages/tools';
import { ImageTool } from './image-tool';

export async function generateMetadata() {
    const m = pickMessages(toolsMessages, await getLocale());
    return { title: m.image.metaTitle, description: m.image.metaDescription };
}

export default async function ImageToolPage() {
    const m = pickMessages(toolsMessages, await getLocale());
    return (
        <main className="min-h-screen bg-paper text-ink">
            <div className="mx-auto max-w-3xl px-5 py-8">
                <BackButton className="text-sm text-brand-accent hover:underline cursor-pointer border-0 bg-transparent p-0">
                    {m.shared.back}
                </BackButton>
                <h1 className="m-0 mt-4 mb-1 text-2xl font-semibold text-navy">{m.image.title}</h1>
                <p className="m-0 mb-6 text-sm text-muted-ink leading-relaxed">{m.image.intro}</p>
                <ImageTool />
            </div>
        </main>
    );
}
