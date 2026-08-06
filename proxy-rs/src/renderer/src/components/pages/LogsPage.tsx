import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Trash2,
  Download,
  RefreshCw,
  Search,
  Filter,
  ArrowDown,
  ChevronsDown,
  Bug,
  X
} from 'lucide-react'
import { Button, Badge, Input, PageHeader } from '../ui'
import { useTranslation } from '../../hooks/useTranslation'
import { useVirtualizer } from '@tanstack/react-virtual'

interface LogEntry {
  timestamp: string
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  category: string
  message: string
  data?: unknown
}

type LogLevel = 'ALL' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

/* 级别标签配色：参考终端日志查看器，只让「级别」着色，正文保持中性。
 * 原先把整条 message 按级别染色，导致全是 INFO 时整屏发蓝、反而看不出重点。 */
const LEVEL_LABEL_COLORS: Record<string, string> = {
  DEBUG: 'text-muted-foreground/70',
  INFO: 'text-emerald-600 dark:text-emerald-400',
  WARN: 'text-amber-600 dark:text-amber-400',
  ERROR: 'text-red-600 dark:text-red-400'
}

/* 正文颜色：仅 WARN/ERROR 需要染色以便跨行扫读，DEBUG/INFO 用中性前景色。 */
const MESSAGE_COLORS: Record<string, string> = {
  DEBUG: 'text-muted-foreground',
  INFO: 'text-foreground/85',
  WARN: 'text-amber-700 dark:text-amber-300',
  ERROR: 'text-red-700 dark:text-red-300'
}

/* 分类名着色：同一分类固定同色，便于按来源纵向扫读 */
const CATEGORY_COLORS: Record<string, string> = {
  Kiro: 'text-blue-600 dark:text-blue-400',
  KiroAPI: 'text-cyan-600 dark:text-cyan-400',
  ProxyServer: 'text-violet-600 dark:text-violet-400'
}
const CATEGORY_COLOR_FALLBACK = 'text-muted-foreground/80'

/* 行布局：列宽集中定义，避免展开区缩进等处散落魔法值。
 * 紧凑单行（20px 行高）是密集日志可读性的关键，比 30px 多显示约 50% 条目。 */
const COL_TIME_PX = 92
const COL_LEVEL_PX = 44
/** 来源列宽：实测最长分类名 MainPoolRefreshScheduler 需 173px，留 4px 余量 */
const COL_CATEGORY_PX = 178
const ROW_GRID_TEMPLATE = `${COL_TIME_PX}px ${COL_LEVEL_PX}px ${COL_CATEGORY_PX}px minmax(0, 1fr)`
const ROW_GAP_PX = 10
/** 展开的 data 区左缩进：与 message 列起点对齐 */
const EXPANDED_INDENT_PX = COL_TIME_PX + COL_LEVEL_PX + COL_CATEGORY_PX + ROW_GAP_PX * 3
const ROW_HEIGHT_PX = 20
const ROW_HEIGHT_EXPANDED_PX = 148

const LEVEL_BTN_ACTIVE: Record<string, string> = {
  ALL: 'bg-primary text-primary-foreground',
  DEBUG: 'bg-gray-500 text-white',
  INFO: 'bg-blue-500 text-white',
  WARN: 'bg-amber-500 text-white',
  ERROR: 'bg-red-500 text-white'
}

