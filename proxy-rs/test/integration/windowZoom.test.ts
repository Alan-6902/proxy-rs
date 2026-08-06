import { describe, expect, it } from 'vitest'
import {
  getNextWindowZoomLevel,
  resolveWindowZoomAction,
  type WindowZoomInput
} from '../../src/main/windowZoom'

const keyboardInput = (overrides: Partial<WindowZoomInput>): WindowZoomInput => ({
  type: 'keyDown',
  key: '',
  code: '',
  meta: true,
  control: false,
  alt: false,
  ...overrides
})

describe('window zoom shortcuts', () => {
  it('recognizes macOS zoom in, zoom out, and reset shortcuts', () => {
    expect(resolveWindowZoomAction(keyboardInput({ key: '+', code: 'Equal' }))).toBe('in')
    expect(resolveWindowZoomAction(keyboardInput({ key: '-', code: 'Minus' }))).toBe('out')
    expect(resolveWindowZoomAction(keyboardInput({ key: '0', code: 'Digit0' }))).toBe('reset')
  })

  it('uses the physical minus key when the keyboard layout changes the key value', () => {
    expect(resolveWindowZoomAction(keyboardInput({ key: 'Unidentified', code: 'Minus' }))).toBe(
      'out'
    )
  })

  it('supports Control shortcuts and ignores unrelated input', () => {
    expect(
      resolveWindowZoomAction(
        keyboardInput({ key: '-', code: 'Minus', meta: false, control: true })
      )
    ).toBe('out')
    expect(
      resolveWindowZoomAction(
        keyboardInput({ key: '-', code: 'Minus', meta: false, control: false })
      )
    ).toBeNull()
    expect(
      resolveWindowZoomAction(keyboardInput({ key: '-', code: 'Minus', alt: true }))
    ).toBeNull()
    expect(
      resolveWindowZoomAction(keyboardInput({ type: 'keyUp', key: '-', code: 'Minus' }))
    ).toBeNull()
  })

  it('changes one zoom level at a time, resets, and clamps the supported range', () => {
    expect(getNextWindowZoomLevel(2, 'out')).toBe(1)
    expect(getNextWindowZoomLevel(2, 'in')).toBe(3)
    expect(getNextWindowZoomLevel(2, 'reset')).toBe(0)
    expect(getNextWindowZoomLevel(-3, 'out')).toBe(-3)
    expect(getNextWindowZoomLevel(5, 'in')).toBe(5)
  })
})
