import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Button, Badge, askConfirm } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { AccountFilterPanel } from './AccountFilter'
import {
  Search,
  Plus,
  Upload,
  Download,
  Trash2,
  Tag,
  Loader2,
  Eye,
  EyeOff,
  Filter,
  Check,
  RefreshCw,
  X,
  Minus,
  LayoutGrid,
  List as ListIcon,
  Zap
} from 'lucide-react'

export type AccountViewMode = 'grid' | 'list'

interface AccountToolbarProps {
  onAddAccount: () => void
  onImport: () => void
  onExport: () => void
  viewMode: AccountViewMode
  onViewModeChange: (mode: AccountViewMode) => void
  onManageTags: () => void
  isFilterExpanded: boolean
  onToggleFilter: () => void
  /** 展开/收起页内批量验活面板 */
  onToggleLiveness: () => void
}

export function AccountToolbar({
  onAddAccount,
  onImport,
  onExport,
  viewMode,
  onViewModeChange,
  onManageTags,
  isFilterExpanded,
  onToggleFilter,
  onToggleLiveness
}: AccountToolbarProps): React.ReactNode {
  const {
    filter,
    setFilter,
    selectedIds,
    deselectAll,
    removeAccounts,
    batchRefreshTokens,
    batchCheckStatus,
    getFilteredAccounts,
    getStats,
    privacyMode,
    setPrivacyMode,
    tags,
    accounts,
    addTagToAccounts,
    removeTagFromAccounts
  } = useAccountsStore()

  // 批量刷新 = 先刷 Token 再拉账号信息（用量 / 订阅 / 封禁）
  const [isBatchRefreshing, setIsBatchRefreshing] = useState(false)
  const [showTagMenu, setShowTagMenu] = useState(false)

  const tagMenuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) {
        setShowTagMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const selectedTagStatus = useMemo(() => {
    const selectedAccounts = Array.from(selectedIds)
      .map((id) => accounts.get(id))
      .filter(Boolean)
    const tagCounts = new Map<string, number>()
    selectedAccounts.forEach((acc) => {
      if (acc?.tags) {
        acc.tags.forEach((tagId) => {
          tagCounts.set(tagId, (tagCounts.get(tagId) || 0) + 1)
        })
      }
    })
    return { selectedAccounts, tagCounts, total: selectedAccounts.length }
  }, [selectedIds, accounts])

  // 兼容入口：保持现有调用签名
  const getSelectedAccountsTagStatus = useCallback(() => selectedTagStatus, [selectedTagStatus])

  // 处理标签操作
  const handleAddTag = (tagId: string): void => {
    if (selectedIds.size === 0) return
    addTagToAccounts(Array.from(selectedIds), tagId)
  }

  const handleRemoveTag = (tagId: string): void => {
    if (selectedIds.size === 0) return
    removeTagFromAccounts(Array.from(selectedIds), tagId)
  }

  const handleToggleTag = (tagId: string): void => {
    const { tagCounts, total } = getSelectedAccountsTagStatus()
    const count = tagCounts.get(tagId) || 0

    if (count === total) {
      // 所有选中账户都有此标签，移除
      handleRemoveTag(tagId)
    } else {
      // 部分或无账户有此标签，添加
      handleAddTag(tagId)
    }
  }

  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const stats = getStats()
  const filteredAccounts = getFilteredAccounts()
  const filteredCount = filteredAccounts.length
  const selectedCount = selectedIds.size

  const handleSearch = (value: string): void => {
    setFilter({ ...filter, search: value || undefined })
  }

  /**
   * 批量操作的目标账号：选中了就用选中集合，没选中就作用于当前分组筛选出的全部账号。
   * 「一个都没选 = 整组」比「禁用按钮」更符合日常用法：进入某个分组后直接点刷新即可。
   */
  const batchTargetIds = useMemo(() => {
    if (selectedIds.size > 0) return Array.from(selectedIds)
    return filteredAccounts.map((a) => a.id)
  }, [selectedIds, filteredAccounts])
  const refreshTargetIds = batchTargetIds
  const livenessTargetIds = batchTargetIds

  // 批量刷新 = 先刷 Token，再拉账号信息（用量 / 订阅 / 封禁状态）
  // 顺序不能反：Token 过期时 checkStatus 会整批 401
  const handleBatchRefreshAll = async (): Promise<void> => {
    const ids = refreshTargetIds
    if (ids.length === 0) return
    setIsBatchRefreshing(true)
    try {
      await batchRefreshTokens(ids)
      await batchCheckStatus(ids)
    } finally {
      setIsBatchRefreshing(false)
    }
  }

  const handleBatchDelete = async (): Promise<void> => {
    if (selectedCount === 0) return
    const confirmed = await askConfirm({
      title: isEn
        ? `Delete ${selectedCount} selected account(s)?`
        : `确定要删除选中的 ${selectedCount} 个账号吗？`,
      description: isEn
        ? 'All selected accounts and their stored credentials are removed from this app. This cannot be undone.'
        : '选中的账号及其保存的凭据将从本应用中移除，此操作不可恢复。',
      confirmText: isEn ? `Delete ${selectedCount}` : `删除 ${selectedCount} 个`,
      cancelText: isEn ? 'Cancel' : '取消',
      tone: 'danger',
      // 批量删除影响面大，给一个短冷静期
      holdToConfirmMs: selectedCount >= 10 ? 2000 : 0
    })
    if (confirmed) {
      removeAccounts(Array.from(selectedIds))
    }
  }

  return (
    <div className="flex-1 min-w-0 space-y-3">
      {/* 搜索和主要操作 */}
      <div className="flex items-center gap-3">
        {/* 搜索框 */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder={isEn ? 'Search accounts...' : '搜索账号...'}
            className="w-full pl-9 pr-4 py-2 text-sm rounded-xl bg-[var(--glass-bg-subtle)] backdrop-blur-md border border-[var(--glass-border)] focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
            value={filter.search ?? ''}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>

        {/* 主要操作按钮 - 右对齐 */}
        <div className="flex items-center gap-2 ml-auto">
          {/* 视图切换 (卡片 / 列表) */}
          <div className="flex items-center rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] backdrop-blur-md overflow-hidden">
            <button
              type="button"
              onClick={() => onViewModeChange('grid')}
              title={isEn ? 'Grid view' : '卡片视图'}
              className={`flex items-center justify-center h-8 w-8 transition-colors ${
                viewMode === 'grid'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('list')}
              title={isEn ? 'List view' : '列表视图'}
              className={`flex items-center justify-center h-8 w-8 transition-colors ${
                viewMode === 'list'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              <ListIcon className="h-4 w-4" />
            </button>
          </div>
          <Button onClick={onAddAccount}>
            <Plus className="h-4 w-4 mr-1" />
            {isEn ? 'Add' : '添加账号'}
          </Button>
          <Button variant="outline" onClick={onImport}>
            <Upload className="h-4 w-4 mr-1" />
            {isEn ? 'Import' : '导入'}
          </Button>
          <Button variant="outline" onClick={onExport}>
            <Download className="h-4 w-4 mr-1" />
            {isEn ? 'Export' : '导出'}
          </Button>
        </div>
      </div>

      {/* 统计和选择操作 —— 图标组紧跟统计文字，不做右对齐 */}
      <div className="flex items-center gap-3">
        {/* 统计信息 */}
        <div className="flex items-center gap-4 text-sm flex-shrink-0">
          <span className="text-muted-foreground whitespace-nowrap">
            {isEn ? '' : '共 '}
            <span className="font-medium text-foreground">{stats.total}</span>{' '}
            {isEn ? 'accounts' : '个账号'}
            {filteredCount !== stats.total && (
              <span>
                {isEn ? ', ' : '，已筛选 '}
                <span className="font-medium text-foreground">{filteredCount}</span>{' '}
                {isEn ? 'filtered' : '个'}
              </span>
            )}
          </span>
          {stats.expiringSoonCount > 0 && (
            <Badge variant="destructive" className="gap-1">
              {stats.expiringSoonCount} {isEn ? 'expiring' : '个即将到期'}
            </Badge>
          )}
        </div>

        {/* 选择操作和管理 - 缩小间距 */}
        <div className="flex items-center gap-1">
          {/* 标签下拉菜单 — 纯图标 + tooltip，选中时右上角小红点提示有可操作下拉 */}
          <div className="relative" ref={tagMenuRef}>
            <Button
              variant={showTagMenu ? 'default' : 'ghost'}
              size="icon"
              className="h-8 w-8 relative"
              onClick={() => {
                if (selectedCount > 0) {
                  setShowTagMenu(!showTagMenu)
                } else {
                  onManageTags()
                }
              }}
              title={
                selectedCount > 0
                  ? isEn
                    ? `Set tags for ${selectedCount} selected`
                    : `批量设置 ${selectedCount} 个选中账号的标签`
                  : isEn
                    ? 'Manage tags'
                    : '管理标签'
              }
            >
              <Tag className="h-4 w-4" />
              {selectedCount > 0 && (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
              )}
            </Button>

            {showTagMenu && selectedCount > 0 && (
              <div className="absolute left-0 top-full mt-2 z-50 min-w-[220px] bg-popover border rounded-lg shadow-lg p-2">
                <div className="absolute -top-2 left-4 w-4 h-4 bg-popover border-l border-t rotate-45" />
                <div className="text-xs text-muted-foreground px-2 py-1 mb-1">
                  {isEn
                    ? `${selectedCount} selected (multi)`
                    : `已选 ${selectedCount} 个账户（可多选）`}
                </div>
                <div className="border-t my-1" />

                {/* 标签列表 */}
                <div className="max-h-[300px] overflow-y-auto">
                  {Array.from(tags.values()).map((tag) => {
                    const { tagCounts, total } = getSelectedAccountsTagStatus()
                    const count = tagCounts.get(tag.id) || 0
                    const isAll = count === total
                    const isPartial = count > 0 && count < total

                    return (
                      <button
                        key={tag.id}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-muted text-left"
                        onClick={() => handleToggleTag(tag.id)}
                      >
                        <div
                          className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
                          style={{
                            backgroundColor: isAll ? tag.color || '#888' : 'transparent',
                            borderColor: tag.color || '#888'
                          }}
                        >
                          {isAll && <Check className="h-3 w-3 text-white" />}
                          {isPartial && (
                            <Minus className="h-3 w-3" style={{ color: tag.color || '#888' }} />
                          )}
                        </div>
                        <span className="truncate flex-1">{tag.name}</span>
                        {isPartial && (
                          <span className="text-xs text-muted-foreground">
                            {count}/{total}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>

                {tags.size === 0 && (
                  <div className="text-sm text-muted-foreground px-2 py-2 text-center">
                    {isEn ? 'No tags' : '暂无标签'}
                  </div>
                )}

                <div className="border-t my-1" />
                <button
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-muted text-primary"
                  onClick={() => {
                    setShowTagMenu(false)
                    onManageTags()
                  }}
                >
                  <Plus className="h-4 w-4" />
                  <span>{isEn ? 'Manage tags' : '管理标签'}</span>
                </button>
              </div>
            )}
          </div>

          <Button
            variant={privacyMode ? 'default' : 'ghost'}
            size="icon"
            className="h-8 w-8"
            onClick={() => setPrivacyMode(!privacyMode)}
            title={
              privacyMode
                ? isEn
                  ? 'Disable privacy mode'
                  : '关闭隐私模式'
                : isEn
                  ? 'Enable privacy mode'
                  : '开启隐私模式'
            }
          >
            {privacyMode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          {/* 筛选按钮与气泡 */}
          <div className="relative">
            <Button
              variant={isFilterExpanded ? 'default' : 'ghost'}
              size="icon"
              className="h-8 w-8"
              onClick={onToggleFilter}
              title={isEn ? 'Toggle advanced filter' : '展开/收起高级筛选'}
            >
              <Filter className="h-4 w-4" />
            </Button>
            {/* 筛选气泡面板 */}
            {isFilterExpanded && (
              <div className="absolute left-0 top-full mt-2 z-50 min-w-[600px] bg-popover border rounded-lg shadow-lg">
                {/* 气泡箭头 */}
                <div className="absolute -top-2 left-4 w-4 h-4 bg-popover border-l border-t rotate-45" />
                <AccountFilterPanel />
              </div>
            )}
          </div>

          <div className="w-px h-6 bg-border mx-1" />

          {/* 批量刷新 — 唯一的刷新入口：Token + 账号信息一起刷。
              未选中账号时作用于当前分组筛选出的全部账号。 */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 relative"
            onClick={handleBatchRefreshAll}
            disabled={isBatchRefreshing || refreshTargetIds.length === 0}
            title={
              selectedCount > 0
                ? isEn
                  ? `Refresh ${selectedCount} selected accounts: access token, then usage / subscription / banned status`
                  : `批量刷新选中 ${selectedCount} 个账号：先刷访问令牌，再拉用量 / 订阅 / 封禁状态`
                : isEn
                  ? `Refresh all ${refreshTargetIds.length} accounts in the current group`
                  : `刷新当前分组全部 ${refreshTargetIds.length} 个账号`
            }
          >
            {isBatchRefreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {/* 选中时右上角小红点，与标签 / 代理按钮一致：提示本次操作只作用于选中账号 */}
            {selectedCount > 0 && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
            )}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 relative text-emerald-600 hover:text-emerald-600 hover:bg-emerald-500/10"
            onClick={onToggleLiveness}
            disabled={livenessTargetIds.length === 0}
            title={
              selectedCount > 0
                ? isEn
                  ? `Liveness test ${selectedCount} selected accounts`
                  : `对选中 ${selectedCount} 个账号批量测活`
                : isEn
                  ? `Liveness test all ${livenessTargetIds.length} accounts in the current group`
                  : `对当前分组全部 ${livenessTargetIds.length} 个账号测活`
            }
          >
            <Zap className="h-4 w-4" />
            {selectedCount > 0 && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={handleBatchDelete}
            disabled={selectedCount === 0}
            title={
              selectedCount > 0
                ? isEn
                  ? `Delete ${selectedCount} selected accounts`
                  : `删除选中的 ${selectedCount} 个账号`
                : isEn
                  ? 'Delete (select first)'
                  : '删除选中账号（请先选中账号）'
            }
          >
            <Trash2 className="h-4 w-4" />
          </Button>

          {/* 清除选中（仅多选时显示，独立明确入口） */}
          {selectedCount > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={() => deselectAll()}
              title={isEn ? `Clear ${selectedCount} selected` : `清除 ${selectedCount} 个选中`}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
