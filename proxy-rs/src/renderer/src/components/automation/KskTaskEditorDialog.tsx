import { useEffect, useMemo, useState } from 'react'
import { BellRing, CloudDownload, Loader2, ServerCog, ShieldCheck, X } from 'lucide-react'
import {
  DEFAULT_KSK_AUTOMATION_CONFIG,
  KSK_CLEANUP_INTERVAL_MAX_MINUTES,
  KSK_CLEANUP_INTERVAL_MIN_MINUTES,
  KSK_LIVENESS_PROBE_MESSAGE,
  KSK_PROVIDER_POLL_INTERVAL_SECONDS,
  type KskAutomationConfig,
  type KskAutomationTaskInput,
  type KskAutomationTaskView
} from '../../../../shared/kskAutomation'
import { LIVENESS_MODELS } from '../../hooks/useLivenessModels'
import type { AccountGroup } from '../../types/account'
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

interface KskTaskEditorDialogProps {
  isOpen: boolean
  task?: KskAutomationTaskView
  groups: AccountGroup[]
  onClose: () => void
  onSave: (input: KskAutomationTaskInput) => Promise<void>
}

function ToggleField(props: {
  checked: boolean
  onChange: (checked: boolean) => void
  title: string
  hint: string
}): React.ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5">
      <div>
        <p className="text-sm font-medium">{props.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{props.hint}</p>
      </div>
      <Switch checked={props.checked} onCheckedChange={props.onChange} className="mt-0.5" />
    </div>
  )
}

