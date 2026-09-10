import { TerrainMark } from './TerrainMark'
import { motion } from 'framer-motion'
import type { MultiplayerGameState } from '../../shared/multiplayer'

const HEX_SIZE = 34
const HEX_HEIGHT = Math.sqrt(3) * HEX_SIZE
const VIEWBOX_WIDTH = 480
const VIEWBOX_HEIGHT = 530

function centerFor(row: number, col: number): [number, number] {
  return [
    VIEWBOX_WIDTH / 2 + row * HEX_SIZE * 1.5,
    VIEWBOX_HEIGHT / 2 + (col + row / 2) * HEX_HEIGHT,
  ]
}

function pointsFor(row: number, col: number): string {
  const [centerX, centerY] = centerFor(row, col)
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * index
    return `${centerX + HEX_SIZE * Math.cos(angle)},${centerY + HEX_SIZE * Math.sin(angle)}`
  }).join(' ')
}

function cellKey(row: number, col: number): string {
  return `${row}:${col}`
}

export function OnlineArenaGrid({ state, onChoose, viewerPlayerId }: { viewerPlayerId: string | null; state: MultiplayerGameState; onChoose: (row: number, col: number) => void }) {
  const available = new Set(state.availableHexes)
  const ownerById = new Map(state.players.map((player) => [player.id, player]))
  const active = state.players.find((player) => player.id === state.activePlayerId)

  return <motion.section className="arena-board-wrap online-svg-arena" aria-label="Онлайн-арена" initial={{ opacity: 0.5, y: 10, filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.8 }}>
    <svg className="arena-board" viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`} role="grid" aria-label="Онлайн гексагональная арена" style={{ ['--active-color' as string]: active?.color ?? '#fff' }}>
      {state.arena.map((cell) => {
        const key = cellKey(cell.row, cell.col)
        const owner = cell.ownerId ? ownerById.get(cell.ownerId) : null
        const selectable = available.has(key) && state.activePlayerId === viewerPlayerId
        return <motion.g
          key={key}
          className={[
            'arena-cell',
            owner ? 'is-owned' : '',
            selectable && state.phase === 'battle-select' ? 'is-attack-target' : '',
            selectable && state.phase !== 'battle-select' ? 'is-available' : '',
          ].join(' ')}
          style={{ ['--owner-color' as string]: owner?.color ?? active?.color ?? '#d9c093' }}
          role="gridcell"
          tabIndex={selectable ? 0 : -1}
          aria-disabled={!selectable}
          aria-label={`Сота ${cell.row}, ${cell.col}${owner ? `, ${owner.name}` : ''}`}
          whileTap={selectable ? { scale: 0.96 } : undefined}
          onClick={() => selectable && onChoose(cell.row, cell.col)}
          onKeyDown={(event) => {
            if (selectable && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault()
              onChoose(cell.row, cell.col)
            }
          }}
        >
          <polygon points={pointsFor(cell.row, cell.col)} className="arena-cell-fill" />
          <TerrainMark x={centerFor(cell.row, cell.col)[0]} y={centerFor(cell.row, cell.col)[1]} />
          {owner ? <text x={centerFor(cell.row, cell.col)[0]} y={centerFor(cell.row, cell.col)[1] + 25} textAnchor="middle" className="online-cell-owner">{owner.name.slice(0, 1)}</text> : null}
        </motion.g>
      })}
    </svg>
  </motion.section>
}
