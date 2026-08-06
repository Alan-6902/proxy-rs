export type WindowZoomAction = 'in' | 'out' | 'reset'

export interface WindowZoomInput {
  type: string
  key: string
  code: string
  meta: boolean
  control: boolean
  alt: boolean
}

const MIN_ZOOM_LEVEL = -3
const MAX_ZOOM_LEVEL = 5

export function resolveWindowZoomAction(input: WindowZoomInput): WindowZoomAction | null {
  if (input.type !== 'keyDown' || (!input.meta && !input.control) || input.alt) return null

  if (input.code === 'Minus' || input.key === '-' || input.key === '_') return 'out'
  if (input.code === 'Equal' || input.key === '=' || input.key === '+') return 'in'
  if (input.code === 'Digit0' || input.key === '0') return 'reset'
  return null
}

export function getNextWindowZoomLevel(currentLevel: number, action: WindowZoomAction): number {
  if (action === 'reset') return 0
  const nextLevel = currentLevel + (action === 'in' ? 1 : -1)
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, nextLevel))
}
