export type MultiplayerPlayerStatus = 'connected' | 'disconnected' | 'bot'
export type MultiplayerRoomStatus = 'waiting' | 'preparing' | 'playing' | 'finished'
export type MultiplayerPhase = 'lobby' | 'expansion' | 'expansion-review' | 'expansion-capture' | 'battle-select' | 'battle-number' | 'results'
export type MultiplayerPlayerId = string

export type TelegramUser = {
  id: number
  first_name: string
  last_name?: string
  username?: string
  photo_url?: string
}

export type PublicQuestion = {
  id: string
  category: string
  type: 'multiple' | 'boolean' | 'numeric'
  prompt: string
  options: string[]
  unit?: string
}

export type MultiplayerPlayer = {
  id: MultiplayerPlayerId
  telegramId: number | null
  name: string
  color: string
  status: MultiplayerPlayerStatus
  socketId: string | null
  joinedAt: number
  disconnectedAt: number | null
  botReplacementFor?: MultiplayerPlayerId
}

export type MultiplayerHex = {
  row: number
  col: number
  ownerId: MultiplayerPlayerId | null
}

export type MultiplayerGameState = {
  roomId: string
  roomCode: string
  status: MultiplayerRoomStatus
  phase: MultiplayerPhase
  players: MultiplayerPlayer[]
  arena: MultiplayerHex[]
  currentQuestion: PublicQuestion | null
  usedQuestionIds: string[]
  answers: Record<MultiplayerPlayerId, number | number[] | null>
  answerTimes: Record<MultiplayerPlayerId, number>
  scores: Record<MultiplayerPlayerId, number>
  mcStats: Record<MultiplayerPlayerId, { correct: number; total: number }>
  activePlayerId: MultiplayerPlayerId | null
  turnQueue: MultiplayerPlayerId[]
  availableHexes: string[]
  selectedAttack: MultiplayerHex | null
  roundResult: {
    correctOption?: number
    correctPlayerIds: MultiplayerPlayerId[]
    numericWinnerId?: MultiplayerPlayerId
    exactBonusPlayerIds: MultiplayerPlayerId[]
  } | null
  round: number
  battleRound: number
  timerEndsAt: number | null
  updatedAt: number
}

export type ClientToServerEvents = {
  join_room: (payload: { roomCode: string; initData: string }, ack: SocketAck<MultiplayerGameState>) => void
  answer_submitted: (payload: { roomId: string; answer: number | number[] }, ack: SocketAck<void>) => void
  hex_selected: (payload: { roomId: string; row: number; col: number }, ack: SocketAck<void>) => void
  attack_chosen: (payload: { roomId: string; row: number; col: number }, ack: SocketAck<void>) => void
}

export type ServerToClientEvents = {
  state_update: (state: MultiplayerGameState) => void
  room_log: (entry: { roomId: string; message: string; at: number }) => void
  error_message: (message: string) => void
}

export type SocketAck<T> = (response: { ok: true; data: T } | { ok: false; error: string }) => void

export type CreateRoomResponse = {
  roomCode: string
  state: MultiplayerGameState
}

export type JoinRoomResponse = {
  state: MultiplayerGameState
}
