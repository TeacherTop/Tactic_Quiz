export type PlayerId = 'you' | 'alex' | 'marina'

export type PlayerKind = 'human' | 'bot'

export type Player = {
  id: PlayerId
  name: string
  kind: PlayerKind
  skill: number
  accent: string
}

export type NumericQuestion = {
  id: string
  category?: string
  prompt: string
  answer: number
  unit?: string
}

export type QuizQuestion = {
  id: string
  category?: string
  prompt: string
  options: [string, string, string, string]
  correctIndex: 0 | 1 | 2 | 3
}

export type Guess = {
  value: number | null
  timeMs: number | null
}

export type NumericRanking = {
  id: PlayerId
  distance: number | null
  timeMs: number | null
}[]

export type ArenaCell = {
  row: number
  col: number
  owner: PlayerId | null
}
