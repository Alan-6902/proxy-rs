import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  FolderPlus,
  Network,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  ShieldCheck,
  Square,
  Trash2
} from 'lucide-react'
import { Badge, Button, Card, Input, PageHeader, Switch, askConfirm } from '../ui'
import { useTranslation } from '../../hooks/useTranslation'
import {
  SERENA_CONFIRM_HOLD_MS,
  SERENA_LS_STUCK_MS,
  SERENA_REFRESH_MS,
  type SerenaApi,
  type SerenaNativeAction,
  type SerenaInstance,
  type SerenaPreview,
  type SerenaSnapshot
} from '../../../../shared/serena'

const SERVICE_ACTIONS: Array<{
  action: SerenaNativeAction
  labelKey: string
  icon: typeof Play
}> = [
  { action: 'startNative', labelKey: 'cardStart', icon: Play },
  { action: 'stopNative', labelKey: 'cardStop', icon: Square },
  { action: 'restartNative', labelKey: 'cardRestart', icon: RotateCw },
  { action: 'unregisterNative', labelKey: 'cardRemove', icon: Trash2 }
]

function serviceStatus(item: SerenaInstance): {
  key: string
  variant: 'success' | 'destructive' | 'outline' | 'secondary'
} {
  if (item.native.blocked) return { key: 'statusBlocked', variant: 'destructive' }
  if (item.processState === 'matched') return { key: 'statusRunning', variant: 'success' }
  if (item.processState === 'missing') return { key: 'statusStopped', variant: 'outline' }
  if (item.processState === 'mismatch') return { key: 'statusMismatch', variant: 'destructive' }
  return { key: 'unknown', variant: 'secondary' }
}

function nativeActionDisabled(
  item: SerenaInstance,
  action: SerenaNativeAction,
  busy: boolean
): boolean {
  if (action === 'unregisterNative') return busy || item.native.loaded
  return (
    busy ||
    (action === 'startNative') === item.native.loaded ||
    Boolean(
      item.native.blocked &&
      !(action === 'stopNative' && item.native.blocked === 'nativeLegacyConflict')
    )
  )
}

