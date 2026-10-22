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
import { usePlazaRuntime } from '@newapi/lib/plaza-runtime'

/** Shape-compatible with new-api's `useStatus()`: the pricing feature reads
 *  `status.price`, `status.usd_exchange_rate` and `status.data.server_address`. */
export function useStatus() {
  const config = usePlazaRuntime((s) => s.config)
  return {
    status: {
      ...config,
      data: { server_address: config.server_address, serverAddress: config.server_address },
    } as Record<string, unknown> & typeof config,
    loading: false,
    error: null,
  }
}
