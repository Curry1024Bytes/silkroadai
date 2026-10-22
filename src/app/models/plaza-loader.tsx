'use client';
import dynamic from 'next/dynamic';
import type { PlazaIslandProps } from './plaza-island';

const PlazaIsland = dynamic(() => import('./plaza-island'), {
    ssr: false,
    loading: () => (
        <div className="mx-auto w-full max-w-[1800px] px-3 pt-16 sm:px-6 sm:pt-20 xl:px-8" aria-busy="true">
            <div className="mx-auto h-10 w-48 animate-pulse rounded bg-surface-muted" />
            <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-56 animate-pulse rounded-xl bg-surface-muted" />
                ))}
            </div>
        </div>
    ),
});

export function PlazaLoader(props: PlazaIslandProps) {
    return <PlazaIsland {...props} />;
}
