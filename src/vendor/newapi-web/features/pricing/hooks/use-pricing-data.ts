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
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { useStatus } from '@newapi/hooks/use-status'
import { requireServerSuccess } from '@newapi/lib/server-error-message'

import { getPricing } from '../api'
import type { PricingData } from '../types'

export function usePricingData(initialData?: PricingData) {
  const { status } = useStatus()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['pricing', initialData?.portal_viewer_key ?? 'anonymous'],
    queryFn: async () => requireServerSuccess(await getPricing()),
    initialData,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  })

  // Ensure rates never reach zero to prevent division errors
  const priceRate = useMemo(
    () => Math.max((status?.price as number) ?? 1, 0.001),
    [status?.price]
  )
  const usdExchangeRate = useMemo(
    () => Math.max((status?.usd_exchange_rate as number) ?? priceRate, 0.001),
    [status?.usd_exchange_rate, priceRate]
  )

  const current = error ? undefined : data
  const models = useMemo(() => {
    if (!current?.data || !current?.vendors) return []

    const vendorMap = new Map(current.vendors.map((v) => [v.id, v]))

    return current.data.map((model) => {
      const vendor = model.vendor_id
        ? vendorMap.get(model.vendor_id)
        : undefined
      return {
        ...model,
        key: model.model_name,
        vendor_name: vendor?.name,
        vendor_icon: vendor?.icon,
        vendor_description: vendor?.description,
        group_ratio: current.group_ratio,
      }
    })
  }, [current])

  return {
    models,
    vendors: current?.vendors ?? [],
    groupRatio: current?.group_ratio ?? {},
    usableGroup: current?.usable_group ?? {},
    endpointMap: current?.supported_endpoint ?? {},
    autoGroups: current?.auto_groups ?? [],
    portalTariffs: Boolean(initialData?.portal_tiers || current?.portal_tiers),
    isLoading,
    error,
    refetch,
    priceRate,
    usdExchangeRate,
  }
}
