import type { ArenaCell, PlayerId } from './types'

export const ARENA_SIZE = 8

export function createArena(): ArenaCell[] {
  const cells: ArenaCell[] = []
  for (let row = 0; row < ARENA_SIZE; row += 1) {
    for (let col = 0; col < ARENA_SIZE; col += 1) {
      let owner: PlayerId | null = null
      if (row === ARENA_SIZE - 1 && col === 0) owner = 'you'
      if (row === 0 && col === ARENA_SIZE - 1) owner = 'alex'
      cells.push({ row, col, owner })
    }
  }
  return cells
}

export function cellKey(row: number, col: number): string {
  return `${row}:${col}`
}

export function getAvailableCells(cells: ArenaCell[], playerId: PlayerId): Set<string> {
  const occupied = new Set(cells.filter((cell) => cell.owner).map((cell) => cellKey(cell.row, cell.col)))
  const playerCells = cells.filter((cell) => cell.owner === playerId)
  const available = new Set<string>()

  for (const cell of playerCells) {
    for (const [row, col] of neighbors(cell.row, cell.col)) {
      const key = cellKey(row, col)
      if (!occupied.has(key)) available.add(key)
    }
  }

  return available
}

export function captureCell(
  cells: ArenaCell[],
  playerId: PlayerId,
  row: number,
  col: number,
): ArenaCell[] {
  const available = getAvailableCells(cells, playerId)
  const targetKey = cellKey(row, col)
  if (!available.has(targetKey)) return cells

  return cells.map((cell) => {
    if (cell.row !== row || cell.col !== col) return cell
    return { ...cell, owner: playerId }
  })
}

function neighbors(row: number, col: number): [number, number][] {
  const offsets: [number, number][] = [
    [row - 1, col],
    [row + 1, col],
    [row, col - 1],
    [row, col + 1],
  ]
  return offsets.filter(([r, c]) => r >= 0 && r < ARENA_SIZE && c >= 0 && c < ARENA_SIZE)
}
