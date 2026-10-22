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
// Plain <pre> code block (no shiki) + copy button.
'use client'
import { createContext, useContext, type ReactNode } from 'react'

import { CopyButton } from '@newapi/components/copy-button'
import { cn } from '@newapi/lib/utils'

const CodeContext = createContext<string>('')

export function CodeBlock(props: { code: string; language?: string; className?: string; children?: ReactNode }) {
  return (
    <CodeContext.Provider value={props.code}>
      <div className={cn('bg-muted/40 relative overflow-hidden rounded-lg border', props.className)}>
        <pre className='overflow-x-auto p-4 font-mono text-xs leading-relaxed'>
          <code data-language={props.language}>{props.code}</code>
        </pre>
        {props.children}
      </div>
    </CodeContext.Provider>
  )
}

export function CodeBlockCopyButton(props: { className?: string }) {
  const code = useContext(CodeContext)
  return (
    <div className={cn('absolute top-2 right-2', props.className)}>
      <CopyButton value={code} />
    </div>
  )
}
