/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
// silkroadai portal shim (2026-10-22): replaces the new-api app-shell module of the
// same path so the vendored pricing feature can run inside the Next.js portal.
import { create } from 'zustand'

export type CurrencyDisplayType = 'USD' | 'CNY' | 'TOKENS' | 'CUSTOM'
export interface CurrencyConfig {
  displayInCurrency: boolean
  quotaDisplayType: CurrencyDisplayType
  quotaPerUnit: number
  usdExchangeRate: number
  customCurrencySymbol: string
  customCurrencyExchangeRate: number
}
export interface SystemConfig {
  systemName: string
  logo: string
  footerHtml?: string
  demoSiteEnabled?: boolean
  displayTokenStatEnabled?: boolean
  currency: CurrencyConfig
}
export const DEFAULT_CURRENCY_CONFIG: CurrencyConfig = {
  displayInCurrency: true,
  quotaDisplayType: 'USD',
  quotaPerUnit: 500000,
  usdExchangeRate: 1,
  customCurrencySymbol: '¤',
  customCurrencyExchangeRate: 1,
}
interface SystemConfigState {
  config: SystemConfig
  loading: boolean
  loadedLogoUrl: string
  setConfig: (config: Partial<SystemConfig>) => void
  setLoadedLogoUrl: (url: string) => void
  setLoading: (loading: boolean) => void
}
/** No `persist` middleware here: the portal injects the config on mount, nothing
 *  should survive in localStorage across deploys. */
export const useSystemConfigStore = create<SystemConfigState>()((set) => ({
  config: { systemName: 'Silk Road AI', logo: '', currency: { ...DEFAULT_CURRENCY_CONFIG } },
  loading: false,
  loadedLogoUrl: '',
  setConfig: (newConfig) =>
    set((state) => ({
      config: {
        ...state.config,
        ...newConfig,
        currency: { ...state.config.currency, ...(newConfig.currency ?? {}) },
      },
    })),
  setLoadedLogoUrl: (url) => set({ loadedLogoUrl: url }),
  setLoading: (loading) => set({ loading }),
}))
