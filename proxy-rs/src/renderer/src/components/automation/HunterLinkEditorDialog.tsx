import { useEffect, useState } from 'react'
import { Crosshair, Loader2, X } from 'lucide-react'
import {
  KSK_HUNTER_CHANNEL,
  KSK_HUNTER_CHANNEL_LABEL,
  KSK_HUNTER_CHANNEL_MIN_INTERVAL_SECONDS,
  KSK_HUNTER_MODE,
  KSK_HUNTER_POLL_INTERVAL_SECONDS,
  type KskHunterChannel,
  type KskHunterLinkInput,
  type KskHunterLinkView,
  type KskHunterMode
} from '../../../../shared/kskHunter'
import { KIRO_API_KEY_REGION_PROBE_ORDER } from '../../../../shared/kiroApiKey'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '../ui'

interface HunterLinkEditorDialogProps {
  isOpen: boolean
  link?: KskHunterLinkView
  onClose: () => void
  onSave: (input: KskHunterLinkInput) => Promise<void>
}

/** 可勾选的区域：与 ksk 实际可用的 Kiro 端点区域对齐。 */
const SELECTABLE_REGIONS = [...KIRO_API_KEY_REGION_PROBE_ORDER, 'ap-southeast-1'] as const

const CHANNEL_OPTIONS = Object.values(KSK_HUNTER_CHANNEL).map((channel) => ({
  value: channel,
  label: KSK_HUNTER_CHANNEL_LABEL[channel]
}))

const MODE_OPTIONS: { value: KskHunterMode; label: string; hint: string }[] = [
  {
    value: KSK_HUNTER_MODE.NOTIFY,
    label: '仅提醒我',
    hint: '发现有货就弹系统通知，由你自己去下单。'
  },
  {
    value: KSK_HUNTER_MODE.AUTO_ORDER,
    label: '自动下单并推送下游',
    hint: '先问下游要不要号，要就下单、验活，再把 KSK 推给下游。'
  }
]

export function HunterLinkEditorDialog({
  isOpen,
  link,
  onClose,
  onSave
}: HunterLinkEditorDialogProps): React.ReactNode {
  const [name, setName] = useState('')
  const [channel, setChannel] = useState<KskHunterChannel>(KSK_HUNTER_CHANNEL.KIRO_MARKET)
  const [mode, setMode] = useState<KskHunterMode>(KSK_HUNTER_MODE.NOTIFY)
  const [regions, setRegions] = useState<string[]>([])
  const [listUrl, setListUrl] = useState('')
  const [orderUrl, setOrderUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setName(link?.name ?? '')
    setChannel(link?.channel ?? KSK_HUNTER_CHANNEL.KIRO_MARKET)
    setMode(link?.mode ?? KSK_HUNTER_MODE.NOTIFY)
    setRegions(link?.regions ?? [])
    // 密钥类字段不回填明文，留空表示保持原值
    setListUrl('')
    setOrderUrl('')
    setError('')
  }, [isOpen, link])

  if (!isOpen) return null

  const channelMinInterval = KSK_HUNTER_CHANNEL_MIN_INTERVAL_SECONDS[channel]

  const toggleRegion = (region: string): void => {
    setRegions((current) =>
      current.includes(region) ? current.filter((item) => item !== region) : [...current, region]
    )
  }

  const handleSave = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await onSave({
        name: name.trim(),
        channel,
        mode,
        regions,
        listUrl: listUrl.trim() || undefined,
        orderUrl: orderUrl.trim() || undefined
      })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <Card className="relative z-10 flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden border-violet-500/20 shadow-2xl">
        <CardHeader className="shrink-0 border-b border-border/70 bg-gradient-to-r from-violet-500/[0.08] to-transparent">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="rounded-xl border border-violet-500/20 bg-violet-500/10 p-2.5 text-violet-500">
                <Crosshair className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>{link ? '编辑监控链接' : '新增监控链接'}</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  所有启用链接每 {KSK_HUNTER_POLL_INTERVAL_SECONDS} 秒并行查一次库存
                  {channelMinInterval > KSK_HUNTER_POLL_INTERVAL_SECONDS
                    ? `；${KSK_HUNTER_CHANNEL_LABEL[channel]} 按站点要求最快 ${channelMinInterval} 秒一次`
                    : ''}
                  。
                </p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>链接名称</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：Kiro Drop · eu-central-1"
              />
            </div>
            <div>
              <Label>站点</Label>
              <Select
                value={channel}
                options={CHANNEL_OPTIONS}
                onChange={(value) => setChannel(value as KskHunterChannel)}
              />
            </div>
          </div>

          <div>
            <Label>商品列表接口地址</Label>
            <Input
              type="password"
              value={listUrl}
              onChange={(event) => setListUrl(event.target.value)}
              placeholder={
                link?.hasListUrl
                  ? `${link.listUrlHint} · 留空保持`
                  : 'https://.../api/goods?token=...'
              }
              spellCheck={false}
              className="font-mono text-xs"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              地址通过系统安全存储加密，列表里只显示脱敏形式。必须是 HTTPS。
            </p>
          </div>

          <div>
            <Label>处置方式</Label>
            <div className="mt-1.5 grid gap-2">
              {MODE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setMode(option.value)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                    mode === option.value
                      ? 'border-violet-500/40 bg-violet-500/10'
                      : 'border-border/60 bg-muted/20 hover:bg-muted/40'
                  }`}
                >
                  <p className="text-sm font-medium">{option.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{option.hint}</p>
                </button>
              ))}
            </div>
          </div>

          {mode === KSK_HUNTER_MODE.AUTO_ORDER && (
            <div>
              <Label>下单接口地址</Label>
              <Input
                type="password"
                value={orderUrl}
                onChange={(event) => setOrderUrl(event.target.value)}
                placeholder={
                  link?.hasOrderUrl
                    ? `${link.orderUrlHint} · 留空保持`
                    : 'https://.../api/order?token=...'
                }
                spellCheck={false}
                className="font-mono text-xs"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                下单响应里的 ksk_ 密钥会被自动提取，无需额外配置字段路径。
              </p>
            </div>
          )}

          <div>
            <Label>只抢这些区域</Label>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {SELECTABLE_REGIONS.map((region) => (
                <button
                  key={region}
                  type="button"
                  onClick={() => toggleRegion(region)}
                  className={`rounded-lg border px-2.5 py-1.5 font-mono text-xs transition-colors ${
                    regions.includes(region)
                      ? 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300'
                      : 'border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40'
                  }`}
                >
                  {region}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {regions.length === 0
                ? '未选任何区域：不限区域，只要有货就算命中。'
                : `命中区域不在所选范围内的商品会被忽略。`}
            </p>
          </div>

          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
              {error}
            </div>
          )}
        </CardContent>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border/70 bg-muted/15 px-5 py-4">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            onClick={handleSave}
            disabled={busy || !name.trim() || (!link?.hasListUrl && !listUrl.trim())}
          >
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {link ? '保存修改' : '添加链接'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
