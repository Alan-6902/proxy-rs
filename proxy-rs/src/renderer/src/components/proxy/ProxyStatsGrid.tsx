// 反代运行指标网格：请求量 / 成败 / Token 分解 / Cache / Credits
import { Activity, Check, Clock, Cpu, RotateCcw, Server, UserCheck, Users, Zap } from 'lucide-react'
import { Badge, Button, Card, CardContent } from '../ui'
import { compactNumber } from '@/lib/utils'

export interface ProxyRuntimeStats {
  totalRequests: number
  successRequests: number
  failedRequests: number
  totalTokens: number
  totalCredits: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  startTime: number
}

export interface ProxySessionStats {
  totalRequests: number
  successRequests: number
  failedRequests: number
  startTime: number
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h}h ${m}m ${s}s`
}

/** KPI 卡：eyebrow 指标名 + 展示字数值，色相由 accent 决定（Tailwind 渐变类名片段）。 */
function StatCard({
  icon: Icon,
  label,
  accent,
  action,
  children
}: {
  icon: React.ElementType
  label: React.ReactNode
  /** 卡片右上角的附加内容（重置按钮、命中率徽标等）。 */
  accent: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Card className={`hover-lift bg-gradient-to-br ${accent} to-transparent`}>
      <CardContent className="px-4 py-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground">
          <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span className="type-eyebrow truncate">{label}</span>
          {action && <span className="ml-auto flex shrink-0 items-center">{action}</span>}
        </div>
        <div className="type-metric text-display-sm">{children}</div>
      </CardContent>
    </Card>
  )
}

/**
 * 成功/失败这类「A / B」双值：分隔斜杠统一压淡，避免两个数字视觉打平。
 * 两个数字共用一格，所以比单值卡小一档 —— 否则窄窗口下 `812K / 89,755` 会溢出。
 */
function PairValue({
  left,
  right,
  leftClass,
  rightClass
}: {
  left: React.ReactNode
  right: React.ReactNode
  leftClass: string
  rightClass: string
}): React.ReactNode {
  return (
    <span className="text-base">
      <span className={leftClass}>{left}</span>
      <span className="mx-1 text-muted-foreground/60">/</span>
      <span className={rightClass}>{right}</span>
    </span>
  )
}

interface ProxyStatsGridProps {
  stats: ProxyRuntimeStats | null
  sessionStats: ProxySessionStats | null
  availableCount: number
  accountCount: number
  /** 秒数，由父组件按秒 tick。 */
  uptime: number
  isEn: boolean
  onResetRequestStats: () => void
}

export function ProxyStatsGrid({
  stats,
  sessionStats,
  availableCount,
  accountCount,
  uptime,
  isEn,
  onResetRequestStats
}: ProxyStatsGridProps): React.ReactNode {
  const cacheRead = stats?.cacheReadTokens || 0
  const cacheTotal = cacheRead + (stats?.cacheWriteTokens || 0)
  const cacheHitRate = cacheTotal > 0 ? (cacheRead / cacheTotal) * 100 : 0

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-6 gap-3">
        <StatCard icon={Users} label={isEn ? 'Pool' : '账号池'} accent="from-blue-500/8">
          <span className="text-foreground">
            {availableCount}/{accountCount}
          </span>
        </StatCard>

        <StatCard
          icon={Activity}
          label={isEn ? 'Total' : '总请求'}
          accent="from-purple-500/8"
          action={
            <Button
              variant="ghost"
              size="icon"
              className="h-4 w-4 text-muted-foreground hover:text-destructive"
              onClick={onResetRequestStats}
              title={isEn ? 'Reset Statistics' : '重置统计'}
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
          }
        >
          <span className="text-foreground">{stats?.totalRequests || 0}</span>
        </StatCard>

        <StatCard
          icon={Check}
          label={isEn ? 'Total S/F' : '总计成功/失败'}
          accent="from-green-500/8"
        >
          <PairValue
            left={stats?.successRequests || 0}
            right={stats?.failedRequests || 0}
            leftClass="text-success"
            rightClass="text-destructive"
          />
        </StatCard>

        <StatCard icon={Zap} label={isEn ? 'Session' : '本次请求'} accent="from-cyan-500/8">
          <span className="text-foreground">{sessionStats?.totalRequests || 0}</span>
        </StatCard>

        <StatCard
          icon={Activity}
          label={isEn ? 'Session S/F' : '本次成功/失败'}
          accent="from-orange-500/8"
        >
          <PairValue
            left={sessionStats?.successRequests || 0}
            right={sessionStats?.failedRequests || 0}
            leftClass="text-success"
            rightClass="text-destructive"
          />
        </StatCard>

        <StatCard icon={Clock} label={isEn ? 'Uptime' : '运行时间'} accent="from-primary/8">
          <span className="whitespace-nowrap text-primary">{formatUptime(uptime)}</span>
        </StatCard>
      </div>

      {/* 第二行：Token 分解与计费，仅在拿到 stats 后渲染 */}
      {stats && (
        <div className="grid grid-cols-6 gap-3">
          <StatCard
            icon={Activity}
            label={isEn ? 'Total Tokens' : '总 Tokens'}
            accent="from-indigo-500/8"
          >
            <span
              className="text-indigo-500"
              title={((stats.inputTokens || 0) + (stats.outputTokens || 0)).toLocaleString()}
            >
              {compactNumber((stats.inputTokens || 0) + (stats.outputTokens || 0))}
            </span>
          </StatCard>

          <StatCard
            icon={Activity}
            label={isEn ? 'Input / Output' : '输入 / 输出'}
            accent="from-blue-500/8"
          >
            <PairValue
              left={
                <span title={(stats.inputTokens || 0).toLocaleString()}>
                  {compactNumber(stats.inputTokens || 0)}
                </span>
              }
              right={
                <span title={(stats.outputTokens || 0).toLocaleString()}>
                  {compactNumber(stats.outputTokens || 0)}
                </span>
              }
              leftClass="text-blue-500"
              rightClass="text-purple-500"
            />
          </StatCard>

          <StatCard
            icon={Cpu}
            label={isEn ? 'Cache Hit' : '缓存命中'}
            accent="from-emerald-500/8"
            action={
              cacheHitRate > 0 ? (
                <Badge variant="secondary" className="px-1 py-0 text-3xs">
                  {cacheHitRate.toFixed(0)}%
                </Badge>
              ) : null
            }
          >
            <PairValue
              left={
                <span title={`${isEn ? 'Cache Read' : '缓存读取'}: ${cacheRead.toLocaleString()}`}>
                  {compactNumber(cacheRead)}
                </span>
              }
              right={
                <span
                  title={`${isEn ? 'Cache Write' : '缓存写入'}: ${(stats.cacheWriteTokens || 0).toLocaleString()}`}
                >
                  {compactNumber(stats.cacheWriteTokens || 0)}
                </span>
              }
              leftClass="text-emerald-500"
              rightClass="text-amber-500"
            />
          </StatCard>

          <StatCard
            icon={Zap}
            label={isEn ? 'Reasoning' : '推理 Tokens'}
            accent="from-violet-500/8"
          >
            <span className="text-violet-500" title={(stats.reasoningTokens || 0).toLocaleString()}>
              {compactNumber(stats.reasoningTokens || 0)}
            </span>
          </StatCard>

          <StatCard
            icon={UserCheck}
            label={isEn ? 'Success Rate' : '成功率'}
            accent="from-green-500/8"
          >
            <span className="text-success">
              {stats.totalRequests > 0
                ? `${((stats.successRequests / stats.totalRequests) * 100).toFixed(1)}%`
                : '-'}
            </span>
          </StatCard>

          <StatCard icon={Server} label="Credits" accent="from-amber-500/8">
            <span className="text-amber-500">{(stats.totalCredits || 0).toFixed(4)}</span>
          </StatCard>
        </div>
      )}
    </div>
  )
}
