import * as React from 'react'
import { switchKnobClass, switchTrackClass } from '@/lib/switchStyles'

export interface SwitchProps {
  id?: string
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ id, checked = false, onCheckedChange, disabled, className }, ref) => {
    return (
      <button
        ref={ref}
        id={id}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange?.(!checked)}
        className={switchTrackClass(checked, className)}
      >
        <span className={switchKnobClass(checked)} />
      </button>
    )
  }
)
Switch.displayName = 'Switch'

export { Switch }
