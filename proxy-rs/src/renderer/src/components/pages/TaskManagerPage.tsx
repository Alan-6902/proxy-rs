import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  CirclePause,
  CirclePlay,
  CloudDownload,
  Edit3,
  ListChecks,
  Loader2,
  Mail,
  Play,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import {
  KSK_AUTOMATION_STATE,
  KSK_PROVIDER_POLL_INTERVAL_SECONDS,
  type KskAutomationTaskInput,
  type KskAutomationTaskView
} from '../../../../shared/kskAutomation'
import { useAccountsStore } from '../../store/accounts'
import { KskTaskEditorDialog } from '../automation/KskTaskEditorDialog'
import { Badge, Button, Card, CardContent, PageHeader, askConfirm } from '../ui'

type TaskAction = 'toggle' | 'run' | 'local' | 'delete'
type BusyAction = { taskId: string; action: TaskAction } | null

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : '—'
}

function statusLabel(task: KskAutomationTaskView): string {
  if (!task.enabled) return '已暂停'
  switch (task.status.state) {
    case KSK_AUTOMATION_STATE.RUNNING:
      return '执行中'
    case KSK_AUTOMATION_STATE.HEALTHY:
      return '运行正常'
    case KSK_AUTOMATION_STATE.DEGRADED:
      return '部分异常'
    case KSK_AUTOMATION_STATE.BLOCKED:
      return '已阻塞'
    default:
      return '等待执行'
  }
}

function statusTone(task: KskAutomationTaskView): string {
  if (!task.enabled) return 'border-border bg-muted/40 text-muted-foreground'
  if (task.status.state === KSK_AUTOMATION_STATE.HEALTHY) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
  }
  if (
    task.status.state === KSK_AUTOMATION_STATE.DEGRADED ||
    task.status.state === KSK_AUTOMATION_STATE.BLOCKED
  ) {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300'
  }
  return 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300'
}

