import { useState, useEffect } from 'react'
import { Card, CardContent, PageHeader } from '../ui'
import { Code, Info, Zap } from 'lucide-react'
import proxyRsIcon from '@/assets/proxy-rs-icon.svg'
import { useTranslation } from '@/hooks/useTranslation'
import { APP_NAME } from '../../../../shared/appIdentity'

/** 技术栈：名称 + 承担的职责，比一排灰色药丸更能说明架构。 */
const TECH_STACK: { name: string; roleEn: string; roleZh: string }[] = [
  { name: 'Electron', roleEn: 'Desktop shell', roleZh: '桌面外壳' },
  { name: 'React', roleEn: 'UI runtime', roleZh: '界面运行时' },
  { name: 'TypeScript', roleEn: 'Type safety', roleZh: '类型约束' },
  { name: 'Tailwind CSS', roleEn: 'Design tokens', roleZh: '设计令牌' },
  { name: 'Zustand', roleEn: 'State store', roleZh: '状态存储' },
  { name: 'Vite', roleEn: 'Build pipeline', roleZh: '构建管线' }
]

/** 功能清单：原本是 12 条 `✓` 单行文本，拆成标题 + 说明后才能建立阅读层级。 */
const FEATURES: { titleEn: string; titleZh: string; descEn: string; descZh: string }[] = [
  {
    titleEn: 'Multi-Account',
    titleZh: '多账号管理',
    descEn: 'Add, edit and remove any number of accounts',
    descZh: '支持添加、编辑、删除多个 Kiro 账号'
  },
  {
    titleEn: 'One-Click Switch',
    titleZh: '一键切换',
    descEn: 'Swap the active account without re-login',
    descZh: '快速切换当前使用的账号，无需重新登录'
  },
  {
    titleEn: 'Auto Refresh',
    titleZh: '自动刷新',
    descEn: 'Tokens renew before expiry to hold the session',
    descZh: 'Token 过期前自动刷新，保持登录状态'
  },
  {
    titleEn: 'Groups & Tags',
    titleZh: '分组与标签',
    descEn: 'Batch-assign groups and multiple tags',
    descZh: '多选账户批量设置分组与多标签'
  },
  {
    titleEn: 'Privacy Mode',
    titleZh: '隐私模式',
    descEn: 'Mask emails and identifiers on screen',
    descZh: '隐藏邮箱和账号敏感信息'
  },
  {
    titleEn: 'Batch Import',
    titleZh: '批量导入',
    descEn: 'SSO Token and OIDC credentials in bulk',
    descZh: '支持 SSO Token 和 OIDC 凭证批量导入'
  },
  {
    titleEn: 'API Proxy',
    titleZh: 'API 反代',
    descEn: 'OpenAI, Anthropic and Gemini compatible endpoints',
    descZh: '聚合 OpenAI、Anthropic 与 Gemini 兼容接口'
  },
  {
    titleEn: 'Proxy Pool',
    titleZh: '代理池',
    descEn: 'Account-bound outbound proxies with health checks',
    descZh: '账号绑定出口代理与健康检查'
  },
  {
    titleEn: 'Batch Registration',
    titleZh: '批量注册',
    descEn: 'Email OTP automation and account import',
    descZh: '邮箱验证码自动化与账号导入'
  },
  {
    titleEn: 'Auto Switch',
    titleZh: '自动换号',
    descEn: 'Fail over to an available account when quota runs low',
    descZh: '余额不足时自动切换可用账号'
  },
  {
    titleEn: 'Proxy Support',
    titleZh: '代理支持',
    descEn: 'HTTP, HTTPS and SOCKS5 upstreams',
    descZh: '支持 HTTP/HTTPS/SOCKS5 代理'
  },
  {
    titleEn: 'Themes',
    titleZh: '主题定制',
    descEn: '32 accent colors across dark and light modes',
    descZh: '32 种主题颜色，深色/浅色模式'
  }
]

