import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, ServerCog, Wallet, X } from 'lucide-react'
import {
  DEFAULT_KSK_HUNTER_CONFIG,
  KSK_HUNTER_CHANNEL,
  KSK_HUNTER_CHANNEL_LABEL,
  KSK_HUNTER_CHANNEL_REQUIRES_API_KEY,
  type KskHunterChannel,
  type KskHunterConfig,
  type KskHunterSecretInput,
  type KskHunterSnapshot
} from '../../../../shared/kskHunter'
import { useAccountsStore } from '../../store/accounts'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Switch
} from '../ui'

const UNGROUPED_OPTION = '__ungrouped__'
const GENERIC_BALANCE_URL_PLACEHOLDER = 'https://.../api/balance?token=...'
const BALANCE_URL_PLACEHOLDER: Record<KskHunterChannel, string> = {
  [KSK_HUNTER_CHANNEL.KIRO_MARKET]: GENERIC_BALANCE_URL_PLACEHOLDER,
  [KSK_HUNTER_CHANNEL.KIRO_CEO]: 'https://kiro.ceo/api/my/profile',
  [KSK_HUNTER_CHANNEL.KIRO_DROP]: GENERIC_BALANCE_URL_PLACEHOLDER,
  [KSK_HUNTER_CHANNEL.KIRO_APP]: GENERIC_BALANCE_URL_PLACEHOLDER,
  [KSK_HUNTER_CHANNEL.KIRO_CONVOY]: GENERIC_BALANCE_URL_PLACEHOLDER
}

interface HunterConfigDialogProps {
  isOpen: boolean
  snapshot: KskHunterSnapshot | null
  onClose: () => void
  onSave: (config: Partial<KskHunterConfig>, secrets?: KskHunterSecretInput) => Promise<void>
}

