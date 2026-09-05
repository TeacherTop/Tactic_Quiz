import { ARENA_RADIUS, cellKey, getAvailableCells, getNeighbors } from '../game/arena'
import { PLAYER_BY_ID } from '../game/players'
import type { ArenaCell, PlayerId } from '../game/types'

const HEX_SIZE = 34
const HEX_HEIGHT = Math.sqrt(3) * HEX_SIZE
const VIEWBOX_WIDTH = 480
const VIEWBOX_HEIGHT = 530

function centerFor(cell: ArenaCell): [number, number] {
  return [
    VIEWBOX_WIDTH / 2 + cell.row * HEX_SIZE * 1.5,
    VIEWBOX_HEIGHT / 2 + (cell.col + cell.row / 2) * HEX_HEIGHT,
  ]
}

function pointsFor(cell: ArenaCell): string {
  const [centerX, centerY] = centerFor(cell)
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * index
    return `${centerX + HEX_SIZE * Math.cos(angle)},${centerY + HEX_SIZE * Math.sin(angle)}`
  }).join(' ')
}

type Props = {
  cells: ArenaCell[]
  activePlayer: PlayerId | null
  selectableKeys?: Set<string>
  lastCapturedKey: string | null
  onCapture: (row: number, col: number) => void
}

export function ArenaGrid({ cells, activePlayer, selectableKeys, lastCapturedKey, onCapture }: Props) {
  const available = selectableKeys ?? (activePlayer ? getAvailableCells(cells, activePlayer) : new Set<string>())
  const activeColor = activePlayer ? PLAYER_BY_ID[activePlayer].accent : '#ffffff'

  return (
    <section className="arena-board-wrap" aria-label={`Гексагональная арена, радиус ${ARENA_RADIUS}`}>
      <svg
        className="arena-board"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        role="grid"
        aria-label="Гексагональная арена"
        style={{ ['--active-color' as string]: activeColor }}
      >
        {cells.map((cell) => {
          const key = cellKey(cell.row, cell.col)
          const owner = cell.owner ? PLAYER_BY_ID[cell.owner] : null
          const isAvailable = available.has(key)
          const isAttackTarget = Boolean(selectableKeys?.has(key))
          const isSelectable = isAvailable || isAttackTarget
          const isCaptured = lastCapturedKey === key
          const hasBoundary = owner
            ? getNeighbors(cell.row, cell.col).some(([row, col]) => {
              const neighbor = cells.find((candidate) => candidate.row === row && candidate.col === col)
              return neighbor?.owner && neighbor.owner !== cell.owner
            })
            : false
          return (
            <g
              key={key}
              className={[
                'arena-cell',
                owner ? 'is-owned' : '',
                isAvailable && !isAttackTarget ? 'is-available' : '',
                isAttackTarget ? 'is-attack-target' : '',
                isCaptured ? 'is-captured' : '',
                hasBoundary ? 'has-boundary' : '',
              ].join(' ')}
              style={{ ['--owner-color' as string]: owner?.accent ?? activeColor }}
              role="gridcell"
              tabIndex={isSelectable ? 0 : -1}
              aria-disabled={!isSelectable}
              aria-label={`Сота ${cell.row}, ${cell.col}${owner ? `, ${owner.name}` : ''}`}
              onClick={() => {
                if (isSelectable) onCapture(cell.row, cell.col)
              }}
              onKeyDown={(event) => {
                if (isSelectable && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  onCapture(cell.row, cell.col)
                }
              }}
            >
              <polygon points={pointsFor(cell)} className="arena-cell-fill" />
              {isCaptured ? <circle cx={centerFor(cell)[0]} cy={centerFor(cell)[1]} r={HEX_SIZE * 0.2} className="arena-ripple" /> : null}
            </g>
          )
        })}
      </svg>
      <div className="arena-legend">
        <span>
          <b style={{ ['--legend-color' as string]: PLAYER_BY_ID.you.accent }} /> Игрок 1
        </span>
        <span>
          <b style={{ ['--legend-color' as string]: PLAYER_BY_ID.alex.accent }} /> Игрок 2
        </span>
        <span>{cells.length} сот · радиус {ARENA_RADIUS}</span>
      </div>
    </section>
  )
}
