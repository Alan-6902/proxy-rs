import { useEffect, useState } from 'react'
import { Loader2, Tag, X } from 'lucide-react'
import type { CursorAccount } from '../../../../shared/cursorAccounts'
import { getCursorAccountDisplayEmail } from '../../../../shared/cursorAccounts'
import { Badge, Button, Input } from '../ui'
import { CursorDialogShell } from './CursorDialogShell'
import { errorText } from './_helpers'

interface CursorTagDialogProps {
  account: CursorAccount | null
  /** 其它账号已有的标签，点一下直接加上。 */
  knownTags: string[]
  onClose: () => void
  onSaved: (account: CursorAccount) => void
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}

export function CursorTagDialog({
  account,
  knownTags,
  onClose,
  onSaved
}: CursorTagDialogProps): React.ReactNode {
  const [tags, setTags] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setTags(account?.tags ?? [])
    setDraft('')
    setError('')
  }, [account])

  const addDraft = (): void => {
    // 支持一次贴多个：逗号、中文逗号、空格都当分隔符
    const incoming = draft.split(/[,，\s]+/)
    setTags((prev) => normalizeTags([...prev, ...incoming]))
    setDraft('')
  }

  const save = async (): Promise<void> => {
    if (!account) return
    setSaving(true)
    setError('')
    try {
      const result = await window.api.cursorAccountsUpdateTags(account.id, normalizeTags(tags))
      if (!result.success) throw new Error(result.error)
      onSaved(result.data)
      onClose()
    } catch (saveError) {
      setError(errorText(saveError, '保存标签失败'))
    } finally {
      setSaving(false)
    }
  }

  const suggestions = knownTags.filter(
    (tag) => !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())
  )

  return (
    <CursorDialogShell
      open={account !== null}
      onClose={onClose}
      title="编辑标签"
      icon={Tag}
      badge={
        account && (
          <Badge variant="secondary" className="max-w-[220px] truncate">
            {getCursorAccountDisplayEmail(account)}
          </Badge>
        )
      }
      widthClassName="w-[460px]"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Tag className="h-4 w-4" />}
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5 min-h-8">
          {tags.length === 0 && <span className="text-sm text-muted-foreground">还没有标签</span>}
          {tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 pr-1">
              {tag}
              <button
                type="button"
                aria-label={`移除标签 ${tag}`}
                className="rounded-sm p-0.5 hover:bg-foreground/10"
                onClick={() => setTags((prev) => prev.filter((item) => item !== tag))}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>

        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addDraft()
              }
            }}
            placeholder="输入标签后回车，多个用逗号分隔"
          />
          <Button variant="outline" onClick={addDraft} disabled={!draft.trim()}>
            添加
          </Button>
        </div>

        {suggestions.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">已有标签</p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="rounded-md border border-border/60 px-2 py-0.5 text-xs hover:bg-muted"
                  onClick={() => setTags((prev) => normalizeTags([...prev, tag]))}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </CursorDialogShell>
  )
}
