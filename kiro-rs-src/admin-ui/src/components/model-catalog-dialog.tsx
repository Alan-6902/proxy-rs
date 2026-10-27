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
import { useCredentials, useModelCatalog, useRefreshModelCatalog } from '@/hooks/use-credentials'
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
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // 打开时默认勾选上次刷新用的账号
  useEffect(() => {
    if (open && catalog) setSelected(new Set(catalog.credentialIds))
  }, [open, catalog])

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleRefresh = () => {
    refresh.mutate([...selected], {
      onSuccess: (data) => toast.success(`已同步 ${data.upstreamCount} 个模型，对外提供 ${data.models.length} 个`),
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
                <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} />
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
          <div className="text-sm font-medium">/v1/models 输出（每系列一个：上下文最大、版本最新）</div>
          {isLoading ? (
            <div className="py-4 text-center text-sm text-muted-foreground">加载中...</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">模型 ID</th>
                  <th className="py-1 font-medium">上下文</th>
                  <th className="py-1 font-medium">最大输出</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {catalog?.models.map((m) => (
                  <tr key={m.id} className="border-t border-border/50">
                    <td className="py-1">{m.id}</td>
                    <td className="py-1">{formatTokens(m.contextWindow)}</td>
                    <td className="py-1">{formatTokens(m.maxTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
