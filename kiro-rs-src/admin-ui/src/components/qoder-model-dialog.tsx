import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getQoderModelCatalog, setQoderEnabledModels, setQoderModelOverrides } from '@/api/credentials'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { extractErrorMessage } from '@/lib/utils'
import type { QoderCatalogModel, QoderModelOverride } from '@/types/api'

const CATALOG_QUERY_KEY = ['qoder-model-catalog'] as const

const formatWindow = (n: number) =>
  n <= 0 ? '未知' : n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(2))}M` : `${Math.round(n / 1000)}K`

/** 官方客户端的强度叫法 */
const EFFORT_LABELS: Record<string, string> = {
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  ultracode: 'Ultracode',
}

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

/** 编辑中的配置：空串表示用默认 */
interface Draft {
  alias: string
  contextWindow: string
  effort: string
}

const toDraft = (o: QoderModelOverride): Draft => ({
  alias: o.alias ?? '',
  contextWindow: o.contextWindow ? String(o.contextWindow) : '',
  effort: o.effort ?? '',
})

const fromDraft = (d: Draft): QoderModelOverride => ({
  ...(d.alias.trim() ? { alias: d.alias.trim() } : {}),
  ...(d.contextWindow ? { contextWindow: Number(d.contextWindow) } : {}),
  ...(d.effort ? { effort: d.effort } : {}),
})

const sameDraft = (a: Draft, b: Draft) =>
  a.alias.trim() === b.alias.trim() && a.contextWindow === b.contextWindow && a.effort === b.effort

/** 单个模型的别名 / 上下文 / 思考强度 */
function ModelSettings({ model, draft, disabled, onChange }: {
  model: QoderCatalogModel
  draft: Draft
  disabled: boolean
  onChange: (draft: Draft) => void
}) {
  const id = `qoder-model-${model.id}`
  const defaultWindow = model.defaultContextWindow ?? model.contextWindows[model.contextWindows.length - 1]
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      <div className="space-y-1">
        <label htmlFor={`${id}-alias`} className="text-xs text-muted-foreground">对外模型名</label>
        <Input
          id={`${id}-alias`}
          className="h-9 font-mono"
          placeholder={model.id}
          value={draft.alias}
          maxLength={64}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, alias: e.target.value })}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-window`} className="text-xs text-muted-foreground">上下文</label>
        <select
          id={`${id}-window`}
          className={SELECT_CLASS}
          value={draft.contextWindow}
          disabled={disabled || model.contextWindows.length < 2}
          onChange={(e) => onChange({ ...draft, contextWindow: e.target.value })}
        >
          <option value="">默认{defaultWindow ? `（${formatWindow(defaultWindow)}）` : ''}</option>
          {model.contextWindows.map((w) => <option key={w} value={String(w)}>{formatWindow(w)}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-effort`} className="text-xs text-muted-foreground">思考强度</label>
        <select
          id={`${id}-effort`}
          className={SELECT_CLASS}
          value={draft.effort}
          disabled={disabled || model.efforts.length === 0}
          onChange={(e) => onChange({ ...draft, effort: e.target.value })}
        >
          <option value="">跟随请求{model.defaultEffort ? `（默认${EFFORT_LABELS[model.defaultEffort] ?? model.defaultEffort}）` : ''}</option>
          {model.efforts.map((x) => <option key={x} value={x}>{EFFORT_LABELS[x] ?? x}</option>)}
        </select>
      </div>
    </div>
  )
}

/** Qoder 模型目录：勾选输出到 /v1/models，并可配别名、上下文档位、思考强度 */
export function QoderModelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: getQoderModelCatalog,
    enabled: open,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    if (open && data) {
      setSelected(new Set(data.models.filter((m) => m.enabled).map((m) => m.id)))
      setDrafts(Object.fromEntries(data.models.map((m) => [m.id, toDraft(m.override)])))
    }
  }, [open, data])

  const save = useMutation({
    mutationFn: async ({ ids, overrides }: { ids?: string[]; overrides?: Record<string, QoderModelOverride> }) => {
      let catalog = overrides ? await setQoderModelOverrides(overrides) : undefined
      if (ids) catalog = await setQoderEnabledModels(ids)
      return catalog!
    },
    onSuccess: (catalog) => {
      queryClient.setQueryData(CATALOG_QUERY_KEY, catalog)
      toast.success(`已保存，/v1/models 返回 ${catalog.models.filter((m) => m.enabled).length} 个模型`)
    },
    onError: (e) => toast.error(`保存失败：${extractErrorMessage(e)}`),
  })
  const models = useMemo(() => data?.models ?? [], [data])
  const selectionChanged = models.some((m) => m.enabled !== selected.has(m.id))
  const overridesChanged = models.some((m) => drafts[m.id] && !sameDraft(drafts[m.id], toDraft(m.override)))
  const busy = save.isPending || isFetching

  const submit = () => {
    const overrides = Object.fromEntries(
      models.map((m) => [m.id, fromDraft(drafts[m.id] ?? toDraft(m.override))] as const)
        .filter(([, o]) => Object.keys(o).length > 0),
    )
    save.mutate({
      ids: selectionChanged ? [...selected] : undefined,
      overrides: overridesChanged ? overrides : undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!save.isPending) onOpenChange(value) }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Qoder 模型目录</DialogTitle>
          <DialogDescription>
            目录来自 Qoder 上游，每 10 分钟更新。勾选的模型才会出现在 /v1/models；点「设置」可改对外模型名、上下文和思考强度，不填就用原名和上游默认。原名始终可用，auto 始终可用。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setSelected(new Set(models.map((m) => m.id)))} disabled={busy || !data}>全选</Button>
          <Button size="sm" variant="outline" onClick={() => setSelected(new Set())} disabled={busy || !data}>全不选</Button>
          <span className="text-xs text-muted-foreground" role="status">已选 {models.filter((m) => selected.has(m.id)).length} / {models.length}</span>
        </div>
        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground" role="status">正在加载模型目录...</p>
        ) : error ? (
          <p className="text-sm text-destructive" role="alert">加载失败：{extractErrorMessage(error)}</p>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {models.length === 0 && <p className="py-4 text-sm text-muted-foreground">暂无可用模型，请先添加账号。</p>}
            {models.map((model) => {
              const draft = drafts[model.id] ?? toDraft(model.override)
              const isOpen = expanded === model.id
              const alias = draft.alias.trim()
              const tags = [
                draft.contextWindow && formatWindow(Number(draft.contextWindow)),
                draft.effort && `思考${EFFORT_LABELS[draft.effort] ?? draft.effort}`,
              ].filter(Boolean)
              return (
                <div key={model.id} className="rounded-lg border p-3">
                  <div className="flex min-h-10 items-center gap-3">
                    <Checkbox
                      checked={selected.has(model.id)}
                      disabled={busy}
                      aria-label={`选择 ${model.displayName}`}
                      onCheckedChange={(checked) => setSelected((previous) => {
                        const next = new Set(previous)
                        if (checked === true) next.add(model.id)
                        else next.delete(model.id)
                        return next
                      })}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium">
                        {model.displayName}
                        {model.isReasoning && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">思考</span>}
                        {tags.map((t) => <span key={t} className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-normal text-primary">{t}</span>)}
                      </span>
                      <span className="block break-all font-mono text-xs text-muted-foreground">
                        {alias ? <>{alias} <span className="opacity-60">← {model.id}</span></> : model.id}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 text-sm tabular-nums" aria-label="上游用量倍率">
                      {model.priceFactor != null && model.originalPriceFactor != null && model.originalPriceFactor > model.priceFactor && (
                        <del className="text-muted-foreground" aria-label={`原倍率 ${model.originalPriceFactor} 倍`}>{model.originalPriceFactor}×</del>
                      )}
                      <span>{model.priceFactor == null ? '倍率未知' : `${model.priceFactor}×`}</span>
                      {model.isFree && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">免费</span>}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={`上下文 ${model.contextWindow.toLocaleString()} / 输出 ${model.maxOutput.toLocaleString()} tokens`}>
                      {formatWindow(draft.contextWindow ? Number(draft.contextWindow) : model.contextWindow)}
                    </span>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0"
                        aria-expanded={isOpen}
                        aria-controls={`qoder-model-${model.id}-settings`}
                        onClick={() => setExpanded(isOpen ? null : model.id)}
                        disabled={busy}
                      >
                        {isOpen ? '收起' : '设置'}
                      </Button>
                  </div>
                  {isOpen && (
                    <div id={`qoder-model-${model.id}-settings`}>
                      <ModelSettings
                        model={model}
                        draft={draft}
                        disabled={busy}
                        onChange={(next) => setDrafts((previous) => ({ ...previous, [model.id]: next }))}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {data && selected.size === 0 && <p className="text-xs text-amber-700 dark:text-amber-300">保存后 /v1/models 将为空。</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>关闭</Button>
          <Button onClick={submit} disabled={!data || !!error || !(selectionChanged || overridesChanged) || busy}>
            {save.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
