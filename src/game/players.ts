import type { Player } from './types'

export const PLAYERS: Player[] = [
  { id: 'you', name: 'Ты', kind: 'human', skill: 1, accent: '#3ee0c3' },
  { id: 'alex', name: 'Алекс', kind: 'bot', skill: 0.74, accent: '#ff9a3c' },
  { id: 'marina', name: 'Марина', kind: 'bot', skill: 0.58, accent: '#c084fc' },
]

export const PLAYER_BY_ID = Object.fromEntries(PLAYERS.map((p) => [p.id, p])) as Record<
  Player['id'],
  Player
>