export function KskTaskEditorDialog({
  isOpen,
  task,
  groups,
  onClose,
  onSave
}: KskTaskEditorDialogProps): React.ReactNode {
  const sortedGroups = useMemo(() => groups.slice().sort((a, b) => a.order - b.order), [groups])
  const defaultGroupId = sortedGroups.find((group) => group.name.toLowerCase() === 'ksk')?.id
  const [name, setName] = useState('自动拉取 KSK')
  const [enabled, setEnabled] = useState(true)
  const [config, setConfig] = useState<KskAutomationConfig>({
    ...DEFAULT_KSK_AUTOMATION_CONFIG,
    providerEnabled: true,
    providerGroupId: defaultGroupId
  })
  const [providerUrl, setProviderUrl] = useState('')
  const [smtpPassword, setSmtpPassword] = useState('')
  const [localAdminApiKey, setLocalAdminApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setName(task?.name ?? '自动拉取 KSK')
    setEnabled(task?.enabled ?? true)
    setConfig(
      task
        ? { ...task.config, providerEnabled: true }
        : {
            ...DEFAULT_KSK_AUTOMATION_CONFIG,
            providerEnabled: true,
            providerGroupId: defaultGroupId
          }
    )
    setProviderUrl('')
    setSmtpPassword('')
    setLocalAdminApiKey('')
    setError('')
  }, [defaultGroupId, isOpen, task])

  if (!isOpen) return null

  const groupOptions = [
    { value: '__ungrouped__', label: '默认（未分组）' },
    ...sortedGroups.map((group) => ({ value: group.id, label: group.name }))
  ]
  const localGroupOptions = groupOptions.filter((option) => option.value !== '__ungrouped__')

  const handleSave = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await onSave({
        name: name.trim(),
        enabled,
        config: { ...config, providerEnabled: true },
        secrets: {
          providerUrl: providerUrl.trim() || undefined,
          smtpPassword: smtpPassword || undefined,
          localAdminApiKey: localAdminApiKey.trim() || undefined
        }
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
      <Card className="relative z-10 flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden border-sky-500/20 shadow-2xl">
        <CardHeader className="shrink-0 border-b border-border/70 bg-gradient-to-r from-sky-500/[0.08] to-transparent">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 p-2.5 text-sky-500">
                <CloudDownload className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>{task ? '编辑自动任务' : '新建自动任务'}</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  每 {KSK_PROVIDER_POLL_INTERVAL_SECONDS} 秒拉取一次，验活通过后才写入目标分组。
                </p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <section className="grid gap-3 rounded-2xl border border-border/70 p-4 sm:grid-cols-[1fr_auto]">
            <div>
              <Label>任务名称</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：US Power KSK"
              />
            </div>
            <div className="flex min-w-44 items-end pb-2">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
              <span className="ml-2 text-sm">保存后立即运行</span>
            </div>
          </section>

          <section className="space-y-3 rounded-2xl border border-border/70 p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-sky-500" />
              <h4 className="text-sm font-semibold">Provider 与入组</h4>
            </div>
            <div>
              <Label>KSK Provider URL</Label>
              <Input
                type="password"
                value={providerUrl}
                onChange={(event) => setProviderUrl(event.target.value)}
                placeholder={
                  task?.config.hasProviderUrl
                    ? `${task.config.providerUrlHint} · 留空保持`
                    : 'https://.../get?token=...'
                }
                spellCheck={false}
                className="font-mono text-xs"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                完整 URL 会通过系统安全存储加密，任务列表只显示脱敏地址。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
              <div>
                <Label>自动添加到分组</Label>
                <Select
                  value={config.providerGroupId ?? '__ungrouped__'}
                  options={groupOptions}
                  onChange={(value) =>
                    setConfig({
                      ...config,
                      providerGroupId: value === '__ungrouped__' ? undefined : value
                    })
                  }
                />
              </div>
              <div>
                <Label>超时（秒）</Label>
                <Input
                  type="number"
                  min={3}
                  max={120}
                  value={config.requestTimeoutSeconds}
                  onChange={(event) =>
                    setConfig({ ...config, requestTimeoutSeconds: Number(event.target.value) })
                  }
                />
              </div>
            </div>
            <ToggleField
              checked={config.cleanupInvalidOnAdd}
              onChange={(cleanupInvalidOnAdd) => setConfig({ ...config, cleanupInvalidOnAdd })}
              title="新增 KSK 后全量清理不可用账号"
              hint="每次有新号入库，就对目标分组全部账号再发一条测试消息；认证失败、封禁和配额耗尽会删除（同时清掉 kiro-rs 反代上的对应凭据），超时、限流和服务异常会保留。"
            />
            <ToggleField
              checked={config.cleanupPeriodicEnabled}
              onChange={(cleanupPeriodicEnabled) =>
                setConfig({ ...config, cleanupPeriodicEnabled })
              }
              title="按周期全量清理不可用账号"
              hint="不等有新号也定期复查。只靠上面那条的话，号池没新货时一次都不跑，已入库的号后来被封或到期就会一直留在反代里。"
            />
            {config.cleanupPeriodicEnabled && (
              <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
                <div>
                  <Label>清理间隔（分钟）</Label>
                  <Input
                    type="number"
                    min={KSK_CLEANUP_INTERVAL_MIN_MINUTES}
                    max={KSK_CLEANUP_INTERVAL_MAX_MINUTES}
                    value={config.cleanupIntervalMinutes}
                    onChange={(event) =>
                      setConfig({ ...config, cleanupIntervalMinutes: Number(event.target.value) })
                    }
                  />
                </div>
                <p className="self-end pb-2 text-xs text-muted-foreground">
                  每轮每个号都会发一条测试消息，间隔太短纯烧 credits。额度耗尽这种最常见的失效
                  不依赖它——那条走余额接口，由反代统计每分钟免费查一次。
                </p>
              </div>
            )}
            <ToggleField
              checked={config.autoDeleteExhausted}
              onChange={(autoDeleteExhausted) => setConfig({ ...config, autoDeleteExhausted })}
              title="额度耗尽自动删除"
              hint="反代统计每分钟采一次余额，发现额度已耗尽（剩余 0）就把凭据从 kiro-rs 反代删掉，并连带删除本地账号库里的对应账号。查余额是只读计量，不消耗额度。"
            />
            <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
              <div>
                <Label>验活模型</Label>
                <datalist id="ksk-task-liveness-models">
                  {LIVENESS_MODELS.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
                <Input
                  list="ksk-task-liveness-models"
                  value={config.livenessModel}
                  onChange={(event) => setConfig({ ...config, livenessModel: event.target.value })}
                  placeholder="留空 = 自动选最便宜"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </div>
              <div>
                <Label>测试消息</Label>
                <Input
                  value={config.livenessMessage}
                  onChange={(event) =>
                    setConfig({ ...config, livenessMessage: event.target.value })
                  }
                  placeholder={KSK_LIVENESS_PROBE_MESSAGE}
                  className="text-xs"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              入库前的验活与新增后的全量清理都用这组参数，与账号页「批量验活」同一条路径。
            </p>
          </section>

          <section className="space-y-3 rounded-2xl border border-border/70 p-4">
            <div className="flex items-center gap-2">
              <BellRing className="h-4 w-4 text-amber-500" />
              <h4 className="text-sm font-semibold">邮件通知</h4>
            </div>
            <ToggleField
              checked={config.emailEnabled}
              onChange={(emailEnabled) => setConfig({ ...config, emailEnabled })}
              title="新增 KSK 后发送邮件"
              hint="邮件正文格式为：ksk_xxx（区域）。"
            />
            {config.emailEnabled && (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <Label>SMTP Host</Label>
                  <Input
                    value={config.smtpHost}
                    onChange={(event) => setConfig({ ...config, smtpHost: event.target.value })}
                    placeholder="smtp.example.com"
                  />
                </div>
                <div>
                  <Label>SMTP Port</Label>
                  <Input
                    type="number"
                    value={config.smtpPort}
                    onChange={(event) =>
                      setConfig({ ...config, smtpPort: Number(event.target.value) })
                    }
                  />
                </div>
                <div>
                  <Label>SMTP 用户名</Label>
                  <Input
                    value={config.smtpUsername}
                    onChange={(event) => setConfig({ ...config, smtpUsername: event.target.value })}
                  />
                </div>
                <div>
                  <Label>SMTP 密码</Label>
                  <Input
                    type="password"
                    value={smtpPassword}
                    onChange={(event) => setSmtpPassword(event.target.value)}
                    placeholder={task?.config.hasSmtpPassword ? '已保存 · 留空保持' : ''}
                  />
                </div>
                <div className="flex items-end pb-2">
                  <Switch
                    checked={config.smtpSecure}
                    onCheckedChange={(smtpSecure) => setConfig({ ...config, smtpSecure })}
                  />
                  <span className="ml-2 text-xs">TLS / SSL</span>
                </div>
                <div>
                  <Label>发件人</Label>
                  <Input
                    value={config.smtpFrom}
                    onChange={(event) => setConfig({ ...config, smtpFrom: event.target.value })}
                    placeholder="Proxy RS <bot@example.com>"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label>指定收件邮箱</Label>
                  <Input
                    value={config.smtpTo}
                    onChange={(event) => setConfig({ ...config, smtpTo: event.target.value })}
                    placeholder="owner@example.com, me@example.com"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    多个收件人用英文逗号分隔；想自己也留一份就把发件邮箱一起写进来。
                  </p>
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3 rounded-2xl border border-border/70 p-4">
            <div className="flex items-center gap-2">
              <ServerCog className="h-4 w-4 text-emerald-500" />
              <h4 className="text-sm font-semibold">同步到本机 Admin</h4>
            </div>
            <ToggleField
              checked={config.localAdminEnabled}
              onChange={(localAdminEnabled) => setConfig({ ...config, localAdminEnabled })}
              title="指定分组新增后自动同步"
              hint="只补齐缺失 KSK；创建后立即调用余额接口验活。"
            />
            {config.localAdminEnabled && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>同步分组</Label>
                  <Select
                    value={config.localAdminGroupId ?? ''}
                    placeholder="选择分组"
                    options={localGroupOptions}
                    onChange={(localAdminGroupId) => setConfig({ ...config, localAdminGroupId })}
                  />
                </div>
                <div>
                  <Label>Admin URL</Label>
                  <Input
                    value={config.localAdminBaseUrl}
                    onChange={(event) =>
                      setConfig({ ...config, localAdminBaseUrl: event.target.value })
                    }
                    className="font-mono text-xs"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label>Admin API Key</Label>
                  <Input
                    type="password"
                    value={localAdminApiKey}
                    onChange={(event) => setLocalAdminApiKey(event.target.value)}
                    placeholder={
                      task?.config.hasLocalAdminApiKey
                        ? `${task.config.localAdminApiKeyTail} · 留空保持`
                        : '输入管理面板使用的 Admin API Key'
                    }
                  />
                </div>
              </div>
            )}
          </section>

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
          <Button onClick={handleSave} disabled={busy || !name.trim()}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {task ? '保存修改' : '创建任务'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
