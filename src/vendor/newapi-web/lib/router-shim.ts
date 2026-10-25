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
// Minimal stand-in for `@tanstack/react-router`: the pricing feature only reads the
// initial URL search params (filters are kept in local state afterwards).
'use client'
import { useMemo } from 'react'
import { useSearchParams } from 'next/navigation'

export interface PricingSearch {
  search?: string
  sort?: string
  vendor?: string
  group?: string
  quotaType?: string
  endpointType?: string
  tag?: string
  tokenUnit?: 'M' | 'K'
  view?: 'card' | 'table'
  rechargePrice?: boolean
}

export function useSearch(_opts?: { from?: string }): PricingSearch {
  const sp = useSearchParams()
  return useMemo(() => {
    const str = (k: string) => sp?.get(k) ?? undefined
    const tokenUnit = str('tokenUnit')
    const view = str('view')
    return {
      search: str('search'),
      sort: str('sort'),
      vendor: str('vendor'),
      group: str('group'),
      quotaType: str('quotaType'),
      endpointType: str('endpointType'),
      tag: str('tag'),
      tokenUnit: tokenUnit === 'K' ? 'K' : tokenUnit === 'M' ? 'M' : undefined,
      view: view === 'table' ? 'table' : view === 'card' ? 'card' : undefined,
      rechargePrice: str('rechargePrice') === 'true' ? true : undefined,
    }
  }, [sp])
}
