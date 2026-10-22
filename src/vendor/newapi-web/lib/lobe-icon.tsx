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
/**
 * LobeHub Icon Loader
 * Dynamically load and render icons from @lobehub/icons
 *
 * Supports:
 * - Basic: "OpenAI", "OpenAI.Color"
 * - Chained properties: "OpenAI.Avatar.type={'platform'}"
 * - Size parameter: getLobeIcon("OpenAI", 20)
 */
import {
  lazy,
  Suspense,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react'

import { IconSub2api } from '@newapi/assets/custom/icon-sub2api'
import { IconWan } from '@newapi/assets/custom/icon-wan'

const CUSTOM_ICONS: Record<string, ComponentType<{ size?: number }>> = {
  Sub2API: IconSub2api,
  Wan: IconWan,
}

// silkroadai portal (2026-10-22): the upstream loader used a template dynamic
// import over the whole @lobehub/icons tree (webpackInclude magic comment), which
// Turbopack cannot narrow. We keep a static registry of the brands our catalog
// actually uses; anything else falls back to the initial-letter avatar.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconModule = { default: ComponentType<any> }
const ICON_LOADERS: Record<string, Record<string, () => Promise<IconModule>>> = {
  Claude: { Mono: () => import('@lobehub/icons/es/Claude/components/Mono.js'), Color: () => import('@lobehub/icons/es/Claude/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Claude/components/Avatar.js') },
  Anthropic: { Mono: () => import('@lobehub/icons/es/Anthropic/components/Mono.js'), Avatar: () => import('@lobehub/icons/es/Anthropic/components/Avatar.js') },
  OpenAI: { Mono: () => import('@lobehub/icons/es/OpenAI/components/Mono.js'), Avatar: () => import('@lobehub/icons/es/OpenAI/components/Avatar.js') },
  DeepSeek: { Mono: () => import('@lobehub/icons/es/DeepSeek/components/Mono.js'), Color: () => import('@lobehub/icons/es/DeepSeek/components/Color.js'), Avatar: () => import('@lobehub/icons/es/DeepSeek/components/Avatar.js') },
  Doubao: { Mono: () => import('@lobehub/icons/es/Doubao/components/Mono.js'), Color: () => import('@lobehub/icons/es/Doubao/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Doubao/components/Avatar.js') },
  ByteDance: { Mono: () => import('@lobehub/icons/es/ByteDance/components/Mono.js'), Color: () => import('@lobehub/icons/es/ByteDance/components/Color.js'), Avatar: () => import('@lobehub/icons/es/ByteDance/components/Avatar.js') },
  Volcengine: { Mono: () => import('@lobehub/icons/es/Volcengine/components/Mono.js'), Color: () => import('@lobehub/icons/es/Volcengine/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Volcengine/components/Avatar.js') },
  Jimeng: { Mono: () => import('@lobehub/icons/es/Jimeng/components/Mono.js'), Color: () => import('@lobehub/icons/es/Jimeng/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Jimeng/components/Avatar.js') },
  Gemini: { Mono: () => import('@lobehub/icons/es/Gemini/components/Mono.js'), Color: () => import('@lobehub/icons/es/Gemini/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Gemini/components/Avatar.js') },
  Google: { Mono: () => import('@lobehub/icons/es/Google/components/Mono.js'), Color: () => import('@lobehub/icons/es/Google/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Google/components/Avatar.js') },
  Hunyuan: { Mono: () => import('@lobehub/icons/es/Hunyuan/components/Mono.js'), Color: () => import('@lobehub/icons/es/Hunyuan/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Hunyuan/components/Avatar.js') },
  Tencent: { Mono: () => import('@lobehub/icons/es/Tencent/components/Mono.js'), Color: () => import('@lobehub/icons/es/Tencent/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Tencent/components/Avatar.js') },
  Kling: { Mono: () => import('@lobehub/icons/es/Kling/components/Mono.js'), Color: () => import('@lobehub/icons/es/Kling/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Kling/components/Avatar.js') },
  Minimax: { Mono: () => import('@lobehub/icons/es/Minimax/components/Mono.js'), Color: () => import('@lobehub/icons/es/Minimax/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Minimax/components/Avatar.js') },
  Hailuo: { Mono: () => import('@lobehub/icons/es/Hailuo/components/Mono.js'), Color: () => import('@lobehub/icons/es/Hailuo/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Hailuo/components/Avatar.js') },
  Moonshot: { Mono: () => import('@lobehub/icons/es/Moonshot/components/Mono.js'), Avatar: () => import('@lobehub/icons/es/Moonshot/components/Avatar.js') },
  Kimi: { Mono: () => import('@lobehub/icons/es/Kimi/components/Mono.js'), Color: () => import('@lobehub/icons/es/Kimi/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Kimi/components/Avatar.js') },
  Ollama: { Mono: () => import('@lobehub/icons/es/Ollama/components/Mono.js'), Avatar: () => import('@lobehub/icons/es/Ollama/components/Avatar.js') },
  Meta: { Mono: () => import('@lobehub/icons/es/Meta/components/Mono.js'), Color: () => import('@lobehub/icons/es/Meta/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Meta/components/Avatar.js') },
  Qwen: { Mono: () => import('@lobehub/icons/es/Qwen/components/Mono.js'), Color: () => import('@lobehub/icons/es/Qwen/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Qwen/components/Avatar.js') },
  Alibaba: { Mono: () => import('@lobehub/icons/es/Alibaba/components/Mono.js'), Color: () => import('@lobehub/icons/es/Alibaba/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Alibaba/components/Avatar.js') },
  Spark: { Mono: () => import('@lobehub/icons/es/Spark/components/Mono.js'), Color: () => import('@lobehub/icons/es/Spark/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Spark/components/Avatar.js') },
  Wenxin: { Mono: () => import('@lobehub/icons/es/Wenxin/components/Mono.js'), Color: () => import('@lobehub/icons/es/Wenxin/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Wenxin/components/Avatar.js') },
  Baidu: { Mono: () => import('@lobehub/icons/es/Baidu/components/Mono.js'), Color: () => import('@lobehub/icons/es/Baidu/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Baidu/components/Avatar.js') },
  XAI: { Mono: () => import('@lobehub/icons/es/XAI/components/Mono.js'), Avatar: () => import('@lobehub/icons/es/XAI/components/Avatar.js') },
  Grok: { Mono: () => import('@lobehub/icons/es/Grok/components/Mono.js'), Avatar: () => import('@lobehub/icons/es/Grok/components/Avatar.js') },
  Yi: { Mono: () => import('@lobehub/icons/es/Yi/components/Mono.js'), Color: () => import('@lobehub/icons/es/Yi/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Yi/components/Avatar.js') },
  Zhipu: { Mono: () => import('@lobehub/icons/es/Zhipu/components/Mono.js'), Color: () => import('@lobehub/icons/es/Zhipu/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Zhipu/components/Avatar.js') },
  Mistral: { Mono: () => import('@lobehub/icons/es/Mistral/components/Mono.js'), Color: () => import('@lobehub/icons/es/Mistral/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Mistral/components/Avatar.js') },
  Midjourney: { Mono: () => import('@lobehub/icons/es/Midjourney/components/Mono.js'), Avatar: () => import('@lobehub/icons/es/Midjourney/components/Avatar.js') },
  Flux: { Mono: () => import('@lobehub/icons/es/Flux/components/Mono.js'), Avatar: () => import('@lobehub/icons/es/Flux/components/Avatar.js') },
  Runway: { Mono: () => import('@lobehub/icons/es/Runway/components/Mono.js'), Avatar: () => import('@lobehub/icons/es/Runway/components/Avatar.js') },
  Luma: { Mono: () => import('@lobehub/icons/es/Luma/components/Mono.js'), Color: () => import('@lobehub/icons/es/Luma/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Luma/components/Avatar.js') },
  Suno: { Mono: () => import('@lobehub/icons/es/Suno/components/Mono.js'), Avatar: () => import('@lobehub/icons/es/Suno/components/Avatar.js') },
  Cohere: { Mono: () => import('@lobehub/icons/es/Cohere/components/Mono.js'), Color: () => import('@lobehub/icons/es/Cohere/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Cohere/components/Avatar.js') },
  Stability: { Mono: () => import('@lobehub/icons/es/Stability/components/Mono.js'), Color: () => import('@lobehub/icons/es/Stability/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Stability/components/Avatar.js') },
  Ideogram: { Mono: () => import('@lobehub/icons/es/Ideogram/components/Mono.js'), Avatar: () => import('@lobehub/icons/es/Ideogram/components/Avatar.js') },
  Vidu: { Mono: () => import('@lobehub/icons/es/Vidu/components/Mono.js'), Color: () => import('@lobehub/icons/es/Vidu/components/Color.js'), Avatar: () => import('@lobehub/icons/es/Vidu/components/Avatar.js') },
}
const LAZY_ICONS = new Map<string, LazyExoticComponent<ComponentType<Record<string, unknown>>>>()

function renderLobeIconFallback(
  name: string,
  size: number | string
): ReactNode {
  return (
    <div
      className='bg-muted text-muted-foreground flex items-center justify-center rounded-full text-xs font-medium'
      style={{ width: size, height: size }}
    >
      {name.charAt(0).toUpperCase() || '?'}
    </div>
  )
}

/**
 * Parse a property value from string to appropriate type
 * @param raw - Raw string value
 * @returns Parsed value (boolean, number, or string)
 */
function parseValue(raw: string | undefined | null): string | number | boolean {
  if (raw == null) return true

  let v = String(raw).trim()

  // Remove curly braces
  if (v.startsWith('{') && v.endsWith('}')) {
    v = v.slice(1, -1).trim()
  }

  // Remove quotes
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1)
  }

  // Boolean
  if (v === 'true') return true
  if (v === 'false') return false

  // Number
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v)

  // Return as string
  return v
}

