/**
 * 页内批量验活面板
 * 结果不在这里逐条列出——直接打在账号行/卡片上（见 AccountListRow / AccountCard 的验活徽标），
 * 这里只负责参数（模型 / 消息）、启停与总体进度，以及对失败账号的批量善后。
 */
import { useMemo, useState } from 'react'
import {
  Zap,
  Loader2,
  Square as StopIcon,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RotateCcw,
  Flag,
  Trash2,
  X
} from 'lucide-react'
import { Button, Badge, Input, Label, askConfirm } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { useLivenessModels } from '@/hooks/useLivenessModels'
import { cn } from '@/lib/utils'

/** 默认测试消息：让模型只回一个短 token，尽量少耗 credits */
const DEFAULT_LIVENESS_MESSAGE = 'Hi, reply with "pong" only.'

interface LivenessPanelProps {
  /** 关闭面板 */
  onClose: () => void
}

export function LivenessPanel({ onClose }: LivenessPanelProps): React.ReactNode {
  const {
    selectedIds,
    getFilteredAccounts,
    livenessResults,
    livenessRunning,
    runLivenessBatch,
    stopLivenessBatch,
    clearLivenessResults,
    updateAccount,
    removeAccounts
  } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const { model, setModel, modelOptions, cachedCount, loading, reload } = useLivenessModels()
  const [message, setMessage] = useState(DEFAULT_LIVENESS_MESSAGE)

  // 目标账号：与工具栏一致 —— 选中了就用选中集合，没选中就整组
  const targetIds = useMemo(() => {
    if (selectedIds.size > 0) return Array.from(selectedIds)
    return getFilteredAccounts().map((a) => a.id)
  }, [selectedIds, getFilteredAccounts])

  const stats = useMemo(() => {
    let done = 0,
      ok = 0,
      fail = 0
    for (const r of livenessResults.values()) {
      if (r === null) continue
      done++
      if (r.success) ok++
      else fail++
    }
    return { done, ok, fail, total: livenessResults.size }
  }, [livenessResults])

  const failedIds = useMemo(
    () =>
      Array.from(livenessResults.entries())
        .filter(([, r]) => r && !r.success)
        .map(([id]) => id),
    [livenessResults]
  )

  const handleRun = (): void => {
    void runLivenessBatch({
      ids: targetIds,
      model: model.trim(),
      message: message.trim() || undefined
    })
  }

  const handleRetestFailed = (): void => {
    if (failedIds.length === 0) return
    void runLivenessBatch({
      ids: failedIds,
      model: model.trim(),
      message: message.trim() || undefined,
      keepExisting: true
    })
  }

  /** 把失败账号标记为 error 状态，账号行会显示红色错误态 */
  const markFailedAsError = (): void => {
    for (const id of failedIds) {
      const r = livenessResults.get(id)
      updateAccount(id, {
        status: 'error',
        lastError: r?.error || (isEn ? 'Liveness test failed' : '测活失败')
      })
    }
  }

  const deleteFailed = async (): Promise<void> => {
    if (failedIds.length === 0) return
    const ok = await askConfirm({
      title: isEn
        ? `Delete ${failedIds.length} account(s) that failed the liveness test?`
        : `确定删除 ${failedIds.length} 个测活失败的账号？`,
      description: isEn
        ? 'These accounts and their stored credentials are removed from this app. This cannot be undone.'
        : '这些账号及其保存的凭据将从本应用中移除，此操作不可恢复。',
      confirmText: isEn ? `Delete ${failedIds.length}` : `删除 ${failedIds.length} 个`,
      cancelText: isEn ? 'Cancel' : '取消',
      tone: 'danger',
      holdToConfirmMs: failedIds.length >= 10 ? 2000 : 0
    })
    if (ok) removeAccounts(failedIds)
  }

  return (
    <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.04] px-3 py-2.5 space-y-2.5 flex-shrink-0">
      {/* 标题行 */}
      <div className="flex items-center gap-2">
        <Zap className="h-4 w-4 text-emerald-600 flex-shrink-0" />
        <span className="text-sm font-medium">{isEn ? 'Batch Liveness Test' : '批量验活'}</span>
        <span className="text-2xs text-muted-foreground">
          {selectedIds.size > 0
            ? isEn
              ? `${targetIds.length} selected`
              : `选中 ${targetIds.length} 个`
            : isEn
              ? `all ${targetIds.length} in current group`
              : `当前分组全部 ${targetIds.length} 个`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {stats.total > 0 && (
            <>
              <Badge variant="outline" className="h-6 text-2xs text-green-600 border-green-200">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                {stats.ok}
              </Badge>
              {stats.fail > 0 && (
                <Badge variant="outline" className="h-6 text-2xs text-red-600 border-red-200">
                  <XCircle className="h-3 w-3 mr-1" />
                  {stats.fail}
                </Badge>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-2xs text-muted-foreground"
                onClick={clearLivenessResults}
                disabled={livenessRunning}
                title={isEn ? 'Clear results' : '清除结果'}
              >
                {isEn ? 'Clear' : '清除结果'}
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            title={isEn ? 'Close panel' : '收起面板'}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 参数行 —— 两列的 Label 行套同高容器（h-4），否则模型列的刷新按钮会把
          Label 行撑高，与测试消息列的裸 Label 基线错位 */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1 w-[200px]">
          <div className="flex h-4 items-center justify-between">
            <Label className="text-2xs">{isEn ? 'Model' : '模型'}</Label>
            <button
              type="button"
              onClick={() => void reload()}
              disabled={loading}
              className="flex items-center gap-1 text-3xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              title={
                isEn ? 'Refresh models from proxy cache / Kiro' : '从代理缓存 / Kiro 刷新可用模型'
              }
            >
              <RefreshCw className={cn('h-2.5 w-2.5', loading && 'animate-spin')} />
              {cachedCount > 0 ? (isEn ? `${cachedCount} cached` : `${cachedCount} 缓存`) : ''}
            </button>
          </div>
          <Input
            list="account-liveness-models"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={livenessRunning}
            placeholder="claude-sonnet-4.5"
            className="h-8 text-xs font-mono"
          />
          <datalist id="account-liveness-models">
            {modelOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>

        <div className="space-y-1 flex-1 min-w-[200px]">
          <div className="flex h-4 items-center">
            <Label className="text-2xs">{isEn ? 'Test message' : '测试消息'}</Label>
          </div>
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={livenessRunning}
            placeholder={DEFAULT_LIVENESS_MESSAGE}
            className="h-8 text-xs"
          />
        </div>

        {livenessRunning ? (
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-8" disabled>
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              {isEn ? 'Testing' : '测试中'} {stats.done}/{stats.total}
            </Button>
            <Button variant="destructive" size="sm" className="h-8" onClick={stopLivenessBatch}>
              <StopIcon className="h-3.5 w-3.5 mr-1" />
              {isEn ? 'Stop' : '停止'}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            className="h-8"
            onClick={handleRun}
            disabled={targetIds.length === 0 || !model.trim()}
          >
            <Zap className="h-3.5 w-3.5 mr-1" />
            {isEn ? `Test (${targetIds.length})` : `开始验活 (${targetIds.length})`}
          </Button>
        )}
      </div>

      {/* 失败账号善后 */}
      {!livenessRunning && failedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <span className="text-2xs text-red-600 dark:text-red-400 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            {isEn ? `${failedIds.length} failed` : `${failedIds.length} 个失败`}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-2xs"
              onClick={handleRetestFailed}
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              {isEn ? 'Retest failed' : '重测失败'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-2xs"
              onClick={markFailedAsError}
            >
              <Flag className="h-3 w-3 mr-1" />
              {isEn ? 'Mark as error' : '标记为错误'}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-6 text-2xs"
              onClick={() => void deleteFailed()}
            >
              <Trash2 className="h-3 w-3 mr-1" />
              {isEn ? 'Delete failed' : '删除失败'}
            </Button>
          </div>
        </div>
      )}

      {targetIds.length === 0 && (
        <p className="text-2xs text-amber-600 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {isEn ? 'No accounts in the current group.' : '当前分组没有账号。'}
        </p>
      )}
    </div>
  )
}
