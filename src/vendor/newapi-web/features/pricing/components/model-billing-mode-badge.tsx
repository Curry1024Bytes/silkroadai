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
import { useTranslation } from 'react-i18next'

import { StatusBadge, type StatusVariant } from '@newapi/components/status-badge'
import { cn } from '@newapi/lib/utils'

import { getBillingModeLabelKey } from '../lib/billing-mode'
import { isDynamicPricingModel } from '../lib/dynamic-price'
import type { PricingModel } from '../types'

interface ModelBillingModeBadgeProps {
  model: PricingModel
  appearance?: 'default' | 'caption'
  showPortalBillingMode?: boolean
  className?: string
}

export function ModelBillingModeBadge(props: ModelBillingModeBadgeProps) {
  const { t } = useTranslation()
  const labelKey = getBillingModeLabelKey(props.model)
  const portal = props.model.portal
  const dynamic =
    props.showPortalBillingMode && portal && (
      Object.values(portal.breakdownByTier ?? {}).some((quote) => quote.dynamic) ||
      Object.values(portal.pricesByTier).some((price) => {
        const details = price?.billing_details
        return details?.mode === 'time_token' || details?.mode === 'video_token' ||
          (details?.mode === 'tiered_token' && details.tiers.length > 1) ||
          Boolean(details?.scheduled_discount)
      })
    )
  const label = portal ? dynamic ? t('Dynamic Pricing') : '人民币报价' : t(labelKey)
  const isCaption = props.appearance === 'caption'
  let variant: StatusVariant = 'purple'

  if (dynamic || isDynamicPricingModel(props.model)) {
    variant = 'warning'
  } else if (labelKey === 'Token-based') {
    variant = 'info'
  }

  return (
    <StatusBadge
      label={label}
      variant={variant}
      type={isCaption ? 'text' : undefined}
      copyable={false}
      size='sm'
      className={cn(isCaption && 'text-xs font-normal', props.className)}
    />
  )
}
