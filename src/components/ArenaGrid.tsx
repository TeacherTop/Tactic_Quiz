import { ARENA_SIZE, cellKey, getAvailableCells } from '../game/arena'
import { PLAYER_BY_ID } from '../game/players'
import type { ArenaCell, PlayerId } from '../game/types'

type Props = {
  cells: ArenaCell[]
  activePlayer: PlayerId | null
  lastCapturedKey: string | null
  onCapture: (row: number, col: number) => void
}

export function ArenaGrid({ cells, activePlayer, lastCapturedKey, onCapture }: Props) {
  const available = activePlayer ? getAvailableCells(cells, activePlayer) : new Set<string>()
  const activeColor = activePlayer ? PLAYER_BY_ID[activePlayer].accent : '#ffffff'

  return (
    <section className="arena-board-wrap" aria-label="Арена 8 на 8">
      <div className="arena-board" style={{ ['--active-color' as string]: activeColor }}>
        {cells.map((cell) => {
          const key = cellKey(cell.row, cell.col)
          const owner = cell.owner ? PLAYER_BY_ID[cell.owner] : null
          const isAvailable = available.has(key)
          const isCaptured = lastCapturedKey === key
          return (
            <button
              key={key}
              type="button"
              className={[
                'arena-cell',
                owner ? 'is-owned' : '',
                isAvailable ? 'is-available' : '',
                isCaptured ? 'is-captured' : '',
              ].join(' ')}
              style={{ ['--owner-color' as string]: owner?.accent ?? activeColor }}
              disabled={!isAvailable}
              onClick={() => onCapture(cell.row, cell.col)}
              aria-label={`Клетка ${cell.row + 1}-${cell.col + 1}${owner ? `, ${owner.name}` : ''}`}
            >
              <span className="arena-cell-fill" />
            </button>
          )
        })}
      </div>
      <div className="arena-legend">
        <span>
          <b style={{ ['--legend-color' as string]: PLAYER_BY_ID.you.accent }} /> Игрок 1
        </span>
        <span>
          <b style={{ ['--legend-color' as string]: PLAYER_BY_ID.alex.accent }} /> Игрок 2
        </span>
        <span>{ARENA_SIZE}x{ARENA_SIZE}</span>
      </div>
    </section>
  )
}
