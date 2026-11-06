import {
  Home,
  Users,
  Settings,
  Info,
  ScrollText,
  Stethoscope,
  Network,
  Archive,
  ListChecks,
  LayoutDashboard,
  Sparkles,
  Terminal,
  Bot
} from 'lucide-react'

export type PageType =
  | 'home'
  | 'accounts'
  | 'tasks'
  | 'diagnose'
  | 'serena'
  | 'configSync'
  | 'kiroAdmin'
  | 'antigravityAdmin'
  | 'qoderAdmin'
  | 'kiroLogs'
  | 'logs'
  | 'settings'
  | 'about'

export const menuItemsConfig: { id: PageType; labelKey: string; icon: React.ElementType }[] = [
  { id: 'home', labelKey: 'nav.home', icon: Home },
  { id: 'accounts', labelKey: 'nav.accounts', icon: Users },
  { id: 'tasks', labelKey: 'nav.tasks', icon: ListChecks },
  { id: 'diagnose', labelKey: 'nav.diagnose', icon: Stethoscope },
  { id: 'serena', labelKey: 'nav.serena', icon: Network },
  { id: 'configSync', labelKey: 'nav.configSync', icon: Archive },
  { id: 'kiroAdmin', labelKey: 'nav.kiroAdmin', icon: LayoutDashboard },
  { id: 'antigravityAdmin', labelKey: 'nav.antigravityAdmin', icon: Sparkles },
  { id: 'qoderAdmin', labelKey: 'nav.qoderAdmin', icon: Bot },
  { id: 'kiroLogs', labelKey: 'nav.kiroLogs', icon: Terminal },
  { id: 'logs', labelKey: 'nav.logs', icon: ScrollText },
  { id: 'settings', labelKey: 'nav.settings', icon: Settings },
  { id: 'about', labelKey: 'nav.about', icon: Info }
]

export function isPageType(value: unknown): value is PageType {
  return menuItemsConfig.some((item) => item.id === value)
}
