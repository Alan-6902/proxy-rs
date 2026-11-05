import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { getAgModelCatalog, scanAgModels, setAgEnabledModels } from '@/api/credentials'
import { useAgAccounts } from '@/hooks/use-credentials'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { extractErrorMessage } from '@/lib/utils'

const CATALOG_QUERY_KEY = ['ag-model-catalog'] as const

export function AntigravityModelDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: getAgModelCatalog,
    enabled: open,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const { data: accountsData } = useAgAccounts(open)
  const accountLabel = (id: number) => accountsData?.accounts.find((account) => account.id === id)?.email.split('@')[0] ?? `#${id}`
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (open && data) setSelected(new Set(data.models.filter((model) => model.enabled).map((model) => model.id)))
  }, [open, data])

  const save = useMutation({
    mutationFn: setAgEnabledModels,
    onSuccess: (catalog) => {
      queryClient.setQueryData(CATALOG_QUERY_KEY, catalog)
      toast.success(`已保存，/v1/models 返回 ${catalog.models.filter((model) => model.enabled).length} 个模型；请在 Magpie 重新获取模型`)
    },
    onError: (e) => toast.error(`保存失败：${extractErrorMessage(e)}`),
  })
  const scan = useMutation({
    mutationFn: scanAgModels,
    onSuccess: ({ models, scan: results }) => {
      queryClient.setQueryData(CATALOG_QUERY_KEY, { models })
      void queryClient.invalidateQueries({ queryKey: ['ag-accounts'] })
      const failed = results.filter((result) => !result.ok)
      if (failed.length === 0) toast.success(`已扫描 ${results.length} 个账号；勾选后保存，按扫描结果为模型分组`)
      else toast.warning(`扫描完成，${failed.length} 个账号失败：${failed.map((result) => result.email).join('、')}`)
    },
    onError: (e) => toast.error(`扫描失败：${extractErrorMessage(e)}`),
  })
  const models = data?.models ?? []
  const changed = models.some((model) => model.enabled !== selected.has(model.id))
  const busy = save.isPending || scan.isPending || isFetching

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!save.isPending) onOpenChange(value) }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Antigravity 模型目录</DialogTitle>
          <DialogDescription>
            账号或订阅有变动时先扫描账号，再勾选保存。保存时按扫描结果给模型分组，请求只发给支持该模型的账号；Magpie 重新获取模型时只会收到勾选项。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setSelected(new Set(models.map((model) => model.id)))} disabled={busy || !data}>全选</Button>
          <Button size="sm" variant="outline" onClick={() => setSelected(new Set())} disabled={busy || !data}>全不选</Button>
          <Button size="sm" variant="outline" onClick={() => scan.mutate()} disabled={busy}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${scan.isPending ? 'animate-spin' : ''}`} />{scan.isPending ? '扫描中...' : '扫描账号'}
          </Button>
          <span className="text-xs text-muted-foreground" role="status">已选 {models.filter((model) => selected.has(model.id)).length} / {models.length}</span>
        </div>
        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground" role="status">正在加载模型目录...</p>
        ) : error ? (
          <p className="text-sm text-destructive" role="alert">加载失败：{extractErrorMessage(error)}</p>
        ) : (
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {models.length === 0 && <p className="py-4 text-sm text-muted-foreground">暂无可用模型，请先更新账号额度。</p>}
            {models.map((model) => (
              <label key={model.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border p-3 hover:bg-muted/50">
                <Checkbox
                  checked={selected.has(model.id)}
                  disabled={busy}
                  onCheckedChange={(checked) => setSelected((previous) => {
                    const next = new Set(previous)
                    if (checked === true) next.add(model.id)
                    else next.delete(model.id)
                    return next
                  })}
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-medium">{model.displayName}</span>
                  <span className="block break-all font-mono text-xs text-muted-foreground">{model.id}</span>
                  {model.accountIds.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1" aria-label="支持该模型的账号">
                      {model.accountIds.map((id) => (
                        <span key={id} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{accountLabel(id)}</span>
                      ))}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={model.contextWindow > 0 ? `上下文容量：${model.contextWindow.toLocaleString()} tokens` : '上游未提供上下文容量'}>
                  {model.contextWindow <= 0 ? '未知' : model.contextWindow >= 1_000_000 ? `${Number((model.contextWindow / 1_000_000).toFixed(2))}M` : `${Math.round(model.contextWindow / 1000)}K`}
                </span>
              </label>
            ))}
          </div>
        )}
        {data && selected.size === 0 && <p className="text-xs text-amber-700 dark:text-amber-300">保存后模型列表将为空，Magpie 将无法从列表选择模型。</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>关闭</Button>
          <Button onClick={() => save.mutate([...selected])} disabled={!data || !!error || !changed || busy}>
            {save.isPending ? '保存中...' : '保存勾选'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
