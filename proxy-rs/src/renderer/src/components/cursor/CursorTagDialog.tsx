import { useEffect, useRef, useState } from 'react'
import { Loader2, Tag } from 'lucide-react'
import type { CursorAccount } from '../../../../shared/cursorAccounts'
import { getCursorAccountDisplayEmail } from '../../../../shared/cursorAccounts'
import { Badge, Button } from '../ui'
import { CursorDialogShell } from './CursorDialogShell'
import { CursorTagEditor, type CursorTagEditorHandle } from './CursorTagEditor'
import { errorText } from './_helpers'

interface CursorTagDialogProps {
  account: CursorAccount | null
  /** 其它账号已有的标签，点一下直接加上。 */
  knownTags: string[]
  onClose: () => void
  onSaved: (account: CursorAccount) => void
}

export function CursorTagDialog({
  account,
  knownTags,
  onClose,
  onSaved
}: CursorTagDialogProps): React.ReactNode {
  const [tags, setTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const editorRef = useRef<CursorTagEditorHandle>(null)

  useEffect(() => {
    setTags(account?.tags ?? [])
    setError('')
  }, [account])

  const save = async (): Promise<void> => {
    if (!account) return
    setSaving(true)
    setError('')
    try {
      // 输入框里没回车的那一个也算：用户输完直接点保存是最常见的操作
      const finalTags = editorRef.current?.flush() ?? tags
      const result = await window.api.cursorAccountsUpdateTags(account.id, finalTags)
      if (!result.success) throw new Error(result.error)
      onSaved(result.data)
      onClose()
    } catch (saveError) {
      setError(errorText(saveError, '保存标签失败'))
    } finally {
      setSaving(false)
    }
  }

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
        <CursorTagEditor
          ref={editorRef}
          tags={tags}
          onChange={setTags}
          knownTags={knownTags}
          disabled={saving}
          autoFocus
        />
      </div>
    </CursorDialogShell>
  )
}
