import { TerrainMark } from './TerrainMark'
import { motion, useReducedMotion } from 'framer-motion'
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

export function OnlineArenaGrid({ state, onChoose, viewerPlayerId }: { viewerPlayerId: string | null; state: Pick<MultiplayerGameState, 'arena' | 'players' | 'availableHexes' | 'activePlayerId' | 'selectedAttack' | 'phase' | 'roundResult' | 'battleRound'>; onChoose: (row: number, col: number) => void }) {
  const reducedMotion = useReducedMotion()
  const available = new Set(state.availableHexes)
  const ownerById = new Map(state.players.map((player) => [player.id, player]))
  const active = state.players.find((player) => player.id === state.activePlayerId)

  const target = state.selectedAttack
  const origin = target && state.arena.find(cell => cell.ownerId === state.activePlayerId && Math.max(Math.abs(cell.row - target.row), Math.abs(cell.col - target.col), Math.abs(cell.row + cell.col - target.row - target.col)) === 1)
  const targetCenter = target ? centerFor(target.row, target.col) : [0, 0]
  const originCenter = origin ? centerFor(origin.row, origin.col) : targetCenter
  const lost = state.phase === 'battle-result' && state.roundResult?.battleWinnerId !== state.activePlayerId

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
          <polygon points={pointsFor(cell.row, cell.col)} className={`arena-cell-fill${state.phase === 'battle-result' && state.roundResult?.battleWinnerId === state.activePlayerId && target?.row === cell.row && target?.col === cell.col ? ' is-battle-won' : ''}`} style={owner ? { fill: owner.color, ['--capture-from' as string]: ownerById.get(target?.ownerId ?? '')?.color ?? owner.color, ['--capture-to' as string]: owner.color } : undefined} />
          <TerrainMark x={centerFor(cell.row, cell.col)[0]} y={centerFor(cell.row, cell.col)[1]} />
          {owner ? <text x={centerFor(cell.row, cell.col)[0]} y={centerFor(cell.row, cell.col)[1] + 25} textAnchor="middle" className="online-cell-owner">{owner.name.slice(0, 1)}</text> : null}
        </motion.g>
      })}
      {target && active ? <motion.g
        key={`attacker-${state.battleRound}-${state.phase === 'battle-result' ? 'result' : 'attack'}`}
        className="online-warrior"
        aria-label={`Воин: ${active.name}${lost ? ', атака отбита' : ''}`}
        initial={{ x: state.phase === 'battle-result' ? targetCenter[0] : originCenter[0], y: (state.phase === 'battle-result' ? targetCenter[1] : originCenter[1]) - 12, opacity: 1 }}
        animate={{ x: targetCenter[0], y: reducedMotion ? targetCenter[1] - 12 : state.phase === 'battle-approach' ? [originCenter[1] - 12, Math.min(originCenter[1], targetCenter[1]) - 65, targetCenter[1] - 12] : targetCenter[1] - 12, opacity: lost ? 0 : 1, scale: lost ? 0.25 : 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.8, opacity: { delay: reducedMotion ? 0 : 0.5, duration: 0.6 } }}
        style={{ pointerEvents: 'none' }}
      >
        <ellipse cy="24" rx="12" ry="4" fill="#302619" opacity=".25" />
        <path d="M-5 12 L-7 23 M5 12 L7 23" stroke="#493c2f" strokeWidth="5" strokeLinecap="round" />
        <path d="M-8 1 Q0 -5 8 1 L9 14 L-9 14 Z" fill={active.color} stroke="#fff1d2" strokeWidth="1.5" />
        <circle cy="-8" r="7" fill="#f0cba0" stroke="#614831" strokeWidth="1.5" />
        <path d="M-7 -10 Q0 -21 7 -10 Z" fill="#666f70" stroke="#fff1d2" />
        <path d="M10 3 L16 -9" stroke="#fff1d2" strokeWidth="3" strokeLinecap="round" />
        <path d="M-13 1 L-6 1 L-6 10 Q-10 15 -14 9 Z" fill={active.color} stroke="#eac780" strokeWidth="2" />
      </motion.g> : null}
    </svg>
  </motion.section>
}
