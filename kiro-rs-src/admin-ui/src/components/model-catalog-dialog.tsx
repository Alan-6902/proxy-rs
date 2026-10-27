import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  useCredentials,
  useModelCatalog,
  useRefreshModelCatalog,
  useSetEnabledModels,
} from '@/hooks/use-credentials'
import { extractErrorMessage } from '@/lib/utils'

interface ModelCatalogDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const formatTokens = (tokens: number) => {
  if (tokens <= 0) return '-'
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}K`
}

/**
 * 模型目录：选账号 → 从 Kiro 拉取 → /v1/models 只输出这次的结果。
 * 多个账号取并集，任一账号失败则保留旧目录。
 */
export function ModelCatalogDialog({ open, onOpenChange }: ModelCatalogDialogProps) {
  const { data: credentialsData } = useCredentials(true)
  const { data: catalog, isLoading } = useModelCatalog(open)
  const refresh = useRefreshModelCatalog()
  const saveEnabled = useSetEnabledModels()
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [enabledFamilies, setEnabledFamilies] = useState<Set<string>>(new Set())

  // 打开或目录变化时，回填上次用的账号与已勾选的模型
  useEffect(() => {
    if (open && catalog) {
      setSelected(new Set(catalog.credentialIds))
      setEnabledFamilies(new Set(catalog.models.filter((m) => m.enabled).map((m) => m.family)))
    }
  }, [open, catalog])

  const toggle = <T,>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T) => {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  const synced = Boolean(catalog?.fetchedAt)
  const enabledChanged =
    catalog !== undefined &&
    catalog.models.some((m) => m.enabled !== enabledFamilies.has(m.family))

  const handleSaveEnabled = () => {
    saveEnabled.mutate([...enabledFamilies], {
      onSuccess: () => toast.success(`/v1/models 现在输出 ${enabledFamilies.size} 个模型`),
      onError: (error) => toast.error(`保存失败：${extractErrorMessage(error)}`),
    })
  }

  const handleRefresh = () => {
    refresh.mutate([...selected], {
      onSuccess: (data) =>
        toast.success(
          `已同步 ${data.upstreamCount} 个模型，/v1/models 输出 ${data.models.filter((m) => m.enabled).length} 个`
        ),
      onError: (error) => toast.error(`同步失败：${extractErrorMessage(error)}`),
    })
  }

  const credentials = credentialsData?.credentials ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>模型目录</DialogTitle>
          <DialogDescription>
            {catalog?.fetchedAt
              ? `上次同步：${new Date(catalog.fetchedAt * 1000).toLocaleString('zh-CN')}（账号 ${catalog.credentialIds.map((id) => `#${id}`).join('、')}，上游共 ${catalog.upstreamCount} 个）`
              : '尚未从 Kiro 同步过，/v1/models 当前输出内置兜底目录'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="text-sm font-medium">用这些账号拉取（结果取并集）</div>
          <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
            {credentials.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs"
              >
                <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(setSelected, c.id)} />
                <span className="font-medium">#{c.id}</span>
                <span className="text-muted-foreground">{c.email || c.authMethod || ''}</span>
                {c.disabled && <span className="text-destructive">已禁用</span>}
              </label>
            ))}
          </div>
          <Button
            onClick={handleRefresh}
            disabled={selected.size === 0 || refresh.isPending}
            size="sm"
            className="h-8 px-3 text-xs"
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refresh.isPending ? 'animate-spin' : ''}`} />
            {refresh.isPending ? '同步中...' : '从 Kiro 同步'}
          </Button>
        </div>

        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">
              勾选的模型出现在 /v1/models（每系列一个：上下文最大、版本最新）
            </div>
            <Button
              onClick={handleSaveEnabled}
              disabled={!synced || !enabledChanged || enabledFamilies.size === 0 || saveEnabled.isPending}
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2.5 text-xs"
            >
              {saveEnabled.isPending ? '保存中...' : `保存勾选（${enabledFamilies.size}）`}
            </Button>
          </div>
          {!synced && (
            <div className="text-xs text-muted-foreground">同步后才能勾选</div>
          )}
          {isLoading ? (
            <div className="py-4 text-center text-sm text-muted-foreground">加载中...</div>
          ) : (
            <div className="max-h-[45vh] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="w-6 py-1" />
                    <th className="py-1 font-medium">模型 ID</th>
                    <th className="py-1 font-medium">上下文</th>
                    <th className="py-1 font-medium">最大输出</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {catalog?.models.map((m) => (
                    <tr key={m.id} className="border-t border-border/50">
                      <td className="py-1">
                        <Checkbox
                          checked={enabledFamilies.has(m.family)}
                          disabled={!synced}
                          onCheckedChange={() => toggle(setEnabledFamilies, m.family)}
                        />
                      </td>
                      <td className="py-1">{m.id}</td>
                      <td className="py-1">{formatTokens(m.contextWindow)}</td>
                      <td className="py-1">{formatTokens(m.maxTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
