import { memo, useState, useMemo, useCallback } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { useAccountActions } from '@/hooks/useAccountActions'
import { Badge, Button, askConfirm } from '../ui'
import type { Account, AccountTag, AccountGroup, AccountLivenessResult } from '@/types/account'
import {
  Check,
  RefreshCw,
  Trash2,
  Edit,
  Info,
  AlertCircle,
  Power,
  RotateCcw,
  ExternalLink,
  Loader2,
  Clock,
  KeyRound,
  FolderOpen,
  Copy,
  Download,
  Zap,
  CloudUpload,
  CloudCheck,
  XCircle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  toRgba,
  generateRowGlowStyle,
  unauthorizedRowStyle,
  getSubscriptionColor,
  getStatusBadgeClass,
  StatusLabelsZh,
  StatusLabelsEn,
  formatTokenExpiry,
  isBannedError
} from './_helpers'

interface AccountListRowProps {
  account: Account
  tags: Map<string, AccountTag>
  groups: Map<string, AccountGroup>
  isSelected: boolean
  /** 能否勾选：批量选择锁定在单一分组，其它分组的账号为 false */
  canSelect: boolean
  /** 本轮批量验活的结果；null = 进行中，undefined = 本轮未参与 */
  livenessResult?: AccountLivenessResult | null
  onEdit: () => void
  onShowDetail: () => void
}

// 紧凑列表行 — 视觉对齐 AccountCard
// 高度 ~72px，圆角 + 流光边框 + 标签光晕 + 封禁红色背景
import { canRefreshUpstreamCredential } from '../../types/account'
import { hasUpstreamKiroCredential } from '../../types/account'
import { ExportDialog } from './ExportDialog'

