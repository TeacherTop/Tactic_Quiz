import type { PlayerId } from '../game/types'
import { PLAYERS } from '../game/players'

type Props = {
  scores: Record<PlayerId, number>
  highlight?: PlayerId | null
  badges?: Partial<Record<PlayerId, string>>
}

export function PlayerDock({ scores, highlight, badges }: Props) {
  return (
    <aside className="dock">
      {PLAYERS.map((p) => (
        <article
          key={p.id}
          className={`dock-card ${highlight === p.id ? 'is-turn' : ''}`}
          style={{ ['--accent' as string]: p.accent }}
        >
          <div className="dock-name">{p.name}</div>
          <div className="dock-score">{scores[p.id]}</div>
          {badges?.[p.id] ? <div className="dock-badge">{badges[p.id]}</div> : null}
        </article>
      ))}
    </aside>
  )
}
