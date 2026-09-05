type Props = {
  remainingMs: number
  totalMs: number
}

export function TimerRing({ remainingMs, totalMs }: Props) {
  const ratio = Math.max(0, Math.min(1, remainingMs / totalMs))
  const seconds = Math.ceil(remainingMs / 1000)
  const urgent = remainingMs <= 5000

  return (
    <div className={`timer ${urgent ? 'is-urgent' : ''}`} aria-label={`Осталось ${seconds} секунд`}>
      <svg viewBox="0 0 80 80" className="timer-svg">
        <circle cx="40" cy="40" r="34" className="timer-track" />
        <circle
          cx="40"
          cy="40"
          r="34"
          className="timer-value"
          style={{
            strokeDasharray: `${2 * Math.PI * 34}`,
            strokeDashoffset: `${(1 - ratio) * 2 * Math.PI * 34}`,
          }}
        />
      </svg>
      <span className="timer-num">{seconds}</span>
    </div>
  )
}
