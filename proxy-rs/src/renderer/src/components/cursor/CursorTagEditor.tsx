import { useImperativeHandle, useState } from 'react'
import { X } from 'lucide-react'
import { Badge, Button, Input } from '../ui'

/** 一次贴多个标签时的分隔符：只认中英文逗号。标签本身允许带空格（如「赏帽 token2」）。 */
const TAG_SEPARATOR = /[,，]+/

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

export interface CursorTagEditorHandle {
  /**
   * 把输入框里还没回车的草稿并进标签并返回最终列表。父级提交前调用，
   * 用户输完直接点「保存」也不会丢；返回值可直接用，不用等 onChange 的状态更新。
   */
  flush: () => string[]
}

interface CursorTagEditorProps {
  ref?: React.Ref<CursorTagEditorHandle>
  tags: string[]
  onChange: (tags: string[]) => void
  /** 其它账号已有的标签，点一下直接加上。 */
  knownTags: string[]
  /** 没有标签时占位；这一行始终渲染，避免加第一颗标签时弹窗跳高。 */
  emptyText?: string
  disabled?: boolean
  autoFocus?: boolean
}

/** 标签编辑器：已选的药丸一行、输入框 + 添加按钮、已有标签一键补上。 */
export function CursorTagEditor({
  ref,
  tags,
  onChange,
  knownTags,
  emptyText = '还没有标签',
  disabled,
  autoFocus
}: CursorTagEditorProps): React.ReactNode {
  const [draft, setDraft] = useState('')

  const flush = (): string[] => {
    if (!draft.trim()) return tags
    const merged = normalizeTags([...tags, ...draft.split(TAG_SEPARATOR)])
    onChange(merged)
    setDraft('')
    return merged
  }

  useImperativeHandle(ref, () => ({ flush }))

  const suggestions = knownTags.filter(
    (tag) => !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())
  )

  return (
    <div className="space-y-3">
      <div className="flex min-h-8 flex-wrap items-center gap-1.5">
        {tags.length === 0 && <span className="text-sm text-muted-foreground">{emptyText}</span>}
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1 pr-1">
            {tag}
            <button
              type="button"
              aria-label={`移除标签 ${tag}`}
              className="rounded-sm p-0.5 hover:bg-foreground/10"
              disabled={disabled}
              onClick={() => onChange(tags.filter((item) => item !== tag))}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>

      <div className="flex gap-2">
        <Input
          value={draft}
          autoFocus={autoFocus}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              flush()
            }
          }}
          placeholder="输入标签后回车；多个用逗号分隔，标签内可以有空格"
        />
        <Button variant="outline" onClick={flush} disabled={disabled || !draft.trim()}>
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
                className="rounded-md border border-border/60 px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                disabled={disabled}
                onClick={() => onChange(normalizeTags([...tags, tag]))}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
