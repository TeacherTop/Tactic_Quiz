import type { Guess, NumericRanking, PlayerId } from './types'
import { PLAYERS } from './players'

export const NUMERIC_TIME_MS = 25_000
export const QUIZ_TIME_MS = 25_000
export const QUIZ_PER_MATCH = 5

export const SCORE_VALUES = {
  mcCorrect: 10,
  numericWin: 15,
  numericExactBonus: 5,
  capture: 20,
  lostTerritory: -20,
  hold: 5,
} as const

export function emptyGuesses(): Record<PlayerId, Guess> {
  return {
    you: { value: null, timeMs: null },
    alex: { value: null, timeMs: null },
    marina: { value: null, timeMs: null },
  }
}

export function emptyScores(): Record<PlayerId, number> {
  return { you: 0, alex: 0, marina: 0 }
}

export function rankNumericGuesses(
  answer: number,
  guesses: Record<PlayerId, Guess>,
): NumericRanking {
  const rows = PLAYERS.map((p) => {
    const g = guesses[p.id]
    const distance = g.value === null ? null : Math.abs(g.value - answer)
    return { id: p.id, distance, timeMs: g.timeMs }
  })

  rows.sort((a, b) => {
    if (a.distance === null && b.distance === null) return 0
    if (a.distance === null) return 1
    if (b.distance === null) return -1
    if (a.distance !== b.distance) return a.distance - b.distance
    const ta = a.timeMs ?? Number.POSITIVE_INFINITY
    const tb = b.timeMs ?? Number.POSITIVE_INFINITY
    return ta - tb
  })

  return rows
}

export function numericAward(rankIndex: number, missed: boolean): number {
  if (missed || rankIndex !== 0) return 0
  return SCORE_VALUES.numericWin
}

export function quizAward(correct: boolean): number {
  if (!correct) return 0
  return SCORE_VALUES.mcCorrect
}

export function addScores(
  scores: Record<PlayerId, number>,
  delta: Partial<Record<PlayerId, number>>,
): Record<PlayerId, number> {
  return {
    you: scores.you + (delta.you ?? 0),
    alex: scores.alex + (delta.alex ?? 0),
    marina: scores.marina + (delta.marina ?? 0),
  }
}

export function pickRandom<T>(items: T[], count: number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, count)
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(value)
}
