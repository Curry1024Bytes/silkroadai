import { BackButton } from '@/components/BackButton';
import { Logo } from '@/components/brand/Logo';
import { FormError } from '@/components/ui/FormError';
import { loadPlazaData } from '@/lib/models/plaza-data';
import { getCurrentUser } from '@/lib/auth/session';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { PlazaLoader } from './plaza-loader';
import { loadPlazaRuntime } from './runtime';

async function pricingViewer() {
    const cookie = (await headers()).get('cookie');
    if (!cookie) return null;
    const user = await getCurrentUser(new NextRequest('http://internal/models', { headers: { cookie } }));
    return user;
}

export async function ModelsCatalog({ embedded = false }: { embedded?: boolean }) {
    let catalog: Awaited<ReturnType<typeof loadPlazaData>> | null = null;
    try {
        catalog = await loadPlazaData(await pricingViewer());
    } catch (err) {
        console.warn('[models] loadPlazaData failed:', err);
    }

    const content = !catalog ? (
        <>
            <h1 className="m-0 mb-4 text-3xl font-semibold text-navy">模型广场</h1>
            <FormError severity="banner">当前无法获取模型清单与价格，请稍后重试。</FormError>
        </>
    ) : (
        <PlazaLoader
            key={`${catalog.portal_viewer_key}:${catalog.portal_snapshot}`}
            runtime={await loadPlazaRuntime()}
            initialData={catalog}
            embedded={embedded}
        />
    );

    if (embedded) {
        return <section className="space-y-6">{content}</section>;
    }

    return (
        <main className="min-h-screen bg-paper px-4 py-8">
            <div className="mx-auto max-w-[1800px]">
                <header className="mb-6 flex flex-col gap-3">
                    <BackButton className="inline-flex w-fit cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs text-muted-ink no-underline transition-colors duration-150 ease-brand hover:text-brand-accent">
                        <span aria-hidden="true">←</span>
                        <span>返回</span>
                    </BackButton>
                    <div className="flex items-center gap-3">
                        <Logo variant="primary-flat" size={28} />
                        <p className="m-0 text-xs text-minor-ink">One route. Every model.</p>
                    </div>
                </header>
                {content}
            </div>
        </main>
    );
}
