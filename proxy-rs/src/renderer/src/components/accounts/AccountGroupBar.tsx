/**
 * 分组平铺行 —— 全选 + 分组 chips + 管理分组入口
 *
 * 独立于 AccountToolbar 渲染：工具栏被挤在页面标题右侧，
 * 这一行放在 header 之外才能顶到内容区最左侧对齐账号列表。
 */
import { useMemo } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { toRgba } from './_helpers'
import { cn } from '@/lib/utils'
import { CheckSquare, Square, Check, Users, Inbox, ArrowRightLeft, FolderPlus } from 'lucide-react'

interface AccountGroupBarProps {
  onManageGroups: () => void
}

export function AccountGroupBar({ onManageGroups }: AccountGroupBarProps): React.ReactNode {
  const {
    accounts,
    groups,
    selectedIds,
    selectionGroupId,
    selectAll,
    deselectAll,
    getFilteredAccounts,
    moveAccountsToGroup,
    activeGroupTab,
    setActiveGroupTab
  } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  const filteredAccounts = getFilteredAccounts()
  const filteredCount = filteredAccounts.length
  const selectedCount = selectedIds.size

  /** 当前分组内可选的账号数（锁定分组后只有同组账号能被勾） */
  const selectableCount = useMemo(() => {
    if (selectedCount === 0) return filteredCount
    return filteredAccounts.filter((a) => a.groupId === selectionGroupId).length
  }, [filteredAccounts, filteredCount, selectedCount, selectionGroupId])
  const isAllSelected = selectedCount > 0 && selectedCount === selectableCount

  // 分组 Tab 计数（全部 / 未分组 / 各分组）
  const tabCounts = useMemo(() => {
    const all = accounts.size
    let ungrouped = 0
    const byGroup = new Map<string, number>()
    for (const acc of accounts.values()) {
      if (!acc.groupId) {
        ungrouped++
      } else {
        byGroup.set(acc.groupId, (byGroup.get(acc.groupId) || 0) + 1)
      }
    }
    return { all, ungrouped, byGroup }
  }, [accounts])

  // 用户分组按 order 升序
  const sortedGroups = useMemo(
    () => Array.from(groups.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [groups]
  )

  // 选中账号落在各分组的数量（用于 chip 上的"批量移入"状态）
  const selectedGroupCounts = useMemo(() => {
    const counts = new Map<string | undefined, number>()
    for (const id of selectedIds) {
      const acc = accounts.get(id)
      if (!acc) continue
      counts.set(acc.groupId, (counts.get(acc.groupId) || 0) + 1)
    }
    return counts
  }, [selectedIds, accounts])

  const handleMoveToGroup = (groupId: string | undefined): void => {
    if (selectedIds.size === 0) return
    moveAccountsToGroup(Array.from(selectedIds), groupId)
  }

  const handleToggleSelectAll = (): void => {
    if (isAllSelected) {
      deselectAll()
    } else {
      selectAll()
    }
  }

  // 分组 chip：点击切换视图，hover 行尾 ⇄ 批量移入选中账号
  const renderGroupChip = ({
    key,
    isActive,
    onSwitch,
    icon,
    label,
    count,
    accentColor,
    moveAction
  }: {
    key: string
    isActive: boolean
    onSwitch: () => void
    icon: React.ReactNode
    label: string
    count: number
    accentColor?: string
    moveAction?: { isAllInGroup: boolean; onMove: () => void }
  }): React.ReactNode => (
    <div key={key} className="group relative flex-shrink-0">
      <button
        type="button"
        onClick={onSwitch}
        className={cn(
          'flex items-center gap-1.5 h-7 pl-2 rounded-lg border text-xs font-medium transition-colors',
          moveAction ? 'pr-7' : 'pr-2',
          isActive
            ? accentColor
              ? ''
              : 'bg-primary text-primary-foreground border-primary'
            : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted'
        )}
        style={
          isActive && accentColor
            ? {
                color: accentColor,
                backgroundColor: accentColor.replace(/[\d.]+\)$/, '0.12)'),
                borderColor: accentColor.replace(/[\d.]+\)$/, '0.45)')
              }
            : undefined
        }
        title={label}
      >
        {icon}
        <span className="truncate max-w-[120px]">{label}</span>
        <span
          className={cn(
            'text-2xs tabular-nums',
            isActive
              ? accentColor
                ? 'opacity-80'
                : 'text-primary-foreground/80'
              : 'text-muted-foreground/70'
          )}
        >
          {count}
        </span>
        {isActive && <Check className="h-3 w-3" />}
      </button>
      {/* 批量移入按钮 — 仅选中账号时出现 */}
      {moveAction && (
        <button
          type="button"
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 rounded flex items-center justify-center transition-all',
            'opacity-0 group-hover:opacity-100',
            moveAction.isAllInGroup
              ? 'bg-success/15 text-success'
              : 'bg-background/80 text-muted-foreground hover:text-primary hover:bg-primary/10 shadow-sm'
          )}
          onClick={(e) => {
            e.stopPropagation()
            moveAction.onMove()
          }}
          title={
            moveAction.isAllInGroup
              ? isEn
                ? 'All selected already in this group'
                : '所有选中账号已在该组'
              : isEn
                ? `Move ${selectedCount} selected here`
                : `移动选中 ${selectedCount} 个账号到此`
          }
        >
          {moveAction.isAllInGroup ? (
            <Check className="h-3 w-3" />
          ) : (
            <ArrowRightLeft className="h-3 w-3" />
          )}
        </button>
      )}
    </div>
  )

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 -mb-0.5 flex-shrink-0">
      {/* 全选 / 取消全选 —— 作用范围是当前分组筛选出的账号 */}
      <button
        type="button"
        onClick={handleToggleSelectAll}
        disabled={filteredCount === 0}
        className={cn(
          'flex items-center gap-1.5 h-7 px-2 rounded-lg border text-xs font-medium transition-colors flex-shrink-0',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          selectedCount > 0
            ? 'border-primary/45 bg-primary/12 text-primary'
            : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted'
        )}
        title={
          isAllSelected
            ? isEn
              ? 'Deselect all'
              : '取消全选'
            : isEn
              ? 'Select all in current group'
              : '全选当前分组'
        }
      >
        {isAllSelected ? (
          <CheckSquare className="h-3.5 w-3.5 flex-shrink-0" />
        ) : (
          <Square className="h-3.5 w-3.5 flex-shrink-0" />
        )}
        <span>
          {selectedCount > 0
            ? isEn
              ? `${selectedCount} sel`
              : `已选 ${selectedCount}`
            : isEn
              ? 'All'
              : '全选'}
        </span>
      </button>

      <div className="w-px h-5 bg-border flex-shrink-0" />

      {renderGroupChip({
        key: 'all',
        isActive: activeGroupTab === 'all',
        onSwitch: () => setActiveGroupTab('all'),
        icon: <Users className="h-3.5 w-3.5 flex-shrink-0" />,
        label: isEn ? 'All' : '全部',
        count: tabCounts.all
      })}
      {renderGroupChip({
        key: 'ungrouped',
        isActive: activeGroupTab === 'ungrouped',
        onSwitch: () => setActiveGroupTab('ungrouped'),
        icon: <Inbox className="h-3.5 w-3.5 flex-shrink-0" />,
        label: isEn ? 'Ungrouped' : '未分组',
        count: tabCounts.ungrouped,
        moveAction:
          selectedCount > 0
            ? {
                isAllInGroup: (selectedGroupCounts.get(undefined) || 0) === selectedCount,
                onMove: () => handleMoveToGroup(undefined)
              }
            : undefined
      })}
      {sortedGroups.map((group) => {
        const color = group.color ? toRgba(group.color) : undefined
        const selCountInGroup = selectedGroupCounts.get(group.id) || 0
        return renderGroupChip({
          key: group.id,
          isActive: activeGroupTab === group.id,
          onSwitch: () => setActiveGroupTab(group.id),
          icon: (
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: color || 'var(--color-muted-foreground)' }}
            />
          ),
          label: group.name,
          count: tabCounts.byGroup.get(group.id) || 0,
          accentColor: color,
          moveAction:
            selectedCount > 0
              ? {
                  isAllInGroup: selCountInGroup === selectedCount,
                  onMove: () => handleMoveToGroup(group.id)
                }
              : undefined
        })
      })}

      {/* 管理分组入口 */}
      <button
        type="button"
        onClick={onManageGroups}
        className="flex items-center gap-1 h-7 px-2 rounded-lg border border-dashed border-border text-2xs text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors flex-shrink-0"
        title={isEn ? 'Manage groups' : '管理分组'}
      >
        <FolderPlus className="h-3.5 w-3.5" />
        <span>{isEn ? 'Manage' : '管理分组'}</span>
      </button>

      {selectedCount > 0 && (
        <span className="ml-1 text-2xs text-muted-foreground italic flex-shrink-0">
          {isEn
            ? 'Hover a group and click ⇄ to move selected here'
            : '悬停分组点 ⇄ 可把选中账号移入'}
        </span>
      )}
    </div>
  )
}
