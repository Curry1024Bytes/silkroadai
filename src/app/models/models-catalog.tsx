import { BackButton } from '@/components/BackButton';
import { Logo } from '@/components/brand/Logo';
import { FormError } from '@/components/ui/FormError';
import { classifyModels } from '@/lib/models/categorize';
import { loadBrowserCatalog } from '@/lib/models/catalog-browser';
import { getCurrentUser } from '@/lib/auth/session';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { ModelsBrowser } from './models-browser';

async function pricingUserId() {
    const cookie = (await headers()).get('cookie');
    if (!cookie) return undefined;
    const user = await getCurrentUser(new NextRequest('http://internal/models', { headers: { cookie } }));
    return user?.id;
}

export async function ModelsCatalog({ embedded = false }: { embedded?: boolean }) {
    let catalog: Awaited<ReturnType<typeof loadBrowserCatalog>> | null = null;
    try {
        catalog = await loadBrowserCatalog(await pricingUserId());
    } catch (err) {
        console.warn('[models] loadBrowserCatalog failed:', err);
    }

    const content = !catalog ? (
        <>
            <h1 className="m-0 mb-4 text-3xl font-semibold text-navy">模型清单</h1>
            <FormError severity="banner">当前无法获取模型清单与价格，请稍后重试。</FormError>
        </>
    ) : (
        <ModelsBrowser
            {...classifyModels(catalog.models.map((model) => model.slug))}
            tiers={catalog.tiers}
            pricing={catalog.models}
            embedded={embedded}
        />
    );

    if (embedded) {
        return <section className="space-y-6">{content}</section>;
    }

    return (
        <main className="min-h-screen bg-paper px-4 py-8">
            <div className="mx-auto max-w-6xl">
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
