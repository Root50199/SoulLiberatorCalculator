import { useEffect, useRef } from 'react'
import type { PointerEvent } from 'react'

const edges = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']

function useWindowGesture(onError: (message: string) => void) {
  const active = useRef(false)
  const pending = useRef(Promise.resolve())
  const frame = useRef<number | null>(null)
  function request(command: 'start' | 'update' | 'end' | 'step', edge?: string, amount?: number) {
    pending.current = pending.current.then(async () => {
      if (!window.soulLiberator) throw new Error('Desktop bridge unavailable.')
      await window.soulLiberator.resizeWindow(command, edge, amount)
    }).catch(error => {
      active.current = false
      console.error('Window gesture failed:', error)
      onError(error instanceof Error ? error.message : String(error))
    })
  }
  function end() {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    if (active.current) request('end')
    active.current = false
  }
  useEffect(() => {
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('blur', end)
      end()
    }
  }, [])
  function start(event: PointerEvent<HTMLElement>, edge: string) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    active.current = true
    request('start', edge)
  }
  const pointerHandlers = {
    onPointerMove() {
      if (!active.current || frame.current !== null) return
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        if (active.current) request('update')
      })
    },
    onPointerUp() { if (active.current) request('update'); end() },
    onPointerCancel: end,
    onLostPointerCapture: end,
  }
  return { request, start, pointerHandlers }
}

export function GateDrag({ onError }: { onError: (message: string) => void }) {
  const { start, pointerHandlers } = useWindowGesture(onError)
  return <div className="gate-window-frame" aria-hidden="true" title="Drag gate to move window"
    onPointerDown={event => start(event, 'move')} {...pointerHandlers} />
}

export function WindowResize({ onError }: { onError: (message: string) => void }) {
  const { request, start, pointerHandlers } = useWindowGesture(onError)
  return <div className="window-resize-handles">
    {edges.map(edge => <button key={edge} className={`window-resize window-resize-${edge}`}
      aria-label={`Resize window ${edge}`} title="Drag to resize; arrow keys adjust size"
      onPointerDown={event => start(event, edge)} {...pointerHandlers}
      onKeyDown={event => {
        const horizontal = edge.includes('e') || edge.includes('w')
        if (horizontal && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault()
          request('step', edge.includes('w') ? 'w' : 'e', event.key === 'ArrowRight' ? 20 : -20)
        } else if (['ArrowUp', 'ArrowDown'].includes(event.key) && (edge.includes('n') || edge.includes('s'))) {
          event.preventDefault()
          request('step', edge.includes('n') ? 'n' : 's', event.key === 'ArrowDown' ? 20 : -20)
        }
      }} />)}
  </div>
}
