import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui'
import { Heart, Code, Info, Zap } from 'lucide-react'
import proxyRsIcon from '@/assets/proxy-rs-icon.svg'
import { useTranslation } from '@/hooks/useTranslation'
import { APP_NAME } from '../../../../shared/appIdentity'

export function AboutPage() {
  const [version, setVersion] = useState('...')
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  useEffect(() => {
    window.api.getAppVersion().then(setVersion)
  }, [])

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-8">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative text-center space-y-4">
          <img src={proxyRsIcon} alt={APP_NAME} className="h-20 w-20 mx-auto" />
          <div>
            <h1 className="text-2xl font-bold text-primary">{APP_NAME}</h1>
            <p className="text-muted-foreground">{isEn ? `Version ${version}` : `版本 ${version}`}</p>
          </div>
        </div>
      </div>

      {/* Description */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Info className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'About' : '关于本应用'}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-3">
          <p>
            {isEn 
              ? `${APP_NAME} is a local multi-account and API proxy tool. It supports account pools, automatic token refresh, group/tag management, registration, subscriptions, and protocol-compatible endpoints.`
              : `${APP_NAME} 是一款本地多账号与 API 反代工具，支持账号池、Token 自动刷新、分组标签、注册订阅以及多协议兼容接口。`}
          </p>
          <p>
            {isEn 
              ? 'Built with Electron + React + TypeScript, supporting Windows, macOS and Linux. All data is stored locally to protect your privacy.'
              : '本应用使用 Electron + React + TypeScript 开发，支持 Windows、macOS 和 Linux 平台。所有数据均存储在本地，保护你的隐私安全。'}
          </p>
        </CardContent>
      </Card>

      {/* Features */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Features' : '主要功能'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Multi-Account' : '多账号管理'}</strong>{isEn ? ': Add, edit, delete multiple accounts' : '：支持添加、编辑、删除多个 Kiro 账号'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'One-Click Switch' : '一键切换'}</strong>{isEn ? ': Quick account switching' : '：快速切换当前使用的账号'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Auto Refresh' : '自动刷新'}</strong>{isEn ? ': Auto refresh tokens before expiry' : '：Token 过期前自动刷新，保持登录状态'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Groups & Tags' : '分组与标签'}</strong>{isEn ? ': Batch set groups/tags' : '：多选账户批量设置分组/标签，支持多标签'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Privacy Mode' : '隐私模式'}</strong>{isEn ? ': Hide sensitive info' : '：隐藏邮箱和账号敏感信息'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Batch Import' : '批量导入'}</strong>{isEn ? ': SSO Token & OIDC batch import' : '：支持 SSO Token 和 OIDC 凭证批量导入'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'API Proxy' : 'API 反代'}</strong>{isEn ? ': OpenAI, Anthropic and Gemini compatible endpoints' : '：聚合 OpenAI、Anthropic 与 Gemini 兼容接口'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Proxy Pool' : '代理池'}</strong>{isEn ? ': Account-bound outbound proxies and health checks' : '：账号绑定出口代理与健康检查'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Batch Registration' : '批量注册'}</strong>{isEn ? ': Email OTP automation and account import' : '：邮箱验证码自动化与账号导入'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Auto Switch' : '自动换号'}</strong>{isEn ? ': Switch when balance low' : '：余额不足时自动切换可用账号'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Proxy Support' : '代理支持'}</strong>{isEn ? ': HTTP/HTTPS/SOCKS5' : '：支持 HTTP/HTTPS/SOCKS5 代理'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Themes' : '主题定制'}</strong>{isEn ? ': 32 colors, dark/light mode' : '：32 种主题颜色，深色/浅色模式'}
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* Tech Stack */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Code className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Tech Stack' : '技术栈'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {['Electron', 'React', 'TypeScript', 'Tailwind CSS', 'Zustand', 'Vite'].map((tech) => (
              <span 
                key={tech}
                className="px-2.5 py-1 text-xs bg-muted rounded-full text-muted-foreground"
              >
                {tech}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="text-center text-xs text-muted-foreground py-4">
        <p className="flex items-center justify-center gap-1">
          Made with <Heart className="h-3 w-3 text-primary" /> for Kiro users
        </p>
      </div>
    </div>
  )
}
