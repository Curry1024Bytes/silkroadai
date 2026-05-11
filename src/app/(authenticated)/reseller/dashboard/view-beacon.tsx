'use client';

/**
 * DashboardViewBeacon (PR-U2) — fires `reseller_dashboard_viewed` once
 * per mount so we can track reseller activity. Mounted at the top of
 * /reseller/dashboard. Best-effort; failure is silent.
 *
 * StrictMode-safe: useRef gate prevents the double-fire that StrictMode's
 * development double-render would otherwise cause.
 */
import { useEffect, useRef } from 'react';

export function DashboardViewBeacon() {
    const fired = useRef(false);
    useEffect(() => {
        if (fired.current) return;
        fired.current = true;
        void fetch('/api/portal/analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event_type: 'reseller_dashboard_viewed', properties: {} }),
            credentials: 'same-origin',
        }).catch(() => {
            /* best-effort */
        });
    }, []);
    return null;
}
