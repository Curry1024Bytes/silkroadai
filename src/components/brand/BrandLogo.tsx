import 'server-only';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { Logo, type LogoVariant } from '@/components/brand/Logo';
import { getCurrentTenant } from '@/lib/tenant/resolve';

/**
 * P6a — tenant-aware logo for customer-facing headers.
 *
 * Resolves the request-domain tenant; if it has a `logo_url` → render that image,
 * else fall back to the default Silk Road AI `<Logo>`. The platform tenant has no
 * `logo_url`, so the platform domain renders the SAME `<Logo>` as before (no regression).
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
        // Platform (or any tenant without a custom logo) → unchanged default brand mark.
        return <Logo variant={variant} size={size} linkHome={linkHome} className={className} />;
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
