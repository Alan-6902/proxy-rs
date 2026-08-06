import { ProxyPanel } from '../proxy'
import { PageHeader } from '../ui'
import { useTranslation } from '@/hooks/useTranslation'
import { Server } from 'lucide-react'

export function ProxyPage() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto stagger-children">
      <PageHeader
        icon={Server}
        eyebrow={isEn ? 'Service' : '服务'}
        title={isEn ? 'API Proxy Service' : 'API 反代服务'}
        description={
          isEn
            ? 'Provide OpenAI and Claude compatible API endpoints with multi-account rotation'
            : '提供 OpenAI 和 Claude 兼容的 API 端点，支持多账号轮询'
        }
      />
      <ProxyPanel />
    </div>
  )
}
