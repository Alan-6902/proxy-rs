import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SerenaPage } from '../../src/renderer/src/components/pages/SerenaPage'
import { ConfirmDialogHost } from '../../src/renderer/src/components/ui'
import { Sidebar } from '../../src/renderer/src/components/layout/Sidebar'
import type { PageType } from '../../src/renderer/src/components/layout/Sidebar'
import { useAccountsStore } from '../../src/renderer/src/store/accounts'
import {
  SERENA_LS_STUCK_MS,
  type SerenaApi,
  type SerenaInstance,
  type SerenaPreview,
  type SerenaSnapshot
} from '../../src/shared/serena'
import '../../src/renderer/src/styles/globals.css'

useAccountsStore.setState({ language: 'zh' })
const params = new URLSearchParams(location.search)
const instances: SerenaInstance[] = Array.from(
  { length: params.has('large') ? 33 : 3 },
  (_, i) => ({
    id: `native:preview${i}`,
    root: `/projects/commerce-${i}/.worktrees/catalog-update`,
    binding: i === 0 ? 'registry-process' : 'candidate',
    backend: 'native-http',
    pid: i === 0 ? 12001 : null,
    started: i === 0 ? 'Mon Oct 19 01:00:00 2026' : null,
    processState: i === 0 ? 'matched' : 'missing',
    port: 39101 + i,
    listening: i === 0,
    cpu: i === 0 ? 0.6 : null,
    rssKiB: i === 0 ? 145408 : null,
    languageServer:
      i === 0
        ? params.has('stuck')
          ? { cpu: 104.2, rssKiB: 2_621_440, busySince: Date.now() - 2 * SERENA_LS_STUCK_MS }
          : { cpu: 0.3, rssKiB: 524_288, busySince: null }
        : null,
    languages: ['typescript', 'rust'],
    recordedStatus: i === 0 ? 'running' : 'stopped',
    exempt: i === 1,
    native: {
      version: '2.0.0',
      url: `http://127.0.0.1:${39101 + i}/mcp`,
      label: `com.proxy-rs.serena.preview${i}`,
      loaded: i === 0,
      blocked: i === 2 ? 'nativeConfigInvalid' : null
    }
  })
)
const snapshot: SerenaSnapshot = {
  sampledAt: Date.now(),
  version: '2.0.0',
  registrationAvailable: !params.has('invalid'),
  partial: params.has('invalid'),
  instances: params.has('invalid') ? [] : instances,
  registeredRoots: instances.map((item) => item.root),
  registrations: [
    { source: '/projects/commerce-0/.mcp.json', name: 'serena', transport: 'http', matches: true }
  ],
  issues: params.has('invalid') ? ['nativeRegistryInvalid'] : []
}
let calls = 0
let action: SerenaPreview['action'] = 'registerProject'
const projectPreview = (languages = ['typescript']): SerenaPreview => ({
  id: 'project-preview',
  action: 'registerProject',
  root: '/projects/new-project',
  pid: null,
  expiresAt: Date.now() + 60000,
  fileCount: 142,
  bytes: 230000,
  languages
})
const api: SerenaApi = {
  snapshot: async () => {
    calls++
    return { success: true, data: { ...snapshot, sampledAt: Date.now() } }
  },
  previewNative: async (id, selected) => {
    action = selected
    return {
      success: true,
      data: {
        id: 'native-preview',
        action,
        root: instances.find((item) => item.id === id)?.root ?? instances[0].root,
        pid: null,
        expiresAt: Date.now() + 60000
      }
    }
  },
  chooseProject: async () => ({ success: true, data: projectPreview() }),
  previewLanguages: async (_id, languages) => {
    action = 'registerProject'
    return { success: true, data: projectPreview(languages) }
  },
  execute: async () => {
    if (params.has('failure')) return { success: false, error: 'stateChanged' }
    if (action === 'unregisterNative') {
      const index = instances.findIndex((item) => !item.native.loaded)
      if (index !== -1) instances.splice(index, 1)
      snapshot.registeredRoots = instances.map((item) => item.root)
    }
    return { success: true, data: { action, outcome: 'completed' } }
  },
  setExempt: async (id, exempt) => {
    const item = instances.find((entry) => entry.id === id)
    if (item) item.exempt = exempt
    return { success: true, data: undefined }
  }
}
Object.defineProperty(window, '__serenaPreviewCalls', { configurable: true, get: () => calls })

export function Preview(): React.JSX.Element {
  const [page, setPage] = useState<PageType>('serena')
  const [collapsed, setCollapsed] = useState(true)
  return (
    <div className="h-screen flex gap-2 p-2 bg-background text-foreground">
      <Sidebar
        currentPage={page}
        onPageChange={setPage}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed(!collapsed)}
      />
      <main className="flex-1 min-w-0 rounded-3xl page-surface overflow-hidden">
        {page === 'serena' ? (
          <SerenaPage api={api} />
        ) : (
          <button onClick={() => setPage('serena')}>返回 Serena（隔离预览，无业务服务）</button>
        )}
      </main>
      <ConfirmDialogHost />
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)
