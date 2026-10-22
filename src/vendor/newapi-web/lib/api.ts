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
// Every call goes to the portal's same-origin proxy (`/api/portal/models/*`),
// which forwards the whitelisted public new-api endpoints server-side. The
// new-api host never reaches the browser.
export interface ApiRequestConfig {
  params?: Record<string, unknown>
  paramsSerializer?: unknown
  headers?: Record<string, string | null>
  skipErrorHandler?: boolean
}

const PROXY_PREFIX = '/api/portal/models'

function buildUrl(path: string, params?: Record<string, unknown>): string {
  const rel = path.replace(/^\/api/, '')
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      for (const item of v) qs.append(k, String(item))
    } else {
      qs.set(k, String(v))
    }
  }
  const q = qs.toString()
  return `${PROXY_PREFIX}${rel}${q ? `?${q}` : ''}`
}

async function get<T = unknown>(path: string, config: ApiRequestConfig = {}): Promise<{ data: T; status: number }> {
  const res = await fetch(buildUrl(path, config.params), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  const data = (await res.json().catch(() => ({ success: false, message: `HTTP ${res.status}` }))) as T
  return { data, status: res.status }
}

export const api = { get }
