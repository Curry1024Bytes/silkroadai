import 'server-only';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { Logo, type LogoVariant } from '@/components/brand/Logo';
import { getCurrentTenant } from '@/lib/tenant/resolve';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

/**
 * P6a / P6b-2 — tenant-aware logo for customer-facing headers.
 *
 * Resolves the request-domain tenant, then (in priority order):
 *   1. has `logo_url`           → render that image.
 *   2. platform tenant, no logo → default Silk Road AI `<Logo>` (unchanged — the
 *      platform domain MUST render byte-identically; §3.1 zero-regression line).
 *   3. NON-platform, no logo    → the tenant's `brand_name` as a text wordmark
 *      (P6b-2 §3.1: a partner without a logo shows ITS brand name, not Silk Road's).
 *
 * Async server component (reads Host via getCurrentTenant). Only used in server-rendered
 * customer headers (landing / login / register / authenticated layout). Do NOT use in the
 * global Footer (would force every route — incl. /models ISR — dynamic).
 */
interface BrandLogoProps {
    variant?: LogoVariant;
    size?: number;
    linkHome?: boolean;
    className?: string;
}

export async function BrandLogo({ variant = 'primary-flat', size = 24, linkHome = true, className }: BrandLogoProps) {
    const tenant = await getCurrentTenant();

    if (!tenant.logo_url) {
        // Case 2 — platform (or break-glass fallback): unchanged default brand mark.
        if (tenant.id === PLATFORM_TENANT_ID) {
            return <Logo variant={variant} size={size} linkHome={linkHome} className={className} />;
        }
        // Case 3 — non-platform tenant with no custom logo → brand_name text wordmark.
        const wordmarkStyle: CSSProperties = {
            fontSize: Math.round(size * 0.8),
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: '-0.01em',
            whiteSpace: 'nowrap',
            color: tenant.primary_color ?? '#1E3A8A',
        };
        const wordmark = (
            <span style={wordmarkStyle} className={linkHome ? undefined : className}>
                {tenant.brand_name}
            </span>
        );
        if (!linkHome) return wordmark;
        return (
            <Link
                href="/"
                aria-label={tenant.brand_name}
                style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', lineHeight: 0 }}
                className={className}
            >
                {wordmark}
            </Link>
        );
    }

    const imgStyle: CSSProperties = { height: size, width: 'auto', display: 'block' };
    const img = (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={tenant.logo_url}
            alt={tenant.brand_name}
            height={size}
            style={imgStyle}
            className={linkHome ? undefined : className}
        />
    );
    if (!linkHome) return img;
    return (
        <Link
            href="/"
            aria-label={tenant.brand_name}
            style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', lineHeight: 0 }}
            className={className}
        >
            {img}
        </Link>
    );
}
