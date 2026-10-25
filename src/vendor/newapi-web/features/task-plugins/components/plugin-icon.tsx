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
import { Puzzle } from 'lucide-react'

export function PluginIcon(props: {
  plugin?: { key?: string; name?: string; icon?: string | null }
  icon?: string | null
  size?: number
  className?: string
}) {
  const size = props.size ?? 16
  return <Puzzle className={props.className} style={{ width: size, height: size }} aria-hidden='true' />
}
