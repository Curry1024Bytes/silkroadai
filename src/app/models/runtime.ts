import 'server-only';
import { BRAND_NAME, CUSTOMER_API_BASE_URL } from '@/lib/public-config';
import type { PlazaRuntimeConfig } from '@newapi/lib/plaza-runtime';

/** Portal tariffs are already CNY. Backend display preferences must not reprice them. */
export async function loadPlazaRuntime(): Promise<PlazaRuntimeConfig> {
    return {
        price: 1,
        usd_exchange_rate: 1,
        quota_per_unit: 500000,
        display_in_currency: true,
        quota_display_type: 'CNY',
        custom_currency_symbol: '¥',
        custom_currency_exchange_rate: 1,
        server_address: CUSTOMER_API_BASE_URL,
        system_name: BRAND_NAME,
    };
}