export function HunterConfigDialog({
  isOpen,
  snapshot,
  onClose,
  onSave
}: HunterConfigDialogProps): React.ReactNode {
  const groups = useAccountsStore((state) => state.groups)
  const [configDraft, setConfigDraft] = useState<KskHunterConfig>(DEFAULT_KSK_HUNTER_CONFIG)
  const [downstreamApiKey, setDownstreamApiKey] = useState('')
  const [balanceUrlDrafts, setBalanceUrlDrafts] = useState<
    Partial<Record<KskHunterChannel, string>>
  >({})
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Partial<Record<KskHunterChannel, string>>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const initializedForOpen = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previousActiveElementRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const savingRef = useRef(saving)
  onCloseRef.current = onClose
  savingRef.current = saving

  const groupOptions = useMemo(
    () => [
      { value: UNGROUPED_OPTION, label: '默认（未分组）' },
      ...Array.from(groups.values())
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((group) => ({ value: group.id, label: group.name }))
    ],
    [groups]
  )

  useEffect(() => {
    if (!isOpen) {
      initializedForOpen.current = false
      return
    }
    if (initializedForOpen.current || !snapshot) return
    initializedForOpen.current = true
    setConfigDraft({
      targetGroupId: snapshot.config.targetGroupId,
      requestTimeoutSeconds: snapshot.config.requestTimeoutSeconds,
      notifyOnAutoOrder: snapshot.config.notifyOnAutoOrder,
      downstreamEnabled: snapshot.config.downstreamEnabled,
      downstreamBaseUrl: snapshot.config.downstreamBaseUrl,
      dailyLimitCny: snapshot.config.dailyLimitCny,
      billing: snapshot.config.billing,
      allowUnknownPriceOrder: snapshot.config.allowUnknownPriceOrder,
      balanceCheckEnabled: snapshot.config.balanceCheckEnabled
    })
    setDownstreamApiKey('')
    setBalanceUrlDrafts({})
    setApiKeyDrafts({})
    setError('')
  }, [isOpen, snapshot])

  useEffect(() => {
    if (!isOpen) {
      setDownstreamApiKey('')
      setBalanceUrlDrafts({})
      setApiKeyDrafts({})
      setError('')
      previousActiveElementRef.current = null
      return
    }

    previousActiveElementRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0)
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (savingRef.current) return
        setDownstreamApiKey('')
        setBalanceUrlDrafts({})
        setApiKeyDrafts({})
        setError('')
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      )
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown)
      if (previousActiveElementRef.current?.isConnected) {
        previousActiveElementRef.current.focus()
      }
      previousActiveElementRef.current = null
    }
  }, [isOpen])

  if (!isOpen || !snapshot) return null

  const patchBilling = (
    channel: KskHunterChannel,
    patch: Partial<KskHunterConfig['billing'][KskHunterChannel]>
  ): void => {
    const billing = configDraft.billing[channel] ?? DEFAULT_KSK_HUNTER_CONFIG.billing[channel]
    setConfigDraft({
      ...configDraft,
      billing: { ...configDraft.billing, [channel]: { ...billing, ...patch } }
    })
  }

  const clearTransientDrafts = (): void => {
    setDownstreamApiKey('')
    setBalanceUrlDrafts({})
    setApiKeyDrafts({})
    setError('')
  }

  const closeDialog = (): void => {
    if (saving) return
    clearTransientDrafts()
    onClose()
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const balanceUrls = Object.fromEntries(
        Object.entries(balanceUrlDrafts).filter(([, value]) => value !== undefined && value !== '')
      ) as Partial<Record<KskHunterChannel, string>>
      const apiKeys = Object.fromEntries(
        Object.entries(apiKeyDrafts).filter(([, value]) => value !== undefined && value !== '')
      ) as Partial<Record<KskHunterChannel, string>>
      const hasSecrets =
        Boolean(downstreamApiKey.trim()) ||
        Object.keys(balanceUrls).length > 0 ||
        Object.keys(apiKeys).length > 0
      await onSave(
        configDraft,
        hasSecrets
          ? {
              ...(downstreamApiKey.trim() ? { downstreamApiKey: downstreamApiKey.trim() } : {}),
              ...(Object.keys(balanceUrls).length > 0 ? { balanceUrls } : {}),
              ...(Object.keys(apiKeys).length > 0 ? { apiKeys } : {})
            }
          : undefined
      )
      clearTransientDrafts()
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hunter-config-title"
    >
      <button
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={closeDialog}
        aria-label="关闭全局配置"
      />
      <Card
        ref={dialogRef}
        className="relative z-10 flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden border-emerald-500/20 shadow-2xl"
      >
        <CardHeader className="shrink-0 border-b border-border/70 bg-gradient-to-r from-emerald-500/[0.08] to-transparent">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-2.5 text-emerald-500">
                <ServerCog className="h-5 w-5" />
              </div>
              <div>
                <CardTitle id="hunter-config-title">全局配置</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  这些参数作用于全部 Job；单条链接的名称、渠道、模式、区域和接口请在 Job 行内编辑。
                </p>
              </div>
            </div>
            <Button
              ref={closeButtonRef}
              variant="ghost"
              size="icon"
              onClick={closeDialog}
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>写入账号分组</Label>
              <Select
                value={configDraft.targetGroupId ?? UNGROUPED_OPTION}
                options={groupOptions}
                onChange={(value) =>
                  setConfigDraft({
                    ...configDraft,
                    targetGroupId: value === UNGROUPED_OPTION ? undefined : value
                  })
                }
              />
            </div>
            <div>
              <Label>请求超时（秒）</Label>
              <Input
                type="number"
                min={3}
                max={120}
                value={configDraft.requestTimeoutSeconds}
                onChange={(event) =>
                  setConfigDraft({
                    ...configDraft,
                    requestTimeoutSeconds: Number(event.target.value)
                  })
                }
              />
            </div>
            <div className="flex items-end pb-2">
              <Switch
                checked={configDraft.notifyOnAutoOrder}
                onCheckedChange={(notifyOnAutoOrder) =>
                  setConfigDraft({ ...configDraft, notifyOnAutoOrder })
                }
              />
              <span className="ml-2 text-xs">自动下单也弹通知</span>
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">推送给下游</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  下单前询问下游，验活通过后推送；推送失败会自动重试。
                </p>
              </div>
              <Switch
                checked={configDraft.downstreamEnabled}
                onCheckedChange={(downstreamEnabled) =>
                  setConfigDraft({ ...configDraft, downstreamEnabled })
                }
                className="mt-0.5"
              />
            </div>
          </div>

          {configDraft.downstreamEnabled && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>下游地址</Label>
                <Input
                  value={configDraft.downstreamBaseUrl}
                  onChange={(event) =>
                    setConfigDraft({ ...configDraft, downstreamBaseUrl: event.target.value })
                  }
                  className="font-mono text-xs"
                  placeholder="http://127.0.0.1:12889"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  明文 HTTP 只允许 loopback；远程地址必须使用 HTTPS。
                </p>
              </div>
              <div>
                <Label>下游 API Key</Label>
                <Input
                  type="password"
                  value={downstreamApiKey}
                  onChange={(event) => setDownstreamApiKey(event.target.value)}
                  placeholder={
                    snapshot.config.hasDownstreamApiKey
                      ? `${snapshot.config.downstreamApiKeyTail} · 留空保持`
                      : '作为 x-api-key 头发送'
                  }
                />
              </div>
            </div>
          )}

          <div className="space-y-3 rounded-xl border border-border/60 bg-muted/10 p-3">
            <div className="flex items-center gap-2">
              <Wallet className="h-4 w-4 text-sky-500" />
              <h4 className="text-sm font-medium">每日花费上限与汇率</h4>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>全局每日上限（元）</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={configDraft.dailyLimitCny}
                  onChange={(event) =>
                    setConfigDraft({ ...configDraft, dailyLimitCny: Number(event.target.value) })
                  }
                  placeholder="0 = 不限"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  跨渠道统一按人民币汇总；填 0 不限，本地 00:00 归零。
                </p>
              </div>
              <div className="flex items-start pt-6">
                <Switch
                  checked={configDraft.allowUnknownPriceOrder}
                  onCheckedChange={(allowUnknownPriceOrder) =>
                    setConfigDraft({ ...configDraft, allowUnknownPriceOrder })
                  }
                />
                <div className="ml-2">
                  <span className="text-xs">商品无价格时仍然下单</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    关闭更安全：算不出花费就不花钱。
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                各渠道计价单位与上限按原币填写；汇率只用于跨渠道汇总。
              </p>
              {(Object.values(KSK_HUNTER_CHANNEL) as KskHunterChannel[]).map((channel) => {
                const billing =
                  configDraft.billing[channel] ?? DEFAULT_KSK_HUNTER_CONFIG.billing[channel]
                const balance = snapshot.balances.find((item) => item.channel === channel)
                return (
                  <div
                    key={channel}
                    className="space-y-2 rounded-lg border border-border/50 bg-background/40 p-2.5"
                  >
                    <div className="grid items-end gap-2 sm:grid-cols-[1fr_80px_90px_1fr_1fr]">
                      <p className="pb-2 text-xs font-medium">
                        {KSK_HUNTER_CHANNEL_LABEL[channel]}
                      </p>
                      <div>
                        <Label className="text-2xs">单位</Label>
                        <Input
                          value={billing.unitLabel}
                          onChange={(event) =>
                            patchBilling(channel, { unitLabel: event.target.value })
                          }
                          placeholder="积分"
                          className="font-mono text-xs"
                        />
                      </div>
                      <div>
                        <Label className="text-2xs">1 单位 = ? 元</Label>
                        <Input
                          type="number"
                          min={0}
                          step="0.0001"
                          value={billing.cnyPerUnit}
                          onChange={(event) =>
                            patchBilling(channel, { cnyPerUnit: Number(event.target.value) })
                          }
                        />
                      </div>
                      <div>
                        <Label className="text-2xs">
                          每日上限（{billing.unitLabel || '原币'}）
                        </Label>
                        <Input
                          type="number"
                          min={0}
                          step="1"
                          value={billing.dailyLimitUnit}
                          onChange={(event) =>
                            patchBilling(channel, { dailyLimitUnit: Number(event.target.value) })
                          }
                          placeholder="0 = 不限"
                        />
                      </div>
                      <div>
                        <Label className="text-2xs">余额低于此值提醒</Label>
                        <Input
                          type="number"
                          min={0}
                          step="1"
                          value={billing.lowBalanceThresholdUnit}
                          onChange={(event) =>
                            patchBilling(channel, {
                              lowBalanceThresholdUnit: Number(event.target.value)
                            })
                          }
                          placeholder="0 = 不提醒"
                        />
                      </div>
                    </div>
                    {KSK_HUNTER_CHANNEL_REQUIRES_API_KEY[channel] && (
                      <div>
                        <Label className="text-2xs">
                          API Key（请求头鉴权，列表/下单/余额共用）
                        </Label>
                        <Input
                          type="password"
                          value={apiKeyDrafts[channel] ?? ''}
                          onChange={(event) =>
                            setApiKeyDrafts({ ...apiKeyDrafts, [channel]: event.target.value })
                          }
                          placeholder={
                            snapshot.config.apiKeyHints?.[channel]
                              ? `${snapshot.config.apiKeyHints[channel]} · 留空保持`
                              : '在卖家站点账户页查看'
                          }
                          spellCheck={false}
                          className="font-mono text-xs"
                        />
                      </div>
                    )}
                    {configDraft.balanceCheckEnabled && (
                      <div>
                        <Label className="text-2xs">余额查询地址</Label>
                        <Input
                          type="password"
                          value={balanceUrlDrafts[channel] ?? ''}
                          onChange={(event) =>
                            setBalanceUrlDrafts({
                              ...balanceUrlDrafts,
                              [channel]: event.target.value
                            })
                          }
                          placeholder={
                            snapshot.config.balanceUrlHints?.[channel]
                              ? `${snapshot.config.balanceUrlHints[channel]} · 留空保持`
                              : BALANCE_URL_PLACEHOLDER[channel]
                          }
                          spellCheck={false}
                          className="font-mono text-xs"
                        />
                      </div>
                    )}
                    <p className="text-2xs text-muted-foreground">
                      当前余额：{' '}
                      {balance?.amountUnit !== undefined
                        ? `${balance.amountUnit} ${balance.unitLabel}`
                        : balance?.error
                          ? '查询失败'
                          : '未检查'}
                      {balance?.isLow ? ' · 余额偏低' : ''}
                    </p>
                  </div>
                )
              })}
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">查询余额并按余额拦单</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    余额不够付这一单就跳过；余额缓存 60 秒，下单后立即失效。
                  </p>
                </div>
                <Switch
                  checked={configDraft.balanceCheckEnabled}
                  onCheckedChange={(balanceCheckEnabled) =>
                    setConfigDraft({ ...configDraft, balanceCheckEnabled })
                  }
                  className="mt-0.5"
                />
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
              {error}
            </div>
          )}
        </CardContent>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border/70 bg-muted/15 px-5 py-4">
          <Button variant="outline" onClick={closeDialog} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {saving ? '保存中…' : '保存配置'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
