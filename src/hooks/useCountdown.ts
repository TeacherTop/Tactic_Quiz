import { useEffect, useRef, useState } from 'react'

export function useCountdown(
  running: boolean,
  durationMs: number,
  onEnd: () => void,
  resetKey = '',
): number {
  const [remainingMs, setRemainingMs] = useState(durationMs)
  const ended = useRef(false)
  const onEndRef = useRef(onEnd)

  useEffect(() => {
    onEndRef.current = onEnd
  }, [onEnd])

  useEffect(() => {
    if (!running) return
    ended.current = false
    const endAt = performance.now() + durationMs

    let frame = 0
    const tick = () => {
      const left = Math.max(0, endAt - performance.now())
      setRemainingMs(left)
      if (left <= 0) {
        if (!ended.current) {
          ended.current = true
          onEndRef.current()
        }
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [running, durationMs, resetKey])

  return running ? remainingMs : durationMs
}