function AccountListRowComponent({
  account,
  tags,
  groups,
  isSelected,
  canSelect,
  livenessResult,
  onEdit,
  onShowDetail
}: AccountListRowProps): React.ReactNode {
  const {
    removeAccount,
    checkAccountStatus,
    refreshAccountToken,
    toggleSelection,
    maskEmail,
    maskNickname,
    privacyMode,
    usagePrecision,
    updateAccountStatus,
    accountProxyBindings,
    proxyPool,
    unbindAccountFromProxy
  } = useAccountsStore()

  // 该账号绑定的代理（如有）
  const boundProxy = useMemo(() => {
    const proxyId = accountProxyBindings[account.id]
    if (!proxyId) return null
    return proxyPool.get(proxyId) || null
  }, [accountProxyBindings, account.id, proxyPool])

  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  // 单账号验活 / 推送到本机 Admin（与卡片视图共用同一份逻辑）
  const { runLiveness, livenessPending, pushToAdmin, pushState, pushError, canPush, pushTitle } =
    useAccountActions(account, isEn)

  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isClearingSuspended, setIsClearingSuspended] = useState(false)
  const [emailCopied, setEmailCopied] = useState(false)
  // 单账号导出（复用批量导出对话框，格式选项一致）
  const [showExportDialog, setShowExportDialog] = useState(false)

  // 封禁判定
  const isUnauthorized = isBannedError(account.lastError)

  // 标签
  const accountTags = useMemo(
    () => (account.tags || []).map((id) => tags.get(id)).filter((t): t is AccountTag => !!t),
    [account.tags, tags]
  )
  const tagColors = useMemo(() => accountTags.map((t) => t.color), [accountTags])

  // 分组
  const accountGroup = useMemo(() => {
    if (!account.groupId) return null
    return groups.get(account.groupId) || null
  }, [account.groupId, groups])

  // 显示名（昵称优先 + 隐私模式 mask）
  // privacyMode 必须进依赖：maskEmail / maskNickname 是 store 的稳定引用，
  // 内部读 get().privacyMode，少了这个依赖 memo 会一直返回首次计算的结果，
  // 表现为隐私模式开关点了没反应。
  const displayName = useMemo(() => {
    if (account.nickname) return maskNickname(account.nickname)
    return maskEmail(account.email)
  }, [account.nickname, account.email, maskEmail, maskNickname, privacyMode])

  const maskedEmail = useMemo(
    () => maskEmail(account.email),
    [account.email, maskEmail, privacyMode]
  )

  // Credits
  const formatUsage = (value: number): string => {
    if (usagePrecision) {
      return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    }
    return Math.floor(value).toLocaleString()
  }
  const percentUsed = account.usage.percentUsed * 100
  const isHighUsage = percentUsed > 80
  const isCritical = percentUsed > 100

  // 到期
  const daysRemaining = account.subscription.daysRemaining
  const isExpiringSoon = daysRemaining !== undefined && daysRemaining <= 7
  const isTokenExpiringSoon =
    account.credentials.expiresAt !== undefined &&
    account.credentials.expiresAt - Date.now() < 5 * 60 * 1000

  // === 行外层样式合成 ===
  // 优先级：active 流光 > 封禁红色 > 标签光晕
  const rowStyle = useMemo(() => {
    if (account.isActive) return {} // active-glow-border class 处理
    if (isUnauthorized) return unauthorizedRowStyle
    if (tagColors.length > 0) return generateRowGlowStyle(tagColors)
    return {}
  }, [account.isActive, isUnauthorized, tagColors])

  // === Handlers ===
  const handleRefresh = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (isRefreshing || !canRefreshUpstreamCredential(account.credentials)) return
      setIsRefreshing(true)
      try {
        await refreshAccountToken(account.id)
        await checkAccountStatus(account.id)
      } finally {
        setIsRefreshing(false)
      }
    },
    [account.id, isRefreshing, refreshAccountToken, checkAccountStatus]
  )

  const handleDelete = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      const confirmed = await askConfirm({
        title: isEn ? `Delete account "${account.email}"?` : `确定删除账号 "${account.email}"？`,
        description: isEn
          ? 'The account and its stored credentials are removed from this app. This cannot be undone.'
          : '该账号及其保存的凭据将从本应用中移除，此操作不可恢复。',
        confirmText: isEn ? 'Delete' : '删除',
        cancelText: isEn ? 'Cancel' : '取消',
        tone: 'danger'
      })
      if (!confirmed) return
      removeAccount(account.id)
    },
    [account.id, account.email, isEn, removeAccount]
  )

  const handleClearSuspended = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (isClearingSuspended) return
      setIsClearingSuspended(true)
      try {
        updateAccountStatus(account.id, 'active', undefined)
      } finally {
        setIsClearingSuspended(false)
      }
    },
    [account.id, isClearingSuspended, updateAccountStatus]
  )

  const handleCopyEmail = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const text = account.email || account.userId || ''
      if (text) {
        navigator.clipboard.writeText(text)
        setEmailCopied(true)
        setTimeout(() => setEmailCopied(false), 1500)
      }
    },
    [account.email, account.userId]
  )

  // ============ 渲染 ============

  return (
    <div
      className={cn(
        'group relative flex items-center gap-3 pl-3 pr-3 py-2.5 rounded-xl border bg-solid-card transition-all duration-300 cursor-pointer overflow-hidden',
        'hover:shadow-md',
        account.isActive && 'active-glow-border border-transparent',
        !account.isActive &&
          !isUnauthorized &&
          tagColors.length === 0 &&
          !isSelected &&
          'border-border'
      )}
      style={rowStyle}
      onClick={() => canSelect && toggleSelection(account.id)}
    >
      {/* 选中态独立覆盖层 — 避免被多标签 rowStyle 的 backgroundImage 覆盖 */}
      {isSelected && !account.isActive && !isUnauthorized && (
        <div className="absolute inset-0 pointer-events-none rounded-[inherit] ring-2 ring-inset ring-primary/60 bg-primary/[0.08] z-10" />
      )}

      {/* Checkbox — 已锁定其它分组时置灰不可点，从源头阻止跨分组混选 */}
      <div
        className={cn(
          'flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition-colors',
          isSelected
            ? 'bg-primary border-primary text-primary-foreground cursor-pointer'
            : canSelect
              ? 'border-muted-foreground/30 hover:border-primary cursor-pointer'
              : 'border-muted-foreground/15 opacity-40 cursor-not-allowed'
        )}
        title={
          canSelect
            ? undefined
            : isEn
              ? 'Selection is locked to one group. Clear the selection to pick accounts from another group.'
              : '批量选择已锁定在同一分组，如需选其它分组的账号请先清除当前选中'
        }
        onClick={(e) => {
          e.stopPropagation()
          if (canSelect) toggleSelection(account.id)
        }}
      >
        {isSelected && <Check className="h-3 w-3" />}
      </div>

      {/* === 邮箱列（固定 280px） === */}
      <div className="w-[280px] flex-shrink-0 flex flex-col gap-1 min-w-0">
        {/* 上行：邮箱/昵称 + 副邮箱 */}
        <div className="flex items-center gap-2 min-w-0">
          <h3
            className={cn(
              'font-semibold text-sm truncate cursor-pointer transition-colors min-w-0',
              emailCopied ? 'text-success' : 'text-foreground/90 hover:text-primary'
            )}
            title={`${displayName} (${isEn ? 'Click to copy' : '点击复制'})`}
            onClick={handleCopyEmail}
          >
            {emailCopied ? (isEn ? 'Copied!' : '已复制!') : displayName}
          </h3>
          {account.nickname && (
            <span className="text-xs text-muted-foreground truncate min-w-0" title={account.email}>
              {maskedEmail}
            </span>
          )}
        </div>

        {/* 下行：分组 + 标签 + 错误 + 复制 */}
        <div className="flex items-center gap-1.5 min-w-0 text-2xs overflow-hidden">
          {accountGroup && (
            <span
              className="px-1.5 py-0.5 rounded flex items-center gap-1 flex-shrink-0"
              style={{ color: accountGroup.color, backgroundColor: accountGroup.color + '15' }}
            >
              <FolderOpen className="w-3 h-3" />
              {accountGroup.name}
            </span>
          )}
          {accountTags.slice(0, 4).map((tag) => {
            const tagColor = toRgba(tag.color)
            return (
              <span
                key={tag.id}
                className="px-1.5 py-0.5 rounded-md font-medium flex-shrink-0 border"
                style={{
                  backgroundColor: tagColor.replace(/[\d.]+\)$/, '0.12)'),
                  color: tagColor,
                  borderColor: tagColor.replace(/[\d.]+\)$/, '0.30)')
                }}
              >
                {tag.name}
              </span>
            )
          })}
          {accountTags.length > 4 && (
            <span className="px-1.5 py-0.5 text-muted-foreground bg-muted rounded-sm flex-shrink-0">
              +{accountTags.length - 4}
            </span>
          )}

          {/* 错误信息（非封禁，因为封禁已用红色徽章显示） */}
          {account.lastError && !isUnauthorized && (
            <span
              className="text-destructive truncate flex-1 min-w-0 italic"
              title={account.lastError}
            >
              {account.lastError}
            </span>
          )}

          {/* 复制邮箱小图标 */}
          {!account.nickname && (
            <button
              type="button"
              onClick={handleCopyEmail}
              className="ml-auto text-muted-foreground/60 hover:text-primary transition-colors flex-shrink-0"
              title={isEn ? 'Copy email' : '复制邮箱'}
            >
              <Copy className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* === 徽章固定列（紧贴邮箱列，每个徽章等宽确保跨行对齐） === */}
      <div className="flex-shrink-0 flex items-center gap-1.5">
        {/* 验活徽标：仅参与本轮批量验活的账号显示，就地反映结果 */}
        {livenessResult !== undefined && (
          <div
            className={cn(
              'text-2xs font-medium h-5 px-2 rounded-full flex items-center justify-center gap-1 min-w-[56px]',
              livenessResult === null
                ? 'bg-muted text-muted-foreground'
                : livenessResult.success
                  ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                  : 'bg-destructive/12 text-destructive'
            )}
            title={
              livenessResult === null
                ? isEn
                  ? 'Liveness test running...'
                  : '验活进行中...'
                : livenessResult.success
                  ? `${isEn ? 'Alive' : '存活'} · ${livenessResult.latencyMs}ms${
                      livenessResult.content ? ` · ${livenessResult.content}` : ''
                    }`
                  : livenessResult.error || (isEn ? 'Liveness test failed' : '验活失败')
            }
          >
            {livenessResult === null ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                {isEn ? 'Test' : '验活'}
              </>
            ) : livenessResult.success ? (
              <>
                <Zap className="h-3 w-3" />
                {livenessResult.latencyMs}ms
              </>
            ) : (
              <>
                <XCircle className="h-3 w-3" />
                {isEn ? 'Dead' : '失败'}
              </>
            )}
          </div>
        )}

        {/* 状态徽章（min-w 保持等宽） */}
        <div
          className={cn(
            'text-2xs font-medium h-5 px-2 rounded-full flex items-center justify-center gap-1 min-w-[52px]',
            getStatusBadgeClass(account.status, isUnauthorized)
          )}
        >
          {account.status === 'refreshing' && <Loader2 className="h-3 w-3 animate-spin" />}
          {isUnauthorized && <AlertCircle className="h-3 w-3" />}
          {isUnauthorized ? (
            <span
              className="cursor-pointer hover:underline"
              onClick={(e) => {
                e.stopPropagation()
                onShowDetail()
              }}
            >
              {isEn ? 'Banned' : '已封禁'}
            </span>
          ) : (
            (isEn ? StatusLabelsEn : StatusLabelsZh)[account.status] || account.status
          )}
        </div>

        {/* 订阅徽章（min-w 保持等宽，PRO+/FREE 视觉对齐） */}
        <Badge
          className={cn(
            'text-white text-2xs h-5 px-2 border-0 min-w-[90px] flex items-center justify-center',
            getSubscriptionColor(account.subscription.type, account.subscription.title)
          )}
        >
          {account.subscription.title || account.subscription.type}
        </Badge>

        {/* IDP（固定宽度，所有账号视觉对齐） */}
        <Badge
          variant="outline"
          className="text-2xs h-5 px-1.5 text-muted-foreground font-normal border-muted-foreground/30 bg-muted/30 min-w-[72px] flex items-center justify-center"
        >
          {account.idp}
        </Badge>

        {/* 代理绑定徽章：可点击解绑（仅有绑定时显示） */}
        {boundProxy && (
          <Badge
            variant="outline"
            className={cn(
              'text-2xs h-5 px-1.5 font-normal cursor-pointer group transition-colors',
              boundProxy.enabled && boundProxy.status !== 'dead'
                ? 'border-cyan-500/40 text-cyan-700 dark:text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20'
                : 'border-amber-500/40 text-amber-700 dark:text-amber-300 bg-amber-500/10'
            )}
            title={`${isEn ? 'Bound proxy:' : '绑定代理：'} ${boundProxy.host}:${boundProxy.port}${boundProxy.label ? ` (${boundProxy.label})` : ''}\n${isEn ? 'Click to unbind' : '点击解绑'}`}
            onClick={async (e) => {
              e.stopPropagation()
              const confirmed = await askConfirm({
                title: isEn
                  ? `Unbind ${account.email} from ${boundProxy.host}:${boundProxy.port}?`
                  : `解绑 ${account.email} 与 ${boundProxy.host}:${boundProxy.port}？`,
                description: isEn
                  ? 'Requests for this account will stop using the bound outbound proxy.'
                  : '该账号的请求将不再经由此出口代理。',
                confirmText: isEn ? 'Unbind' : '解绑',
                cancelText: isEn ? 'Cancel' : '取消',
                tone: 'warning'
              })
              if (confirmed) {
                unbindAccountFromProxy(account.id)
              }
            }}
          >
            <span className="opacity-70 group-hover:hidden">⇄</span>
            <span className="hidden group-hover:inline">✕</span>
            <span className="ml-0.5 max-w-[80px] truncate inline-block align-middle">
              {boundProxy.host}
            </span>
          </Badge>
        )}

        {/* Active 容器（始终保留宽度，确保后续元素位置固定） */}
        <div className="w-[60px] flex items-center">
          {account.isActive && (
            <Badge className="h-5 px-2 bg-success text-white border-0 hover:bg-success/90 text-2xs flex items-center justify-center w-full">
              <Power className="h-2.5 w-2.5 mr-0.5" />
              {isEn ? 'Active' : '当前'}
            </Badge>
          )}
        </div>
      </div>

      {/* === 弹性间隔（吃剩余空间） === */}
      <div className="flex-1 min-w-0" />

      {/* === Credits 区（中右） === */}
      <div className="flex-shrink-0 w-40 flex flex-col gap-0.5 px-2">
        <div className="flex items-center justify-between text-2xs">
          <span className="text-muted-foreground">{isEn ? 'Usage' : '使用量'}</span>
          <span
            className={cn(
              'font-mono font-medium tabular-nums',
              isCritical ? 'text-destructive' : isHighUsage ? 'text-warning' : 'text-foreground'
            )}
          >
            {percentUsed.toFixed(usagePrecision ? 2 : 0)}%
            {isCritical && (
              <span className="ml-1 text-3xs text-destructive font-semibold">
                +{(percentUsed - 100).toFixed(usagePrecision ? 2 : 0)}%
              </span>
            )}
          </span>
        </div>
        {(() => {
          if (isCritical) {
            const planRatioPct = (100 / percentUsed) * 100
            return (
              <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                <div
                  className="absolute inset-y-0 left-0 bg-warning transition-all duration-300"
                  style={{ width: `${planRatioPct}%` }}
                />
                <div
                  className="absolute inset-y-0 right-0 bg-destructive transition-all duration-300"
                  style={{ left: `${planRatioPct}%` }}
                />
              </div>
            )
          }
          return (
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
              <div
                className={cn(
                  'absolute inset-y-0 left-0 transition-all duration-300',
                  isHighUsage ? 'bg-warning' : 'bg-primary'
                )}
                style={{ width: `${Math.min(percentUsed, 100)}%` }}
              />
            </div>
          )
        })()}
        <div className="flex justify-between text-3xs text-muted-foreground pt-0.5">
          <span className={cn(isCritical && 'text-destructive font-semibold')}>
            {formatUsage(account.usage.current)}
            {isCritical && ` (+${formatUsage(account.usage.current - account.usage.limit)})`}
          </span>
          <span>/ {formatUsage(account.usage.limit)}</span>
        </div>
      </div>

      {/* === 时间信息区 === */}
      <div className="flex-shrink-0 hidden lg:flex flex-col leading-tight gap-0.5 text-2xs text-muted-foreground w-28">
        <div
          className="flex items-center gap-1"
          title={isEn ? 'Subscription days left' : '订阅剩余天数'}
        >
          <Clock className="h-3 w-3" />
          <span className={isExpiringSoon ? 'text-warning font-medium' : ''}>
            {daysRemaining !== undefined
              ? isEn
                ? `${daysRemaining}d`
                : `${daysRemaining}天`
              : '-'}
          </span>
        </div>
        <div
          className="flex items-center gap-1"
          title={
            account.credentials.expiresAt
              ? new Date(account.credentials.expiresAt).toLocaleString(isEn ? 'en-US' : 'zh-CN')
              : isEn
                ? 'Unknown'
                : '未知'
          }
        >
          <KeyRound className="h-3 w-3" />
          <span className={isTokenExpiringSoon ? 'text-destructive font-medium' : ''}>
            {account.credentials.expiresAt
              ? formatTokenExpiry(account.credentials.expiresAt, isEn)
              : '-'}
          </span>
        </div>
      </div>

      {/* === 操作区（常驻显示） === */}
      <div className="flex-shrink-0 flex items-center gap-0.5 border-l border-border/40 pl-2 ml-1">
        {isUnauthorized && (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-warning hover:bg-warning/10"
              onClick={handleClearSuspended}
              disabled={isClearingSuspended}
              title={isEn ? 'Reset Suspended' : '重置封禁状态'}
            >
              {isClearingSuspended ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
            </Button>
            <a
              href="https://support.aws.amazon.com/#/contacts/kiro"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-primary hover:bg-primary/10"
              onClick={(e) => e.stopPropagation()}
              title={isEn ? 'Contact Support' : '联系支持'}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </>
        )}

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={handleRefresh}
          disabled={
            isRefreshing ||
            account.status === 'refreshing' ||
            !canRefreshUpstreamCredential(account.credentials)
          }
          title={isEn ? 'Check account info' : '检查账户信息'}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className={cn(
            'h-7 w-7',
            livenessPending
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400'
          )}
          onClick={(e) => {
            e.stopPropagation()
            runLiveness()
          }}
          disabled={livenessPending || !hasUpstreamKiroCredential(account.credentials)}
          title={
            isEn
              ? 'Liveness test (send a real message to the model)'
              : '验活（给模型发一条真实消息）'
          }
        >
          {livenessPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Zap className="h-3.5 w-3.5" />
          )}
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className={cn(
            'h-7 w-7',
            pushState === 'created' || pushState === 'existing'
              ? 'text-emerald-600 dark:text-emerald-400'
              : pushState === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={(e) => {
            e.stopPropagation()
            pushToAdmin()
          }}
          disabled={!canPush || pushState === 'pushing'}
          title={pushError ? `${pushTitle} · ${pushError}` : pushTitle}
        >
          {pushState === 'pushing' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : pushState === 'created' || pushState === 'existing' ? (
            <CloudCheck className="h-3.5 w-3.5" />
          ) : (
            <CloudUpload className="h-3.5 w-3.5" />
          )}
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            setShowExportDialog(true)
          }}
          title={isEn ? 'Export this account' : '导出该账号'}
        >
          <Download className="h-3.5 w-3.5" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            onShowDetail()
          }}
          title={isEn ? 'Details' : '详情'}
        >
          <Info className="h-3.5 w-3.5" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
          title={isEn ? 'Edit' : '编辑'}
        >
          <Edit className="h-3.5 w-3.5" />
        </Button>

        {!account.isActive && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 hover:bg-destructive/10 hover:text-destructive"
            onClick={handleDelete}
            title={isEn ? 'Delete' : '删除'}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* 封禁角标（与卡片同款） */}
      {account.isActive && isUnauthorized && (
        <div className="banned-badge" title={isEn ? 'Banned' : '已封禁'} />
      )}

      {/* 单账号导出弹窗 —— 走 portal，但 React 合成事件仍沿组件树冒泡，
          需拦住 click 否则会触发行的 toggleSelection */}
      <div onClick={(e) => e.stopPropagation()}>
        <ExportDialog
          open={showExportDialog}
          onClose={() => setShowExportDialog(false)}
          accounts={[account]}
          selectedCount={1}
        />
      </div>
    </div>
  )
}

export const AccountListRow = memo(AccountListRowComponent)