export function LogsPage() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [filter, setFilter] = useState('')
  const [levelFilter, setLevelFilter] = useState<LogLevel>('ALL')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [timeRange, setTimeRange] = useState('all')
  // 显示数量默认 5K，用户改动后持久化到 localStorage（页面切换/重启后保留）
  const [displayLimit, setDisplayLimit] = useState<string>(() => {
    return localStorage.getItem('systemLogs_displayLimit') || '5000'
  })
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [newLogCount, setNewLogCount] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const prevLogCount = useRef(0)

  const fetchLogs = useCallback(async () => {
    try {
      const fetchCount = displayLimit === 'all' ? undefined : parseInt(displayLimit) || undefined
      const [allLogs, count] = await Promise.all([
        window.api.proxyGetLogs(fetchCount),
        window.api.proxyGetLogsCount()
      ])
      const newLogs = allLogs as LogEntry[]
      setLogs(newLogs)
      setTotalCount(count)
      // 如果用户不在底部，累计新日志数
      if (!isAtBottom && newLogs.length > prevLogCount.current) {
        setNewLogCount((prev) => prev + (newLogs.length - prevLogCount.current))
      }
      prevLogCount.current = newLogs.length
    } catch {
      // ignore
    }
  }, [isAtBottom, displayLimit])

  useEffect(() => {
    setIsLoading(true)
    fetchLogs().finally(() => setIsLoading(false))
    pollRef.current = setInterval(fetchLogs, 1500)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchLogs])

  // 持久化 displayLimit
  useEffect(() => {
    localStorage.setItem('systemLogs_displayLimit', displayLimit)
  }, [displayLimit])

  // 智能滚动：用户在底部时自动跟随
  useEffect(() => {
    if (isAtBottom && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs, isAtBottom])

  // 监听滚动位置
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setIsAtBottom(atBottom)
    if (atBottom) setNewLogCount(0)
  }, [])

  const scrollToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
      setIsAtBottom(true)
      setNewLogCount(0)
    }
  }

  const handleClear = async () => {
    await window.api.proxyClearLogs()
    setLogs([])
    setTotalCount(0)
    setNewLogCount(0)
  }

  const handleExport = () => {
    const content = filteredLogs
      .map((log) => {
        const dataStr = log.data
          ? ` ${typeof log.data === 'string' ? log.data : JSON.stringify(log.data)}`
          : ''
        return `${log.timestamp} [${log.level}][${log.category}] ${log.message}${dataStr}`
      })
      .join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `kiro-logs-${new Date().toISOString().slice(0, 10)}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  const categories = useMemo(() => Array.from(new Set(logs.map((l) => l.category))).sort(), [logs])

  const filteredLogs = useMemo(() => {
    const now = Date.now()
    const rangeMs =
      timeRange === '1h'
        ? 3600000
        : timeRange === '6h'
          ? 21600000
          : timeRange === '1d'
            ? 86400000
            : timeRange === '7d'
              ? 604800000
              : 0
    const lower = filter.toLowerCase()
    let result = logs.filter((log) => {
      if (rangeMs > 0 && now - new Date(log.timestamp).getTime() > rangeMs) return false
      if (levelFilter !== 'ALL' && log.level !== levelFilter) return false
      if (categoryFilter !== 'all' && log.category !== categoryFilter) return false
      if (lower) {
        return (
          log.message.toLowerCase().includes(lower) ||
          log.category.toLowerCase().includes(lower) ||
          (typeof log.data === 'string' && log.data.toLowerCase().includes(lower))
        )
      }
      return true
    })
    if (displayLimit !== 'all') {
      const limit = parseInt(displayLimit)
      if (limit > 0) result = result.slice(-limit)
    }
    return result
  }, [logs, levelFilter, categoryFilter, timeRange, displayLimit, filter])

  const levelCounts = {
    ALL: logs.length,
    DEBUG: logs.filter((l) => l.level === 'DEBUG').length,
    INFO: logs.filter((l) => l.level === 'INFO').length,
    WARN: logs.filter((l) => l.level === 'WARN').length,
    ERROR: logs.filter((l) => l.level === 'ERROR').length
  }

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts)
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`
    } catch {
      return ts
    }
  }

  return (
    <div className="h-full flex flex-col p-4 sm:p-5 gap-3">
      {/* 工具栏 */}
      <PageHeader
        dense
        icon={Bug}
        eyebrow={isEn ? 'Runtime' : '运行时'}
        title={isEn ? 'System Logs' : '系统日志'}
        description={
          isEn ? 'Live application and proxy runtime events' : '实时查看应用与代理运行事件'
        }
        badges={
          <>
            <Badge variant="secondary" className="type-code">
              {totalCount.toLocaleString()}
            </Badge>
            {isLoading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-xs"
              onClick={fetchLogs}
              title={isEn ? 'Refresh' : '刷新'}
              aria-label={isEn ? 'Refresh logs' : '刷新日志'}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{isEn ? 'Refresh' : '刷新'}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-xs"
              onClick={handleExport}
              title={isEn ? 'Export' : '导出'}
              aria-label={isEn ? 'Export logs' : '导出日志'}
            >
              <Download className="h-3.5 w-3.5" />
              <span>{isEn ? 'Export' : '导出'}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-xs text-red-500 hover:text-red-600"
              onClick={handleClear}
              title={isEn ? 'Clear All' : '清空'}
              aria-label={isEn ? 'Clear all logs' : '清空全部日志'}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>{isEn ? 'Clear' : '清空'}</span>
            </Button>
          </>
        }
      />

      {/* 搜索 + 筛选 */}
      <div className="flex flex-wrap items-center gap-2 flex-shrink-0 rounded-xl border border-border/60 bg-card/45 p-2">
        <div className="relative flex-1 min-w-[240px] max-w-lg">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="h-9 pl-9 pr-8 text-sm bg-background/70 border-border/60 focus-visible:ring-2"
            placeholder={isEn ? 'Filter by message, category...' : '按消息、分类搜索...'}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1"
              onClick={() => setFilter('')}
              aria-label={isEn ? 'Clear search' : '清空搜索'}
            >
              <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
            </button>
          )}
        </div>

        {/* 时间范围 */}
        <select
          className="h-9 px-2.5 text-xs rounded-lg border border-border bg-background/70 text-foreground cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring"
          value={timeRange}
          onChange={(e) => setTimeRange(e.target.value)}
        >
          <option value="all">{isEn ? 'All Time' : '全部时间'}</option>
          <option value="1h">1h</option>
          <option value="6h">6h</option>
          <option value="1d">1d</option>
          <option value="7d">7d</option>
        </select>

        {/* 分类 */}
        <select
          className="h-9 px-2.5 text-xs rounded-lg border border-border bg-background/70 text-foreground cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring max-w-[150px]"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="all">{isEn ? 'All Categories' : '全部分类'}</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>

        {/* 显示条数 */}
        <select
          className="h-9 px-2.5 text-xs rounded-lg border border-border bg-background/70 text-foreground cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring"
          value={displayLimit}
          onChange={(e) => setDisplayLimit(e.target.value)}
        >
          <option value="all">{isEn ? 'All' : '全部'}</option>
          <option value="5000">5K</option>
          <option value="10000">10K</option>
          <option value="50000">50K</option>
          <option value="100000">100K</option>
        </select>

        {/* 级别筛选 */}
        <div className="flex items-center gap-0.5 bg-muted/40 rounded-lg p-1 ml-auto">
          {(['ALL', 'DEBUG', 'INFO', 'WARN', 'ERROR'] as LogLevel[]).map((level) => (
            <button
              key={level}
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                levelFilter === level
                  ? LEVEL_BTN_ACTIVE[level]
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
              onClick={() => setLevelFilter(level)}
            >
              {level === 'ALL' ? (isEn ? 'All' : '全部') : level}
              <span className="ml-1 opacity-70">{String(levelCounts[level])}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 日志列表（虚拟滚动） */}
      <div className="flex-1 min-h-0 relative rounded-xl border border-border/70 bg-card/55 shadow-sm overflow-hidden flex flex-col">
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <Filter className="h-8 w-8 opacity-20" />
            <span className="text-sm">{isEn ? 'No logs to display' : '暂无日志'}</span>
            {filter && (
              <span className="text-sm">
                {isEn ? 'Try adjusting your filter' : '尝试调整搜索条件'}
              </span>
            )}
          </div>
        ) : (
          <>
            {/* 列头：紧凑行没有留白余量，用一行表头替代每行的视觉分隔 */}
            <div
              className="grid shrink-0 border-b border-border/60 bg-foreground/[0.03] px-3 py-1.5 font-mono text-3xs uppercase tracking-wider text-muted-foreground/60"
              style={{ gridTemplateColumns: ROW_GRID_TEMPLATE, columnGap: ROW_GAP_PX }}
            >
              <span>{isEn ? 'Time' : '时间'}</span>
              <span>{isEn ? 'Lvl' : '级别'}</span>
              <span>{isEn ? 'Source' : '来源'}</span>
              <span>{isEn ? 'Message' : '消息'}</span>
            </div>
            <VirtualLogList
              logs={filteredLogs}
              expandedIdx={expandedIdx}
              onToggleExpand={(idx) => setExpandedIdx(expandedIdx === idx ? null : idx)}
              containerRef={containerRef}
              onScroll={handleScroll}
              isAtBottom={isAtBottom}
              formatTime={formatTime}
            />
          </>
        )}

        {/* 回到底部浮动按钮 */}
        {!isAtBottom && (
          <button
            className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg hover:bg-primary/90 transition-all animate-in slide-in-from-bottom-2"
            onClick={scrollToBottom}
          >
            <ChevronsDown className="h-3.5 w-3.5" />
            {newLogCount > 0 ? (
              <>{isEn ? `${newLogCount} new` : `${newLogCount} 条新日志`}</>
            ) : (
              <>{isEn ? 'Bottom' : '回到底部'}</>
            )}
          </button>
        )}
      </div>

      {/* 底部状态栏 */}
      <div className="flex items-center justify-between text-xs text-muted-foreground flex-shrink-0 px-1">
        <div className="flex items-center gap-3">
          <span>
            {isEn ? 'Showing' : '显示'}{' '}
            <span className="font-mono">{filteredLogs.length.toLocaleString()}</span> /{' '}
            <span className="font-mono">{logs.length.toLocaleString()}</span>
          </span>
          {levelCounts.ERROR > 0 && (
            <span className="text-red-500">
              ● {levelCounts.ERROR} {isEn ? 'errors' : '错误'}
            </span>
          )}
          {levelCounts.WARN > 0 && (
            <span className="text-amber-500">
              ● {levelCounts.WARN} {isEn ? 'warnings' : '警告'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <ArrowDown
            className={`h-3 w-3 ${isAtBottom ? 'text-green-500' : 'text-muted-foreground/40'}`}
          />
          <span>
            {isAtBottom ? (isEn ? 'Following' : '跟随中') : isEn ? 'Scrolled up' : '已暂停跟随'}
          </span>
        </div>
      </div>
    </div>
  )
}

// 虚拟滚动日志列表 — 只渲染可视区域内的行
function VirtualLogList({
  logs,
  expandedIdx,
  onToggleExpand,
  containerRef,
  onScroll,
  isAtBottom,
  formatTime
}: {
  logs: LogEntry[]
  expandedIdx: number | null
  onToggleExpand: (idx: number) => void
  containerRef: React.RefObject<HTMLDivElement | null>
  onScroll: () => void
  isAtBottom: boolean
  formatTime: (ts: string) => string
}) {
  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (idx) => (expandedIdx === idx ? ROW_HEIGHT_EXPANDED_PX : ROW_HEIGHT_PX),
    overscan: 24
  })

  // 自动滚到底
  useEffect(() => {
    if (isAtBottom && logs.length > 0) {
      virtualizer.scrollToIndex(logs.length - 1, { align: 'end' })
    }
  }, [logs.length, isAtBottom, virtualizer])

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto font-mono text-2xs leading-none"
      onScroll={onScroll}
    >
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const idx = virtualRow.index
          const log = logs[idx]
          const isExpanded = expandedIdx === idx
          const hasData = log.data !== undefined && log.data !== null
          return (
            <div
              key={virtualRow.key}
              data-index={idx}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`
              }}
              className={`group cursor-pointer ${
                log.level === 'ERROR'
                  ? 'bg-red-500/[0.07] hover:bg-red-500/[0.12]'
                  : log.level === 'WARN'
                    ? 'bg-amber-500/[0.07] hover:bg-amber-500/[0.12]'
                    : 'hover:bg-foreground/[0.05]'
              }`}
              onClick={() => onToggleExpand(idx)}
            >
              <div
                className="grid items-baseline px-3"
                style={{
                  gridTemplateColumns: ROW_GRID_TEMPLATE,
                  columnGap: ROW_GAP_PX,
                  height: ROW_HEIGHT_PX
                }}
              >
                <span className="text-muted-foreground/55 tabular-nums select-all">
                  {formatTime(log.timestamp)}
                </span>
                {/* 级别用文字而非圆点：4 个字母本身即是标签，比色点更易辨认且不占额外列 */}
                <span className={`font-semibold ${LEVEL_LABEL_COLORS[log.level]}`}>
                  {log.level}
                </span>
                {/* 分类完整显示（不再 96px 截断成 Backgroun…），超长才省略 */}
                <span
                  className={`truncate ${CATEGORY_COLORS[log.category] ?? CATEGORY_COLOR_FALLBACK}`}
                  title={log.category}
                >
                  {log.category}
                </span>
                <span className="flex min-w-0 items-baseline gap-1">
                  <span className={`truncate ${MESSAGE_COLORS[log.level]}`}>{log.message}</span>
                  {hasData && (
                    <span className="shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground/80">
                      {isExpanded ? '▾' : '▸'}
                    </span>
                  )}
                </span>
              </div>
              {isExpanded && hasData && (
                <div
                  className="mb-1.5 mr-3 overflow-x-auto rounded-md border border-border/50 bg-foreground/[0.04] p-2.5"
                  style={{ marginLeft: EXPANDED_INDENT_PX }}
                >
                  <pre className="leading-4 whitespace-pre-wrap break-all text-muted-foreground">
                    {String(
                      typeof log.data === 'string' ? log.data : JSON.stringify(log.data, null, 2)
                    )}
                  </pre>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
