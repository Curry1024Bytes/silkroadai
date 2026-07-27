/**
 * LLmRoute brand <Logo /> component.
 *
 * Renders the canonical brand mark + wordmark from `src/assets/brand/`.
 * The supplied 1024px brand master is preserved in that directory; the SVG
 * delivery assets embed alpha-matted derivatives so the exact routed-circuit
 * geometry and metallic finish survive across browsers and operating systems.
 * Picks the right variant for the surface (light vs dark, full-color vs
 * mono, full-logo vs mark) and sizes via the `size` prop (height in px,
 * default 24 — the "header" baseline).
 *
 * Asset choice cheat-sheet
 * ------------------------
 *   primary       — light backgrounds, larger brand placements
 *   primary-flat  — compact UI headers and controls
 *   inverse       — dark backgrounds
 *   mono-dark     — print, fax, grayscale renders
 *   mono-light    — reverse on photos / arbitrary dark imagery
 *   mark          — favicon / app-icon / context where the wordmark is implied
 *
 * `linkHome` (default true) wraps the logo in a `<Link>` to `/`. Set
 * false for surfaces that already have their own click affordance.
 *
 * Asset import shape
 * ------------------
 * Next 13+ resolves `import x from '*.svg'` to `StaticImageData`
 * (`{src, width, height, blurDataURL}`). Vitest under Vite resolves
 * the same import to a plain URL string. We accept either shape via
 * `assetUrl()` so the component renders correctly in both runtimes —
 * and we hardcode the aspect ratio per variant rather than reading it
 * from the imported metadata, since Vite's URL-string return doesn't
 * carry it.
 *
 * Favicon
 * -------
 * Not handled here. Next.js App Router auto-discovers
 * `src/app/favicon.ico` and emits `<link rel="icon">` tags, so the
 * favicon is wired implicitly when the .ico file ships.
 */
import Link from 'next/link';
import logoPrimaryAsset from '@/assets/brand/logo-primary.svg';
import logoPrimaryFlatAsset from '@/assets/brand/logo-primary-flat.svg';
import logoInverseAsset from '@/assets/brand/logo-inverse.svg';
import logoMonoDarkAsset from '@/assets/brand/logo-mono-dark.svg';
import logoMonoLightAsset from '@/assets/brand/logo-mono-light.svg';
import markOnlyAsset from '@/assets/brand/mark-only.svg';

export type LogoVariant = 'primary' | 'primary-flat' | 'inverse' | 'mono-dark' | 'mono-light' | 'mark';

interface LogoProps {
    variant?: LogoVariant;
    /** Height in CSS pixels. Width auto-scales by the variant's intrinsic
     *  aspect ratio (full-logo is 4:1; mark is 1:1). Default 24. */
    size?: number;
    /** Wrap the logo in `<Link href="/">`. Default true. */
    linkHome?: boolean;
    /** Optional className passthrough on the rendered img / link. */
    className?: string;
}

/**
 * Pull the URL out of whatever the bundler decided `*.svg` should
 * import as. Next gives us `{src, width, height}`; Vite (used by
 * vitest) gives us the URL as a plain string.
 */
function assetUrl(asset: unknown): string {
    if (typeof asset === 'string') return asset;
    if (asset && typeof asset === 'object' && 'src' in asset) {
        const v = (asset as { src: unknown }).src;
        if (typeof v === 'string') return v;
    }
    return '';
}

interface VariantConfig {
    src: string;
    /** width / height — drives the rendered <img> width given the
     *  caller's `size` (height) prop. Hand-set to match the SVG delivery
     *  viewBox so we don't depend on the bundler reporting it. */
    aspect: number;
    /** Visible label fallback for screen readers / image-blocking. */
    alt: string;
}

const VARIANTS: Record<LogoVariant, VariantConfig> = {
    primary: { src: assetUrl(logoPrimaryAsset), aspect: 96 / 24, alt: 'LLmRoute' },
    'primary-flat': { src: assetUrl(logoPrimaryFlatAsset), aspect: 96 / 24, alt: 'LLmRoute' },
    inverse: { src: assetUrl(logoInverseAsset), aspect: 96 / 24, alt: 'LLmRoute' },
    'mono-dark': { src: assetUrl(logoMonoDarkAsset), aspect: 96 / 24, alt: 'LLmRoute' },
    'mono-light': { src: assetUrl(logoMonoLightAsset), aspect: 96 / 24, alt: 'LLmRoute' },
    mark: { src: assetUrl(markOnlyAsset), aspect: 1, alt: 'LLmRoute' },
};

export function Logo({ variant = 'primary', size = 24, linkHome = true, className }: LogoProps) {
    const config = VARIANTS[variant];
    const width = Math.round(size * config.aspect);

    const img = (
        // Intentionally `<img>` rather than next/image's <Image>. Next's
        // <Image> wraps in a sizing wrapper, generates blur placeholders,
        // and runs the URL through the image-optimizer endpoint — all
        // designed for raster photos. These compact, local logo assets already
        // have exact dimensions, so <img> avoids an unnecessary optimizer
        // round-trip while preserving deterministic rendering.
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={config.src}
            alt={config.alt}
            width={width}
            height={size}
            style={{ height: size, width, display: 'block' }}
            className={linkHome ? undefined : className}
        />
    );

    if (!linkHome) {
        return img;
    }

    return (
        <Link
            href="/"
            aria-label={config.alt}
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                textDecoration: 'none',
                lineHeight: 0,
            }}
            className={className}
        >
            {img}
        </Link>
    );
}
