import type { Player } from './types'

export const PLAYERS: Player[] = [
  { id: 'you', name: 'Ты', kind: 'human', skill: 1, accent: '#A55336' },
  { id: 'alex', name: 'Алекс', kind: 'bot', skill: 0.74, accent: '#748343' },
  { id: 'marina', name: 'Марина', kind: 'bot', skill: 0.58, accent: '#657F89' },
]

export const PLAYER_BY_ID = Object.fromEntries(PLAYERS.map((p) => [p.id, p])) as Record<
  Player['id'],
  Player
>