export function TaskManagerPage(): React.ReactNode {
  const groups = useAccountsStore((state) => state.groups)
  const [tasks, setTasks] = useState<KskAutomationTaskView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<KskAutomationTaskView | undefined>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadTasks = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await window.api.kskAutomationList()
      if (!result.success) throw new Error(result.error || '加载任务失败')
      setTasks(result.data ?? [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadTasks()
    return window.api.onKskAutomationStatus(({ taskId, status }) => {
      setTasks((current) =>
        current.map((task) => (task.id === taskId ? { ...task, status } : task))
      )
    })
  }, [loadTasks])

  const groupNames = useMemo(
    () => new Map(Array.from(groups.values()).map((group) => [group.id, group.name])),
    [groups]
  )
  const activeCount = tasks.filter((task) => task.enabled).length
  const pausedCount = tasks.length - activeCount
  const issueCount = tasks.filter(
    (task) =>
      task.status.state === KSK_AUTOMATION_STATE.DEGRADED ||
      task.status.state === KSK_AUTOMATION_STATE.BLOCKED
  ).length

  const openCreate = (): void => {
    setEditingTask(undefined)
    setEditorOpen(true)
  }

  const openEdit = (task: KskAutomationTaskView): void => {
    setEditingTask(task)
    setEditorOpen(true)
  }

  const handleSave = async (input: KskAutomationTaskInput): Promise<void> => {
    const result = editingTask
      ? await window.api.kskAutomationUpdate(editingTask.id, input)
      : await window.api.kskAutomationCreate(input)
    if (!result.success) throw new Error(result.error || '保存任务失败')
    setTasks(result.data ?? [])
    setEditorOpen(false)
    setEditingTask(undefined)
    setNotice(editingTask ? '任务配置已更新。' : '任务已创建并加入后台调度。')
  }

  const handleToggle = async (task: KskAutomationTaskView): Promise<void> => {
    setBusy({ taskId: task.id, action: 'toggle' })
    setError('')
    setNotice('')
    try {
      const result = await window.api.kskAutomationSetEnabled(task.id, !task.enabled)
      if (!result.success) throw new Error(result.error || '更新任务状态失败')
      setTasks(result.data ?? [])
      setNotice(task.enabled ? `已暂停“${task.name}”。` : `已恢复“${task.name}”。`)
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError))
    } finally {
      setBusy(null)
    }
  }

  const handleRun = async (task: KskAutomationTaskView): Promise<void> => {
    setBusy({ taskId: task.id, action: 'run' })
    setError('')
    setNotice('')
    try {
      const result = await window.api.kskAutomationSyncNow(task.id)
      if (!result.success) throw new Error(result.error || '立即执行失败')
      if (!result.data) throw new Error('立即执行失败')
      setTasks((current) =>
        current.map((item) =>
          item.id === result.data?.taskId ? { ...item, status: result.data.status } : item
        )
      )
      setNotice(`“${task.name}”已完成一次拉取。`)
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError))
    } finally {
      setBusy(null)
    }
  }

  const handleLocalSync = async (task: KskAutomationTaskView): Promise<void> => {
    setBusy({ taskId: task.id, action: 'local' })
    setError('')
    setNotice('')
    try {
      const result = await window.api.kskAutomationSyncLocalAdminNow(task.id)
      if (!result.success) throw new Error(result.error || '本机同步失败')
      if (!result.data) throw new Error('本机同步失败')
      setTasks((current) =>
        current.map((item) =>
          item.id === result.data?.taskId ? { ...item, status: result.data.status } : item
        )
      )
      setNotice(`“${task.name}”已完成本机同步与验活。`)
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError))
    } finally {
      setBusy(null)
    }
  }

  const handleDelete = async (task: KskAutomationTaskView): Promise<void> => {
    const confirmed = await askConfirm({
      title: `删除任务“${task.name}”？`,
      description:
        '将停止后台轮询并删除该任务保存的 Provider URL、SMTP 密码和 Admin Key。已导入的账号不会删除。',
      confirmText: '删除任务',
      cancelText: '取消',
      tone: 'danger',
      holdToConfirmMs: 900
    })
    if (!confirmed) return
    setBusy({ taskId: task.id, action: 'delete' })
    setError('')
    setNotice('')
    try {
      const result = await window.api.kskAutomationDelete(task.id)
      if (!result.success) throw new Error(result.error || '删除任务失败')
      setTasks(result.data ?? [])
      setNotice(`已删除“${task.name}”，已导入账号保持不变。`)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
    } finally {
      setBusy(null)
    }
  }

  const isBusy = (taskId: string, action: TaskAction): boolean =>
    busy?.taskId === taskId && busy.action === action

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        eyebrow="AUTOMATION CONTROL"
        title="任务管理"
        description="集中管理后台自动任务：查看运行状态、暂停恢复、修改配置或立即执行。"
        icon={ListChecks}
        accent="cyan"
        badges={<Badge variant="outline">{tasks.length} 个任务</Badge>}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={loadTasks} disabled={loading}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
            <Button onClick={openCreate}>
              <Plus className="mr-1.5 h-4 w-4" />
              新建任务
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          {[
            { label: '全部任务', value: tasks.length, icon: ListChecks, tone: 'text-sky-500' },
            { label: '正在运行', value: activeCount, icon: CirclePlay, tone: 'text-emerald-500' },
            {
              label: '已暂停',
              value: pausedCount,
              icon: CirclePause,
              tone: 'text-muted-foreground'
            },
            { label: '需要处理', value: issueCount, icon: TriangleAlert, tone: 'text-amber-500' }
          ].map((metric) => (
            <Card key={metric.label} className="border-border/70 bg-card/70">
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                    {metric.label}
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{metric.value}</p>
                </div>
                <metric.icon className={`h-5 w-5 ${metric.tone}`} />
              </CardContent>
            </Card>
          ))}
        </div>

        {(error || notice) && (
          <div
            className={`mb-4 rounded-xl border px-3 py-2 text-sm ${
              error
                ? 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
            }`}
          >
            {error || notice}
          </div>
        )}

        {loading && tasks.length === 0 ? (
          <div className="grid min-h-64 place-items-center">
            <Loader2 className="h-7 w-7 animate-spin text-sky-500" />
          </div>
        ) : tasks.length === 0 ? (
          <Card className="border-dashed border-sky-500/25 bg-gradient-to-br from-sky-500/[0.06] to-transparent">
            <CardContent className="flex min-h-72 flex-col items-center justify-center text-center">
              <div className="mb-4 rounded-2xl border border-sky-500/20 bg-sky-500/10 p-4 text-sky-500">
                <CloudDownload className="h-7 w-7" />
              </div>
              <h2 className="text-lg font-semibold">还没有自动任务</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                创建一条 KSK 自动拉取任务，系统会按固定间隔验活、入组，并按需同步到本机 Admin。
              </p>
              <Button className="mt-5" onClick={openCreate}>
                <Plus className="mr-1.5 h-4 w-4" />
                新建自动拉取 KSK
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {tasks.map((task) => {
              const destination = task.config.providerGroupId
                ? groupNames.get(task.config.providerGroupId) || '分组已删除'
                : '未分组'
              return (
                <Card
                  key={task.id}
                  className={`overflow-hidden border-border/70 transition-colors ${
                    task.enabled ? 'bg-card/80' : 'bg-muted/20 opacity-80'
                  }`}
                >
                  <div className="h-1 bg-gradient-to-r from-sky-500 via-cyan-400 to-emerald-400" />
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 p-2.5 text-sky-500">
                          <CloudDownload className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                          <h2 className="truncate font-semibold">{task.name}</h2>
                          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                            {task.config.providerUrlHint || 'Provider URL 未配置'}
                          </p>
                        </div>
                      </div>
                      <Badge variant="outline" className={statusTone(task)}>
                        {statusLabel(task)}
                      </Badge>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-border/60 bg-muted/15 p-3 text-xs sm:grid-cols-4">
                      <div>
                        <p className="text-muted-foreground">目标分组</p>
                        <p className="mt-0.5 truncate font-medium">{destination}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">执行间隔</p>
                        <p className="mt-0.5 font-medium">
                          {KSK_PROVIDER_POLL_INTERVAL_SECONDS} 秒
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">累计新增</p>
                        <p className="mt-0.5 font-medium tabular-nums">
                          {task.status.totalAddedCount}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">连续失败</p>
                        <p className="mt-0.5 font-medium tabular-nums">
                          {task.status.consecutiveFailures}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Activity className="h-3.5 w-3.5" />
                        最近成功{' '}
                        <span className="text-foreground">
                          {formatTime(task.status.lastSuccessAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <RefreshCw className="h-3.5 w-3.5" />
                        下次执行{' '}
                        <span className="text-foreground">{formatTime(task.status.nextRunAt)}</span>
                      </div>
                      {task.config.emailEnabled && (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Mail className="h-3.5 w-3.5" /> 邮件通知已开启
                        </div>
                      )}
                      {task.config.localAdminEnabled && (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <ServerCog className="h-3.5 w-3.5" /> 本机 Admin 同步已开启
                        </div>
                      )}
                      {task.config.cleanupInvalidOnAdd && (
                        <div className="flex items-center gap-2 text-muted-foreground sm:col-span-2">
                          <Trash2 className="h-3.5 w-3.5" />
                          新增后自动清理 · 上轮检查 {
                            task.status.lastCleanupCheckedCount
                          } 个，删除 {task.status.lastCleanupRemovedCount} 个
                          {task.status.lastCleanupRetainedCount > 0
                            ? `，保留 ${task.status.lastCleanupRetainedCount} 个待确认`
                            : ''}
                        </div>
                      )}
                    </div>

                    {task.status.lastError && (
                      <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                        {task.status.lastError}
                      </div>
                    )}

                    <div className="mt-5 flex flex-wrap gap-2 border-t border-border/60 pt-4">
                      <Button
                        size="sm"
                        variant={task.enabled ? 'outline' : 'default'}
                        onClick={() => handleToggle(task)}
                        disabled={busy !== null}
                      >
                        {isBusy(task.id, 'toggle') ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : task.enabled ? (
                          <CirclePause className="mr-1.5 h-3.5 w-3.5" />
                        ) : (
                          <CirclePlay className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        {task.enabled ? '暂停' : '恢复'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleRun(task)}
                        disabled={busy !== null || !task.enabled}
                      >
                        {isBusy(task.id, 'run') ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        立即执行
                      </Button>
                      {task.config.localAdminEnabled && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleLocalSync(task)}
                          disabled={busy !== null || !task.enabled}
                        >
                          {isBusy(task.id, 'local') ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ServerCog className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          同步本机
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(task)}
                        disabled={busy !== null}
                      >
                        <Edit3 className="mr-1.5 h-3.5 w-3.5" />
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto text-red-500 hover:bg-red-500/10 hover:text-red-500"
                        onClick={() => handleDelete(task)}
                        disabled={busy !== null}
                      >
                        {isBusy(task.id, 'delete') ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        删除
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <KskTaskEditorDialog
        isOpen={editorOpen}
        task={editingTask}
        groups={Array.from(groups.values())}
        onClose={() => {
          setEditorOpen(false)
          setEditingTask(undefined)
        }}
        onSave={handleSave}
      />
    </div>
  )
}