export function AboutPage(): React.ReactNode {
  const [version, setVersion] = useState('...')
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  useEffect(() => {
    window.api.getAppVersion().then(setVersion)
  }, [])

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto stagger-children">
      <PageHeader
        eyebrow={isEn ? 'Local-first desktop client' : '本地优先桌面客户端'}
        title={APP_NAME}
        description={
          isEn
            ? 'Multi-account management and API reverse proxy, entirely on your own machine.'
            : '多账号管理与 API 反代，全部运行在你自己的机器上。'
        }
        visual={
          <img
            src={proxyRsIcon}
            alt={APP_NAME}
            className="h-16 w-16 shrink-0 drop-shadow-[0_6px_18px_color-mix(in_srgb,var(--gradient-from)_35%,transparent)]"
          />
        }
        badges={
          <span className="type-code rounded-full bg-primary/10 px-2.5 py-1 text-primary ring-1 ring-primary/20">
            v{version}
          </span>
        }
      />

      {/* 简介 */}
      <Card className="hover-lift">
        <CardContent className="space-y-4 p-6">
          <SectionLabel icon={Info} label={isEn ? 'Overview' : '关于本应用'} />
          {/* 首段用略大字号做引言，与后续正文分层 */}
          <p className="max-w-3xl text-base leading-relaxed text-foreground/80">
            {isEn
              ? `${APP_NAME} is a local multi-account and API proxy tool. It covers account pools, automatic token refresh, group and tag management, registration and subscriptions, plus protocol-compatible endpoints.`
              : `${APP_NAME} 是一款本地多账号与 API 反代工具，覆盖账号池、Token 自动刷新、分组标签、注册订阅以及多协议兼容接口。`}
          </p>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {isEn
              ? 'Built with Electron, React and TypeScript for Windows, macOS and Linux. All data stays on disk locally — nothing is uploaded.'
              : '基于 Electron + React + TypeScript 构建，支持 Windows、macOS 和 Linux。所有数据仅存储在本地磁盘，不会上传。'}
          </p>
        </CardContent>
      </Card>

      {/* 功能清单 */}
      <Card className="hover-lift">
        <CardContent className="space-y-5 p-6">
          <SectionLabel
            icon={Zap}
            label={isEn ? 'Features' : '主要功能'}
            meta={String(FEATURES.length).padStart(2, '0')}
          />
          <div className="grid gap-x-8 gap-y-px sm:grid-cols-2">
            {FEATURES.map((feature, index) => (
              <div
                key={feature.titleEn}
                className="group flex items-baseline gap-3 border-t border-border/45 py-3"
              >
                {/* 序号用等宽展示字，形成一条可扫读的左侧标尺 */}
                <span className="type-code w-6 shrink-0 text-muted-foreground/45 transition-colors group-hover:text-primary/70">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0">
                  <p className="type-title text-sm text-foreground">
                    {isEn ? feature.titleEn : feature.titleZh}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {isEn ? feature.descEn : feature.descZh}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 技术栈 */}
      <Card className="hover-lift">
        <CardContent className="space-y-5 p-6">
          <SectionLabel icon={Code} label={isEn ? 'Tech Stack' : '技术栈'} />
          <div className="grid gap-x-8 gap-y-px sm:grid-cols-2 lg:grid-cols-3">
            {TECH_STACK.map((tech) => (
              <div
                key={tech.name}
                className="flex items-baseline justify-between gap-3 border-t border-border/45 py-2.5"
              >
                <span className="type-title text-sm text-foreground">{tech.name}</span>
                <span className="type-eyebrow text-muted-foreground/70">
                  {isEn ? tech.roleEn : tech.roleZh}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 页脚：全大写小字 + 分隔线，替掉原来的 "Made with ♥" */}
      <div className="flex items-center gap-4 pb-2 pt-2">
        <span className="h-px flex-1 bg-border/60" />
        <p className="type-eyebrow text-muted-foreground/60">
          {APP_NAME} · v{version} · {isEn ? 'Runs locally' : '本地运行'}
        </p>
        <span className="h-px flex-1 bg-border/60" />
      </div>
    </div>
  )
}

/**
 * 区块标签：图标 + 全大写标题 + 可选计数。
 * 替掉原来 CardHeader/CardTitle 里"圆角色块图标 + 粗体中文"的重复写法，
 * 让卡片内的标题比正文轻、但比正文更有结构感。
 */
function SectionLabel({
  icon: Icon,
  label,
  meta
}: {
  icon: React.ElementType
  label: string
  meta?: string
}): React.ReactNode {
  return (
    <div className="flex items-center gap-2.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-primary" strokeWidth={2.2} />
      <span className="type-eyebrow text-foreground/70">{label}</span>
      {meta && <span className="type-code text-muted-foreground/50">{meta}</span>}
      <span className="ml-1 h-px flex-1 bg-border/50" />
    </div>
  )
}
