import { useEffect, useRef, useState } from 'react'

export function useCountdown(
  running: boolean,
  durationMs: number,
  onEnd: () => void,
  resetKey = '',
  paused = false,
): number {
  const [remainingMs, setRemainingMs] = useState(durationMs)
  const remainingRef = useRef(durationMs)
  const resetKeyRef = useRef(resetKey)
  const ended = useRef(false)
  const onEndRef = useRef(onEnd)

  useEffect(() => {
    onEndRef.current = onEnd
  }, [onEnd])

  useEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey
      remainingRef.current = durationMs
      setRemainingMs(durationMs)
    }
    if (!running) {
      remainingRef.current = durationMs
      setRemainingMs(durationMs)
      return
    }
    if (paused) return
    ended.current = false
    const endAt = performance.now() + remainingRef.current

    let frame = 0
    const tick = () => {
      const left = Math.max(0, endAt - performance.now())
      remainingRef.current = left
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
  }, [running, durationMs, resetKey, paused])

  return running ? remainingMs : durationMs
}
