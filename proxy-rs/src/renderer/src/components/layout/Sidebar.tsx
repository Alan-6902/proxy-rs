import { useEffect, useState } from 'react'
import {
  Home,
  Users,
  Settings,
  Info,
  ChevronRight,
  UserPlus,
  ScrollText,
  Network,
  Stethoscope,
  Archive,
  GripVertical,
  BadgeCheck,
  ListChecks,
  Crosshair,
  ChartLine,
  BookOpenCheck
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import proxyRsIcon from '@/assets/proxy-rs-icon.svg'
import { APP_NAME } from '../../../../shared/appIdentity'
import { useTranslation } from '@/hooks/useTranslation'

export type PageType =
  | 'home'
  | 'accounts'
  | 'tasks'
  | 'hunter'
  | 'kskLedger'
  | 'proxyStats'
  | 'proxyPool'
  | 'register'
  | 'seats'
  | 'diagnose'
  | 'configSync'
  | 'logs'
  | 'settings'
  | 'about'

interface SidebarProps {
  currentPage: PageType
  onPageChange: (page: PageType) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

const menuItemsConfig: { id: PageType; labelKey: string; icon: React.ElementType }[] = [
  { id: 'home', labelKey: 'nav.home', icon: Home },
  { id: 'accounts', labelKey: 'nav.accounts', icon: Users },
  { id: 'tasks', labelKey: 'nav.tasks', icon: ListChecks },
  { id: 'hunter', labelKey: 'nav.hunter', icon: Crosshair },
  { id: 'kskLedger', labelKey: 'nav.kskLedger', icon: BookOpenCheck },
  { id: 'proxyStats', labelKey: 'nav.proxyStats', icon: ChartLine },
  { id: 'proxyPool', labelKey: 'nav.proxyPool', icon: Network },
  { id: 'register', labelKey: 'nav.register', icon: UserPlus },
  { id: 'seats', labelKey: 'nav.seats', icon: BadgeCheck },
  { id: 'diagnose', labelKey: 'nav.diagnose', icon: Stethoscope },
  { id: 'configSync', labelKey: 'nav.configSync', icon: Archive },
  { id: 'logs', labelKey: 'nav.logs', icon: ScrollText },
  { id: 'settings', labelKey: 'nav.settings', icon: Settings },
  { id: 'about', labelKey: 'nav.about', icon: Info }
]

const SIDEBAR_ORDER_STORAGE_KEY = 'proxy-rs.sidebar-order'

function getInitialMenuItems(): typeof menuItemsConfig {
  try {
    const storedOrder = JSON.parse(localStorage.getItem(SIDEBAR_ORDER_STORAGE_KEY) || '[]')
    if (!Array.isArray(storedOrder)) return menuItemsConfig

    const itemsById = new Map(menuItemsConfig.map((item) => [item.id, item]))
    const orderedItems = storedOrder
      .map((id) => itemsById.get(id as PageType))
      .filter((item): item is (typeof menuItemsConfig)[number] => Boolean(item))
    const orderedIds = new Set(orderedItems.map((item) => item.id))
    for (const [configIndex, item] of menuItemsConfig.entries()) {
      if (orderedIds.has(item.id)) continue
      const previousConfiguredItem = menuItemsConfig
        .slice(0, configIndex)
        .reverse()
        .find((candidate) => orderedIds.has(candidate.id))
      const previousIndex = previousConfiguredItem
        ? orderedItems.findIndex((candidate) => candidate.id === previousConfiguredItem.id)
        : -1
      orderedItems.splice(previousIndex + 1, 0, item)
      orderedIds.add(item.id)
    }
    return orderedItems
  } catch {
    return menuItemsConfig
  }
}

export function Sidebar({ currentPage, onPageChange, collapsed, onToggleCollapse }: SidebarProps) {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [menuItems, setMenuItems] = useState(getInitialMenuItems)
  const [draggedPage, setDraggedPage] = useState<PageType | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(
        SIDEBAR_ORDER_STORAGE_KEY,
        JSON.stringify(menuItems.map((item) => item.id))
      )
    } catch {
      // localStorage 不可用时仍保留当前会话内排序
    }
  }, [menuItems])

  const moveMenuItem = (sourceId: PageType, targetId: PageType): void => {
    if (sourceId === targetId) return
    setMenuItems((items) => {
      const sourceIndex = items.findIndex((item) => item.id === sourceId)
      const targetIndex = items.findIndex((item) => item.id === targetId)
      if (sourceIndex < 0 || targetIndex < 0) return items

      const nextItems = [...items]
      const [sourceItem] = nextItems.splice(sourceIndex, 1)
      nextItems.splice(targetIndex, 0, sourceItem)
      return nextItems
    })
  }

  const moveMenuItemByOffset = (sourceId: PageType, offset: -1 | 1): void => {
    const sourceIndex = menuItems.findIndex((item) => item.id === sourceId)
    const targetItem = menuItems[sourceIndex + offset]
    if (targetItem) moveMenuItem(sourceId, targetItem.id)
  }

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 64 : 224 }}
      transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      className="glass-sidebar rounded-3xl flex flex-col overflow-hidden shrink-0"
    >
      {/* Logo */}
      <div className="h-14 flex items-center justify-center px-3 gap-2 overflow-hidden border-b border-white/10 dark:border-white/5">
        <AnimatePresence mode="wait" initial={false}>
          {collapsed ? (
            <motion.img
              key="logo-small"
              src={proxyRsIcon}
              alt={APP_NAME}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.2 }}
              className="h-10 w-10 object-contain"
            />
          ) : (
            <motion.div
              key="logo-full"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.2 }}
              className="flex items-center gap-2"
            >
              <img src={proxyRsIcon} alt={APP_NAME} className="h-8 w-8 shrink-0" />
              <span className="font-semibold text-foreground whitespace-nowrap text-sm">
                {APP_NAME}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Menu Items */}
      <nav
        className="flex-1 py-3 px-2 overflow-y-auto"
        aria-label={isEn ? 'Primary navigation' : '主导航'}
      >
        {!collapsed && (
          <div className="flex items-center justify-between px-2 pb-2 text-2xs font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
            <span>{isEn ? 'Navigation' : '导航'}</span>
            <span className="normal-case tracking-normal">
              {isEn ? 'Drag to sort' : '拖动排序'}
            </span>
          </div>
        )}
        <div className="space-y-1">
          {menuItems.map((item) => {
            const Icon = item.icon
            const isActive = currentPage === item.id
            const label = t(item.labelKey)
            return (
              <motion.div key={item.id} layout="position">
                <button
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', item.id)
                    setDraggedPage(item.id)
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const sourceId = event.dataTransfer.getData('text/plain') as PageType
                    if (menuItems.some((menuItem) => menuItem.id === sourceId)) {
                      moveMenuItem(sourceId, item.id)
                    }
                    setDraggedPage(null)
                  }}
                  onDragEnd={() => setDraggedPage(null)}
                  onClick={() => onPageChange(item.id)}
                  onKeyDown={(event) => {
                    if (!event.altKey) return
                    if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      moveMenuItemByOffset(item.id, -1)
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      moveMenuItemByOffset(item.id, 1)
                    }
                  }}
                  aria-current={isActive ? 'page' : undefined}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  aria-label={`${label}，${isEn ? 'drag to reorder or use Alt + arrow keys' : '可拖动排序，也可按 Option + 方向键排序'}`}
                  className={cn(
                    'group relative w-full flex items-center rounded-xl text-sm font-medium transition-[color,background-color,box-shadow,opacity] duration-200 overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 cursor-grab active:cursor-grabbing',
                    isActive
                      ? 'text-primary-foreground shadow-[0_4px_16px_rgba(91,140,255,0.35)]'
                      : 'text-muted-foreground hover:text-foreground hover:bg-white/40 dark:hover:bg-white/5',
                    collapsed ? 'justify-center p-2.5' : 'gap-2.5 px-2.5 py-2.5',
                    draggedPage === item.id && 'opacity-40'
                  )}
                  title={collapsed ? `${label} · ${isEn ? 'Drag to sort' : '拖动排序'}` : undefined}
                >
                  {/* 激活态：渐变背景（主题色随动） */}
                  {isActive && (
                    <motion.span
                      layoutId="sidebar-active-pill"
                      className="absolute inset-0 rounded-xl"
                      style={{
                        background:
                          'linear-gradient(135deg, var(--gradient-from), var(--gradient-to))'
                      }}
                      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                    />
                  )}
                  {!collapsed && (
                    <GripVertical
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 relative z-10 opacity-30 group-hover:opacity-70 transition-opacity',
                        isActive && 'text-white/80'
                      )}
                    />
                  )}
                  <Icon
                    className={cn('h-5 w-5 shrink-0 relative z-10', isActive ? 'text-white' : '')}
                  />
                  <AnimatePresence initial={false}>
                    {!collapsed && (
                      <motion.span
                        key="label"
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -8 }}
                        transition={{ duration: 0.15 }}
                        className={cn('whitespace-nowrap relative z-10', isActive && 'text-white')}
                      >
                        {label}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>
              </motion.div>
            )
          })}
        </div>
      </nav>

      {/* Collapse Toggle */}
      <div className="p-2 border-t border-white/10 dark:border-white/5">
        <button
          onClick={onToggleCollapse}
          className="group w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm text-muted-foreground hover:text-primary hover:bg-white/40 dark:hover:bg-white/5 transition-all overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          title={collapsed ? (isEn ? 'Expand' : '展开侧边栏') : isEn ? 'Collapse' : '收起侧边栏'}
        >
          <motion.div
            animate={{ rotate: collapsed ? 0 : 180 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="shrink-0"
          >
            <ChevronRight className="h-4 w-4" />
          </motion.div>
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.span
                key="collapse-label"
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.15 }}
                className="whitespace-nowrap overflow-hidden"
              >
                {isEn ? 'Collapse' : '收起'}
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </div>
    </motion.aside>
  )
}