/**
 * Get LobeHub icon component by name
 * @param iconName - Icon name/description (e.g., "OpenAI", "OpenAI.Color", "Claude.Avatar")
 * @param size - Icon size (default: 20)
 * @returns Icon component or fallback
 *
 * @example
 * getLobeIcon("OpenAI", 24)
 * getLobeIcon("OpenAI.Color", 20)
 * getLobeIcon("Claude.Avatar.type={'platform'}", 32)
 */
export function getLobeIcon(
  iconName: string | undefined | null,
  size: number = 20
): ReactNode {
  const trimmedName = typeof iconName === 'string' ? iconName.trim() : ''
  const fallback = renderLobeIconFallback(trimmedName, size)
  if (!trimmedName) return fallback

  const segments = trimmedName.split('.')
  const baseKey = segments[0]
  const CustomIcon = CUSTOM_ICONS[baseKey]
  if (CustomIcon) return <CustomIcon size={size} />

  const loaders = ICON_LOADERS[baseKey]
  if (!loaders) return fallback

  const requested = segments[1]
  const variant = requested && loaders[requested] ? requested : 'Mono'
  const propStartIndex =
    segments.length > 1 && /^[A-Z]/.test(segments[1]) ? 2 : 1
  const cacheKey = `${baseKey}.${variant}`
  let IconComponent = LAZY_ICONS.get(cacheKey)
  if (!IconComponent) {
    const load = loaders[variant] ?? loaders.Mono
    IconComponent = lazy(() =>
      load().catch(() => ({
        default: (props: Record<string, unknown>) =>
          renderLobeIconFallback(
            baseKey,
            typeof props.size === 'number' || typeof props.size === 'string'
              ? props.size
              : 20
          ),
      }))
    )
    LAZY_ICONS.set(cacheKey, IconComponent)
  }

  // Parse chained properties (e.g., "type={'platform'}", "shape='square'")
  const props: Record<string, string | number | boolean> = {}

  for (let i = propStartIndex; i < segments.length; i++) {
    const seg = segments[i]
    if (!seg) continue

    const eqIdx = seg.indexOf('=')
    if (eqIdx === -1) {
      props[seg.trim()] = true
      continue
    }

    const key = seg.slice(0, eqIdx).trim()
    const valRaw = seg.slice(eqIdx + 1).trim()
    props[key] = parseValue(valRaw)
  }

  // Set size if not explicitly specified in the string
  if (props.size == null && size != null) {
    props.size = size
  }

  return (
    <Suspense
      fallback={renderLobeIconFallback(
        baseKey,
        typeof props.size === 'number' || typeof props.size === 'string'
          ? props.size
          : size
      )}
    >
      <IconComponent {...props} />
    </Suspense>
  )
}

// The selector uses the same installed icon registry as the renderer.
export function getLobeIconNames(): string[] {
  const names = Object.entries(ICON_LOADERS).flatMap(([id, variants]) =>
    variants.Color ? [id, `${id}.Color`] : [id]
  )
  return [...new Set([...names, ...Object.keys(CUSTOM_ICONS)])].sort()
}
