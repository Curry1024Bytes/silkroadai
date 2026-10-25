// silkroadai portal shim (2026-10-22): runtime config injected by the portal page.
// Mirrors the subset of new-api `/api/status` + system-config the pricing feature reads.
import { create } from 'zustand'
import { BRAND_NAME, CUSTOMER_API_BASE_URL } from '@/lib/public-config'

export interface PlazaRuntimeConfig {
  /** USD → local currency rate (new-api `status.price`). */
  price: number
  /** Same as price unless the admin configured a separate exchange rate. */
  usd_exchange_rate: number
  /** Quota units per USD (new-api `status.quota_per_unit`, 500000). */
  quota_per_unit: number
  display_in_currency: boolean
  quota_display_type: 'USD' | 'CNY' | 'TOKENS' | 'CUSTOM'
  custom_currency_symbol: string
  custom_currency_exchange_rate: number
  /** Public API base URL shown in code samples (e.g. https://ai.silkroadai.io). */
  server_address: string
  system_name: string
}

export const DEFAULT_PLAZA_RUNTIME: PlazaRuntimeConfig = {
  price: 1,
  usd_exchange_rate: 1,
  quota_per_unit: 500000,
  display_in_currency: true,
  quota_display_type: 'CNY',
  custom_currency_symbol: '¤',
  custom_currency_exchange_rate: 1,
  server_address: CUSTOMER_API_BASE_URL,
  system_name: BRAND_NAME,
}

interface PlazaRuntimeState {
  config: PlazaRuntimeConfig
  setConfig: (config: Partial<PlazaRuntimeConfig>) => void
}

export const usePlazaRuntime = create<PlazaRuntimeState>()((set) => ({
  config: { ...DEFAULT_PLAZA_RUNTIME },
  setConfig: (config) => set((s) => ({ config: { ...s.config, ...config } })),
}))
