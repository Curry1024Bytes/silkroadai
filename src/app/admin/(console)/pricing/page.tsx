'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import SimplePricing from '@/components/admin/SimplePricing';
import CostPricingWorkbench, { type CostPricingModel } from '@/components/admin/CostPricingWorkbench';
import { PricingPublishJobs, requestPricingJobAction } from '@/components/admin/PricingPublishJobs';
import type { PricingPublishJob } from '@/lib/admin/pricing-publish-types';
import { resolveLocale, type Locale } from '@/lib/locale';

type PricingSection = 'cost' | 'simple' | 'jobs';

function PricingWorkspace({
    isDark,
    locale,
    initialSection,
}: {
    isDark: boolean;
    locale: Locale;
    initialSection: PricingSection;
}) {
    const en = locale === 'en';
    const [section, setSection] = useState<PricingSection>(initialSection);
    const [models, setModels] = useState<CostPricingModel[] | null>(null);
    const [modelsError, setModelsError] = useState('');
    const modelsRequested = useRef(false);
    const [jobs, setJobs] = useState<PricingPublishJob[] | null>(null);
    const [jobsError, setJobsError] = useState('');
    const [busyJob, setBusyJob] = useState<string | null>(null);

    const loadModels = useCallback(async () => {
        if (modelsRequested.current) return;
        modelsRequested.current = true;
        try {
            const response = await fetch('/api/admin/models', { credentials: 'same-origin', cache: 'no-store' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !Array.isArray(data.models))
                throw new Error(data.message || data.error || (en ? 'Could not load models.' : '模型列表加载失败。'));
            setModels(
                data.models
                    .filter(
                        (model: unknown): model is CostPricingModel =>
                            !!model &&
                            typeof model === 'object' &&
                            'id' in model &&
                            typeof model.id === 'string' &&
                            'slug' in model &&
                            typeof model.slug === 'string' &&
                            'display_name' in model &&
                            typeof model.display_name === 'string' &&
                            'enabled' in model &&
                            typeof model.enabled === 'boolean',
                    )
                    .map(({ id, slug, display_name, enabled }: CostPricingModel) => ({
                        id,
                        slug,
                        display_name,
                        enabled,
                    })),
            );
            setModelsError('');
        } catch (caught) {
            setModelsError(
                caught instanceof Error ? caught.message : en ? 'Could not load models.' : '模型列表加载失败。',
            );
            modelsRequested.current = false;
        }
    }, [en]);

    const loadJobs = useCallback(async () => {
        try {
            const response = await fetch('/api/admin/pricing', { credentials: 'same-origin', cache: 'no-store' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !Array.isArray(data.publish_jobs))
                throw new Error(
                    data.message || data.error || (en ? 'Could not load publication tasks.' : '发布任务加载失败。'),
                );
            setJobs(data.publish_jobs as PricingPublishJob[]);
            setJobsError('');
        } catch (caught) {
            setJobs((current) => current ?? []);
            setJobsError(
                caught instanceof Error
                    ? caught.message
                    : en
                      ? 'Could not load publication tasks.'
                      : '发布任务加载失败。',
            );
        }
    }, [en]);

    useEffect(() => {
        if (section === 'cost' && models === null && !modelsRequested.current) void loadModels();
        if (section !== 'jobs') return;
        const timer = window.setTimeout(() => void loadJobs(), 0);
        return () => window.clearTimeout(timer);
    }, [section, models, loadModels, loadJobs]);

    useEffect(() => {
        if (section !== 'jobs' || !(jobs ?? []).some((job) => !['succeeded', 'cancelled'].includes(job.status))) return;
        const timer = window.setInterval(() => void loadJobs(), 5000);
        return () => window.clearInterval(timer);
    }, [section, jobs, loadJobs]);

    const published = (job: PricingPublishJob) => {
        setJobs((current) => [job, ...(current ?? []).filter((row) => row.id !== job.id)]);
        setSection('jobs');
        void loadJobs();
    };

    const uncertain = (message?: string) => {
        if (message) setJobsError(message);
        setSection('jobs');
        void loadJobs();
    };

    const actOnJob = async (job: PricingPublishJob, action: 'retry' | 'cancel') => {
        setBusyJob(job.id);
        setJobsError('');
        try {
            await requestPricingJobAction(job.id, action, en);
            await loadJobs();
        } catch (caught) {
            setJobsError(
                caught instanceof Error ? caught.message : en ? 'The task could not be updated.' : '任务操作失败。',
            );
        } finally {
            setBusyJob(null);
        }
    };

    const tabClass = (active: boolean) =>
        `min-h-11 rounded-lg border px-4 py-2 text-sm font-medium ${active ? 'border-emerald-600 bg-emerald-600 text-white' : isDark ? 'border-slate-600 text-slate-200 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-100'}`;

    return (
        <div>
            <div role="tablist" aria-label={en ? 'Pricing tools' : '定价工具'} className="mb-5 flex flex-wrap gap-2">
                {(
                    [
                        ['cost', en ? 'Cost-based pricing' : '按成本加价'],
                        ['simple', en ? 'Current pricing' : '现有定价'],
                        ['jobs', en ? 'Publication tasks' : '发布任务'],
                    ] as const
                ).map(([key, label]) => (
                    <button
                        key={key}
                        type="button"
                        role="tab"
                        id={`pricing-section-${key}`}
                        aria-controls={`pricing-section-panel-${key}`}
                        aria-selected={section === key}
                        tabIndex={section === key ? 0 : -1}
                        onClick={() => setSection(key)}
                        className={tabClass(section === key)}
                    >
                        {label}
                        {key === 'jobs' && (jobs?.length ?? 0) > 0 ? ` · ${jobs?.length}` : ''}
                    </button>
                ))}
            </div>
            <div
                id="pricing-section-panel-cost"
                role="tabpanel"
                aria-labelledby="pricing-section-cost"
                hidden={section !== 'cost'}
            >
                {modelsError ? (
                    <p role="alert" className="text-sm text-red-600">
                        {modelsError}
                    </p>
                ) : models === null ? (
                    <p role="status" className="py-8 text-center text-sm text-slate-500">
                        {en ? 'Loading models…' : '正在加载模型…'}
                    </p>
                ) : (
                    <CostPricingWorkbench
                        models={models}
                        isDark={isDark}
                        locale={locale}
                        onPublished={published}
                        onUncertain={uncertain}
                    />
                )}
                {modelsError && (
                    <button
                        type="button"
                        onClick={() => {
                            setModelsError('');
                            void loadModels();
                        }}
                        className="mt-3 text-sm text-emerald-700 hover:underline"
                    >
                        {en ? 'Retry' : '重试'}
                    </button>
                )}
            </div>
            <div
                id="pricing-section-panel-simple"
                role="tabpanel"
                aria-labelledby="pricing-section-simple"
                hidden={section !== 'simple'}
            >
                <SimplePricing isDark={isDark} en={en} />
            </div>
            <div
                id="pricing-section-panel-jobs"
                role="tabpanel"
                aria-labelledby="pricing-section-jobs"
                hidden={section !== 'jobs'}
            >
                <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-sm text-slate-500">{jobs === null ? (en ? 'Loading…' : '加载中…') : ''}</p>
                    <button type="button" onClick={() => void loadJobs()} className={tabClass(false)}>
                        {en ? 'Refresh tasks' : '刷新任务'}
                    </button>
                </div>
                <PricingPublishJobs
                    jobs={jobs ?? []}
                    en={en}
                    isDark={isDark}
                    busyId={busyJob}
                    error={jobsError}
                    onAction={(job, action) => void actOnJob(job, action)}
                />
            </div>
        </div>
    );
}

function PricingContent() {
    const searchParams = useSearchParams();
    const isDark = searchParams.get('theme') === 'dark';
    const isEmbedded = (searchParams.get('ui_mode') || 'standalone') === 'embedded';
    const locale = resolveLocale(searchParams.get('lang'));
    const en = locale === 'en';
    const initialSection: PricingSection = searchParams.get('view') === 'simple' ? 'simple' : 'cost';

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={en ? 'Pricing' : '模型定价'}
            subtitle={
                en
                    ? 'Manage supplier costs, customer prices and publication status'
                    : '管理上游成本、客户售价与发布状态'
            }
            locale={locale}
        >
            <PricingWorkspace isDark={isDark} locale={locale} initialSection={initialSection} />
        </PayPageLayout>
    );
}

function PricingPageFallback() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));

    return (
        <div className="flex min-h-screen items-center justify-center">
            <div className="text-slate-500">{locale === 'en' ? 'Loading...' : '加载中...'}</div>
        </div>
    );
}

export default function PricingPage() {
    return (
        <Suspense fallback={<PricingPageFallback />}>
            <PricingContent />
        </Suspense>
    );
}
