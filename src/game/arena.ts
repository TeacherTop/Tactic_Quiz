import type { ArenaCell, PlayerId } from './types'

export const ARENA_RADIUS = 2

const DIRECTIONS: [number, number][] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
]

export function createArena(): ArenaCell[] {
  const cells: ArenaCell[] = []
  for (let row = -ARENA_RADIUS; row <= ARENA_RADIUS; row += 1) {
    for (let col = -ARENA_RADIUS; col <= ARENA_RADIUS; col += 1) {
      if (Math.abs(row + col) > ARENA_RADIUS) continue

      let owner: PlayerId | null = null
      if (row === 0 && col === -ARENA_RADIUS) owner = 'you'
      if (row === -ARENA_RADIUS && col === ARENA_RADIUS) owner = 'alex'
      if (row === ARENA_RADIUS && col === 0) owner = 'marina'
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
    for (const [row, col] of getNeighbors(cell.row, cell.col)) {
      const key = cellKey(row, col)
      if (!occupied.has(key)) available.add(key)
    }
  }

  if (available.size > 0) return available
  return new Set(cells.filter((cell) => !cell.owner).map((cell) => cellKey(cell.row, cell.col)))
}

export function isExpansionBreakthrough(cells: ArenaCell[], playerId: PlayerId): boolean {
  const adjacentFree = new Set<string>()
  for (const cell of cells.filter((candidate) => candidate.owner === playerId)) {
    for (const [row, col] of getNeighbors(cell.row, cell.col)) {
      const neighbor = cells.find((candidate) => candidate.row === row && candidate.col === col)
      if (neighbor && !neighbor.owner) adjacentFree.add(cellKey(row, col))
    }
  }
  return adjacentFree.size === 0 && cells.some((cell) => !cell.owner)
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

export function getAttackTargets(cells: ArenaCell[], playerId: PlayerId): ArenaCell[] {
  const targets = new Set<string>()
  for (const cell of cells.filter((candidate) => candidate.owner === playerId)) {
    for (const [row, col] of getNeighbors(cell.row, cell.col)) {
      const target = cells.find((candidate) => candidate.row === row && candidate.col === col)
      if (target?.owner && target.owner !== playerId) targets.add(cellKey(row, col))
    }
  }
  return cells.filter((cell) => targets.has(cellKey(cell.row, cell.col)))
}

export function captureOpponentCell(
  cells: ArenaCell[],
  attacker: PlayerId,
  targetRow: number,
  targetCol: number,
): ArenaCell[] {
  const target = getAttackTargets(cells, attacker)
    .find((cell) => cell.row === targetRow && cell.col === targetCol)
  if (!target) return cells
  return cells.map((cell) => (
    cell.row === targetRow && cell.col === targetCol
      ? { ...cell, owner: attacker }
      : cell
  ))
}

export function getNeighbors(row: number, col: number): [number, number][] {
  return DIRECTIONS
    .map(([rowOffset, colOffset]) => [row + rowOffset, col + colOffset] as [number, number])
    .filter(([neighborRow, neighborCol]) => Math.abs(neighborRow) <= ARENA_RADIUS
      && Math.abs(neighborCol) <= ARENA_RADIUS
      && Math.abs(neighborRow + neighborCol) <= ARENA_RADIUS)
}
