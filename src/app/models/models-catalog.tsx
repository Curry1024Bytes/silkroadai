import { BackButton } from '@/components/BackButton';
import { Logo } from '@/components/brand/Logo';
import { FormError } from '@/components/ui/FormError';
import { classifyModels } from '@/lib/models/categorize';
import { listAvailableModels } from '@/lib/newapi/client';
import { CUSTOMER_API_BASE_URL } from '@/lib/public-config';
import { ModelsBrowser } from './models-browser';

export async function ModelsCatalog({ embedded = false }: { embedded?: boolean }) {
    let rawModels: string[] = [];
    let fetchErr: string | null = null;
    try {
        rawModels = await listAvailableModels();
    } catch (err) {
        fetchErr = err instanceof Error ? err.message : String(err);
        console.warn('[models] listAvailableModels failed:', err);
    }

    const { entries, totalModels, vendorCount } = classifyModels(rawModels);
    const content = fetchErr ? (
        <FormError severity="banner">当前无法获取模型清单,请稍后重试。</FormError>
    ) : (
        <ModelsBrowser entries={entries} totalModels={totalModels} vendorCount={vendorCount} />
    );

    if (embedded) {
        return (
            <section className="space-y-6">
                <div>
                    <p className="m-0 mb-1 text-xs font-semibold text-portal-gold">CATALOG</p>
                    <h1 className="m-0 text-[28px] font-semibold leading-tight text-portal-ink">模型清单</h1>
                    <p className="m-0 mt-2 max-w-3xl text-sm leading-relaxed text-portal-muted">
                        当前接入 <strong className="text-portal-ink">{totalModels}</strong> 个模型，覆盖{' '}
                        <strong className="text-portal-ink">{vendorCount}</strong> 个厂商，可通过 OpenAI / Anthropic
                        兼容协议调用。
                    </p>
                </div>
                {content}
            </section>
        );
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
                    <h1 className="m-0 text-3xl font-semibold text-navy">模型清单</h1>
                    <p className="m-0 max-w-3xl text-sm leading-relaxed text-muted-ink">
                        我们当前接入了 <strong className="text-navy">{totalModels}</strong> 个模型,涵盖{' '}
                        <strong className="text-navy">{vendorCount}</strong> 个厂商。所有模型均可在{' '}
                        <code className="rounded border border-brand-border bg-surface px-1.5 py-0.5 text-xs text-navy">
                            {CUSTOMER_API_BASE_URL}
                        </code>{' '}
                        通过 OpenAI / Anthropic 兼容协议调用。
                    </p>
                </header>
                {content}
            </div>
        </main>
    );
}