function ServiceCard({
  item,
  busy,
  s,
  onAction,
  onExempt
}: {
  item: SerenaInstance
  busy: boolean
  s: (key: string, params?: Record<string, string | number>) => string
  onAction: (item: SerenaInstance, action: SerenaNativeAction) => void
  onExempt: (item: SerenaInstance, exempt: boolean) => void
}): React.JSX.Element {
  const name = item.root?.split('/').filter(Boolean).at(-1) ?? s('unknown')
  const status = serviceStatus(item)
  const memory = item.rssKiB === null ? '—' : `${(item.rssKiB / 1024).toFixed(0)} MiB`
  const listening =
    item.listening === null
      ? s('unknown')
      : item.listening
        ? `127.0.0.1:${item.port}`
        : s('notListening')
  const binding = item.binding === 'registry-process' ? s('confirmed') : s('candidate')
  const busyMs =
    item.languageServer?.busySince == null ? 0 : Date.now() - item.languageServer.busySince
  const stuck =
    busyMs >= SERENA_LS_STUCK_MS
      ? s('languageServerStuck', { minutes: Math.floor(busyMs / 60_000) })
      : null
  return (
    <Card variant="glass-strong" className="flex h-full min-w-0 flex-col p-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold" title={name}>
          {name}
        </h3>
        <Badge variant={status.variant} className="shrink-0 rounded-full px-2 py-0 text-[10px]">
          {s(status.key)}
        </Badge>
      </div>
      <p
        className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
        title={item.root ?? s('unknown')}
      >
        {item.root ?? s('unknown')}
      </p>
      <div className="mt-2 flex min-w-0 flex-wrap gap-1">
        <Badge variant="secondary" className="rounded-full px-2 py-0 text-[10px]">
          {s(item.backend)}
        </Badge>
        <Badge variant="outline" className="max-w-full truncate rounded-full px-2 py-0 text-[10px]">
          {item.languages.join(', ') || s('unknown')}
        </Badge>
        {item.exempt && (
          <Badge variant="outline" className="rounded-full px-2 py-0 text-[10px]">
            {s('exemptOn')}
          </Badge>
        )}
      </div>
      <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">{s('memory')}</span>
          <strong className="tabular-nums">{memory}</strong>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
          <span className="truncate">{listening}</span>
          <span className="shrink-0">CPU {item.cpu ?? '—'}%</span>
        </div>
        {item.languageServer && (
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
            <span className="truncate">{s('languageServer')}</span>
            <span className="shrink-0">
              {(item.languageServer.rssKiB / 1024).toFixed(0)} MiB · CPU {item.languageServer.cpu}%
            </span>
          </div>
        )}
      </div>
      <p className="mt-2 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <ShieldCheck className="size-3 shrink-0" />
        <span className="truncate" title={binding}>
          PID {item.pid ?? '—'} · {binding}
        </span>
      </p>
      <div className="mt-auto flex items-center gap-1 border-t border-border pt-2">
        {SERVICE_ACTIONS.map(({ action, labelKey, icon: Icon }) => (
          <Button
            key={action}
            variant={action === 'startNative' && !item.native.loaded ? 'default' : 'outline'}
            size="icon"
            className={`h-8 w-8 ${action === 'unregisterNative' ? 'text-destructive hover:text-destructive' : ''}`}
            disabled={nativeActionDisabled(item, action, busy)}
            aria-label={s(labelKey)}
            title={
              action === 'unregisterNative'
                ? s(item.native.loaded ? 'removeStopFirst' : 'removeHelp')
                : action === 'startNative'
                  ? s(labelKey)
                  : `${s(labelKey)} · ${s('nativeNote')}`
            }
            onClick={() => onAction(item, action)}
          >
            <Icon />
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <label
            htmlFor={`serena-exempt-${item.id}`}
            className="text-[10px] text-muted-foreground"
            title={s('exemptHelp')}
          >
            {s('exemptToggle')}
          </label>
          <Switch
            id={`serena-exempt-${item.id}`}
            checked={item.exempt}
            disabled={busy}
            onCheckedChange={(checked) => onExempt(item, checked)}
          />
        </div>
      </div>
      {item.native.blocked && (
        <div
          role="status"
          className="mt-2 flex items-start gap-1.5 text-[11px] text-destructive"
          title={s(`issues.${item.native.blocked}`)}
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span className="line-clamp-2">{s(`issues.${item.native.blocked}`)}</span>
        </div>
      )}
      {stuck && (
        <div
          role="status"
          className="mt-2 flex items-start gap-1.5 text-[11px] text-warning"
          title={stuck}
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span className="line-clamp-3">{stuck}</span>
        </div>
      )}
    </Card>
  )
}

export function SerenaPage({ api = window.api.serena }: { api?: SerenaApi }): React.JSX.Element {
  const { t, actualLanguage } = useTranslation()
  const [snapshot, setSnapshot] = useState<SerenaSnapshot | null>(null)
  const [tab, setTab] = useState<'instances' | 'configuration'>('instances')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const visibleError =
    error ??
    loadError ??
    (snapshot?.issues.includes('nativeRegistryInvalid') ? 'nativeRegistryInvalid' : null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [registration, setRegistration] = useState<SerenaPreview | null>(null)
  const [languages, setLanguages] = useState('')
  const mounted = useRef(false)
  const sequence = useRef(0)
  const pending = useRef(false)
  const refreshQueued = useRef(false)
  const invalidate = useCallback(() => {
    sequence.current++
  }, [])
  const s = (key: string, params?: Record<string, string | number>): string =>
    t(`serena.${key}`, params)
  const date = (value: number): string =>
    new Date(value).toLocaleString(actualLanguage === 'en' ? 'en-US' : 'zh-CN')
  const refresh: () => Promise<void> = useCallback(async () => {
    if (document.hidden || !mounted.current) return
    if (pending.current) {
      refreshQueued.current = true
      return
    }
    pending.current = true
    refreshQueued.current = false
    const current = ++sequence.current
    setLoading(true)
    try {
      const result = await api.snapshot()
      if (!mounted.current || current !== sequence.current) return
      if (result.success) {
        setSnapshot(result.data)
        setLoadError(null)
      } else setLoadError(result.error)
    } catch {
      if (mounted.current && current === sequence.current) setLoadError('sourceUnavailable')
    } finally {
      pending.current = false
      if (mounted.current) setLoading(false)
      if (refreshQueued.current && mounted.current && !document.hidden)
        queueMicrotask(() => void refresh())
    }
  }, [api])
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setInterval> | undefined
    const visibility = (): void => {
      if (timer) clearInterval(timer)
      timer = undefined
      if (document.hidden) {
        invalidate()
        return
      }
      void refresh()
      timer = setInterval(() => void refresh(), SERENA_REFRESH_MS)
    }
    visibility()
    document.addEventListener('visibilitychange', visibility)
    return () => {
      mounted.current = false
      invalidate()
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [refresh, invalidate])

  const confirm = async (preview: SerenaPreview): Promise<void> => {
    if (preview.action !== 'startNative') {
      const title = s('confirmTitle', { action: s(preview.action) })
      const description =
        preview.action === 'registerProject'
          ? s('confirmAuthorize', {
              root: preview.root,
              files: preview.fileCount ?? 0,
              size: ((preview.bytes ?? 0) / 1024 / 1024).toFixed(1),
              languages: preview.languages?.join(', ') ?? s('unknown')
            })
          : preview.action === 'unregisterNative'
            ? s('confirmRemove', { root: preview.root })
            : s('confirmNative', { root: preview.root, action: s(preview.action) })
      if (
        !(await askConfirm({
          title,
          description,
          confirmText: t('common.confirm'),
          cancelText: t('common.cancel'),
          tone: ['unregisterNative', 'stopNative', 'restartNative'].includes(preview.action)
            ? 'danger'
            : undefined,
          holdToConfirmMs: ['unregisterNative', 'stopNative', 'restartNative'].includes(
            preview.action
          )
            ? SERENA_CONFIRM_HOLD_MS
            : undefined
        }))
      )
        return
    }
    const result = await api.execute(preview.id)
    if (result.success && preview.action === 'registerProject') setRegistration(null)
    if (!result.success) {
      if (result.error !== 'cancelled') setError(result.error)
    } else
      setNotice(
        result.data.outcome === 'uncertain'
          ? 'uncertain'
          : result.data.action === 'unregisterNative'
            ? 'removed'
            : result.data.action.endsWith('Native')
              ? 'nativeCompleted'
              : 'completed'
      )
  }
  const act = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await operation()
    } catch {
      setError('sourceUnavailable')
    } finally {
      if (mounted.current) {
        setBusy(false)
        void refresh()
      }
    }
  }
  const nativeAction = (item: SerenaInstance, action: SerenaNativeAction): void => {
    void act(async () => {
      const result = await api.previewNative(item.id, action)
      if (!result.success) {
        setError(result.error)
        return
      }
      await confirm(result.data)
    })
  }
  const setExempt = (item: SerenaInstance, exempt: boolean): void => {
    void act(async () => {
      const result = await api.setExempt(item.id, exempt)
      if (!result.success) setError(result.error)
    })
  }
  const authorize = (): void => {
    void act(async () => {
      const result = await api.chooseProject()
      if (!result.success) {
        setError(result.error)
        return
      }
      if (result.data) {
        setRegistration(result.data)
        setLanguages(result.data.languages?.join(', ') ?? '')
      }
    })
  }
  const instances = snapshot?.instances ?? []
  const running = instances.filter((item) => item.processState === 'matched')
  const rss = running.reduce((sum, item) => sum + (item.rssKiB ?? 0), 0)
  const filtered = instances
    .filter((item) => {
      const matches = `${item.root ?? ''} ${item.pid ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase())
      return (
        matches &&
        (filter === 'all' ||
          (filter === 'running' ? item.processState === 'matched' : item.backend === filter))
      )
    })
    .sort(
      (a, b) =>
        Number(b.processState === 'matched') - Number(a.processState === 'matched') ||
        (a.root ?? '').localeCompare(b.root ?? '')
    )

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 space-y-5" aria-busy={loading}>
      <PageHeader
        icon={Network}
        title={s('title')}
        description={s('description')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={authorize}
              disabled={busy || !snapshot?.registrationAvailable}
            >
              <FolderPlus className="size-4 mr-2" />
              {s('authorize')}
            </Button>
            <Button variant="outline" onClick={() => void refresh()} disabled={loading || busy}>
              <RefreshCw
                className={`size-4 mr-2 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`}
              />
              {s('refresh')}
            </Button>
          </div>
        }
      />
      <div className="space-y-2">
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          {[
            [s('liveCount'), snapshot && !snapshot.partial ? String(running.length) : '—'],
            [
              s('registeredCount'),
              snapshot && !snapshot.partial ? String(snapshot.registeredRoots.length) : '—'
            ],
            [s('memory'), snapshot && !snapshot.partial ? `${(rss / 1024).toFixed(0)} MiB` : '—']
          ].map(([title, value]) => (
            <div key={title} className="flex items-baseline gap-2">
              <dt className="text-muted-foreground">{title}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <details className="group text-xs text-muted-foreground">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
            {s('collectionDetails')}
            <ChevronDown aria-hidden className="size-3 group-open:rotate-180" />
          </summary>
          <div className="pt-1 space-y-1 leading-relaxed">
            <p>{s('memoryNote')}</p>
            <p>{s('scope')}</p>
            {snapshot && (
              <p className="tabular-nums">
                {s('sampled')} · {date(snapshot.sampledAt)}
                {snapshot.partial ? ` · ${s('issues.partial')}` : ''}
              </p>
            )}
          </div>
        </details>
      </div>
      {registration && (
        <form
          className="rounded-xl border border-border bg-card p-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void act(async () => {
              const result = await api.previewLanguages(
                registration.id,
                languages.split(/[\s,]+/).filter(Boolean)
              )
              if (!result.success) {
                setError(result.error)
                return
              }
              setRegistration(result.data)
              await confirm(result.data)
            })
          }}
        >
          <h2 className="font-semibold">{s('registerProject')}</h2>
          <p className="text-xs font-mono break-all">{registration.root}</p>
          <label className="block text-sm" htmlFor="serena-languages">
            {s('languages')}
          </label>
          <Input
            id="serena-languages"
            value={languages}
            onChange={(event) => setLanguages(event.target.value)}
            aria-describedby="serena-language-help"
            disabled={busy}
          />
          <p id="serena-language-help" className="text-xs text-muted-foreground">
            {s('languageHelp')}
          </p>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !languages.trim()}>
              {s('reviewRegistration')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRegistration(null)}
              disabled={busy}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
      {visibleError && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          {s(`issues.${visibleError}`)}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-xl border border-border bg-muted/50 p-3 text-sm">
          {s(notice)}
        </div>
      )}
      {snapshot && snapshot.issues.length > 0 && (
        <details className="rounded-xl border border-border bg-muted/30 p-3">
          <summary className="cursor-pointer text-sm font-medium">
            <AlertTriangle className="size-4 inline mr-2" />
            {s('warningTitle')} · {snapshot.issues.length}
          </summary>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground list-disc pl-5">
            {snapshot.issues.map((issue) => (
              <li key={issue}>{s(`issues.${issue}`)}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="flex gap-1 border-b border-border" role="tablist" aria-label={s('title')}>
        {(['instances', 'configuration'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`px-4 py-3 text-sm border-b-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${tab === value ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground'}`}
          >
            {s(value)}
          </button>
        ))}
      </div>
      {tab === 'instances' ? (
        <section aria-label={s('instances')} className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search aria-hidden className="size-4 absolute left-3 top-3 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={s('search')}
                aria-label={s('search')}
                className="pl-9"
              />
            </div>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              aria-label={t('common.filter')}
              className="rounded-xl border border-border bg-background px-3 py-2 text-sm"
            >
              {['all', 'running', 'native-http'].map((value) => (
                <option key={value} value={value}>
                  {s(value)}
                </option>
              ))}
            </select>
          </div>
          {!snapshot && (
            <p className="py-10 text-center text-muted-foreground" role="status">
              {loading ? t('common.loading') : s('noInstances')}
            </p>
          )}
          {snapshot && filtered.length === 0 && (
            <p className="py-10 text-center text-muted-foreground">
              {snapshot.partial
                ? s('issues.partial')
                : instances.length
                  ? s('empty')
                  : s('noInstances')}
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 empty:hidden sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {filtered.map((item) => (
              <ServiceCard
                key={item.id}
                item={item}
                busy={busy}
                s={s}
                onAction={nativeAction}
                onExempt={setExempt}
              />
            ))}
          </div>
        </section>
      ) : (
        <section aria-label={s('configuration')} className="space-y-5">
          <dl className="divide-y divide-border">
            {[
              [s('version'), snapshot?.version ?? s('unknown')],
              [
                s('registrationStatus'),
                snapshot?.registrationAvailable ? s('available') : s('unavailable')
              ]
            ].map(([title, value]) => (
              <div
                key={title}
                className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm"
              >
                <dt className="text-muted-foreground">{title}</dt>
                <dd className="font-medium break-all">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="space-y-3">
            <h2 className="font-semibold">{s('sources')}</h2>
            <p className="text-sm text-muted-foreground">{s('sourcesNote')}</p>
            {snapshot?.registrations.length ? (
              snapshot.registrations.map((item, index) => (
                <div key={index} className="border-b border-border py-3 text-sm last:border-b-0">
                  <div className="flex flex-wrap gap-x-2 gap-y-1 font-medium">
                    <span>{item.name}</span>
                    <span className="text-muted-foreground">
                      · {item.transport} ·{' '}
                      {s(item.matches ? 'endpointMatches' : 'endpointMismatch')}
                    </span>
                  </div>
                  <p className="font-mono text-xs break-all mt-1 text-muted-foreground">
                    {item.source}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">{s('noSources')}</p>
            )}
          </div>
          <details className="border-t border-border py-4">
            <summary className="cursor-pointer text-sm font-medium">
              {s('registered')} · {snapshot?.registeredRoots.length ?? '—'}
            </summary>
            <ul className="space-y-2 mt-3 text-xs font-mono break-all">
              {snapshot?.registeredRoots.map((root) => (
                <li key={root}>{root}</li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </div>
  )
}
