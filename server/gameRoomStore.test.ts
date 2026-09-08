import { describe, expect, it, vi } from 'vitest'
import { GameRoomStore } from './gameRoomStore'
import type { TelegramUser } from '../shared/multiplayer'

// Game mechanics use a deterministic fixture, independent of the installed content bank.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const fixture = JSON.stringify([{ category: 'Тест', type: 'multiple', question: 'Два плюс два?', correct_answer: '4', answers: ['4', '3', '5', '6'] }])
  return { ...actual, default: { ...actual,
    existsSync: (path: string) => String(path).endsWith('question_bank') || actual.existsSync(path),
    readdirSync: (path: string) => String(path).endsWith('question_bank') ? ['my_game_question1.json'] : actual.readdirSync(path),
    readFileSync: (path: string, encoding: BufferEncoding) => String(path).endsWith('my_game_question1.json') ? fixture : actual.readFileSync(path, encoding),
  } }
})

function user(id: number): TelegramUser {
  return { id, first_name: `Player ${id}` }
}

describe('GameRoomStore', () => {
  it('creates a six digit room and lets three players join', () => {
    const store = new GameRoomStore()
    const room = store.createRoom(user(1))
    expect(room.roomCode).toMatch(/^\d{6}$/)
    store.joinRoom(room.roomCode, user(2), 's2')
    const ready = store.joinRoom(room.roomCode, user(3), 's3')
    expect(ready.players.filter((player) => !player.botReplacementFor)).toHaveLength(3)
    expect(ready.status).toBe('preparing')
  })

  it('rejects a fourth human player', () => {
    const store = new GameRoomStore()
    const room = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 's2')
    store.joinRoom(room.roomCode, user(3), 's3')
    expect(() => store.joinRoom(room.roomCode, user(4), 's4')).toThrow('В комнате уже 3 игрока')
  })

  it('does not accept answers after the server timer expires', () => {
    vi.useFakeTimers()
    const store = new GameRoomStore()
    const room = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 's2')
    store.joinRoom(room.roomCode, user(3), 's3')
    const playing = store.startGame(room.roomId)
    vi.setSystemTime((playing.timerEndsAt ?? Date.now()) + 1)
    expect(() => store.submitAnswer(room.roomId, playing.players[0].id, 0)).toThrow('Время ответа истекло')
    vi.useRealTimers()
  })

  it('marks disconnected players and creates a bot replacement', () => {
    const store = new GameRoomStore()
    const room = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 'socket-two')
    const updated = store.markDisconnected('socket-two')
    expect(updated?.players.find((player) => player.socketId === null && player.telegramId === 2)?.status).toBe('disconnected')
    expect(updated?.players.some((player) => player.status === 'bot' && player.botReplacementFor)).toBe(true)
  })

  it('orders expansion captures by server answer time', () => {
    vi.useFakeTimers()
    const store = new GameRoomStore()
    const room = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 's2')
    store.joinRoom(room.roomCode, user(3), 's3')
    const playing = store.startGame(room.roomId)
    const correct = (store as unknown as { questionAnswers: Map<string, number> }).questionAnswers.get(room.roomId) ?? 0
    vi.setSystemTime(100)
    store.submitAnswer(room.roomId, playing.players[1].id, correct)
    vi.setSystemTime(200)
    const reviewed = store.submitAnswer(room.roomId, playing.players[0].id, correct)
    expect(reviewed.phase).toBe('expansion')
    vi.setSystemTime(300)
    const closed = store.submitAnswer(room.roomId, playing.players[2].id, 99)
    expect(closed.phase).toBe('expansion-review')
    expect(closed.turnQueue).toEqual([playing.players[1].id, playing.players[0].id])
    const capture = store.beginCapture(room.roomId)
    expect(capture.phase).toBe('expansion-capture')
    expect(capture.activePlayerId).toBe(playing.players[1].id)
    vi.useRealTimers()
  })

  it('scores battle capture without double awards', () => {
    vi.useFakeTimers()
    const store = new GameRoomStore()
    const room = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 's2')
    store.joinRoom(room.roomCode, user(3), 's3')
    const state = store.startGame(room.roomId)
    const attacker = state.players[0].id
    const defender = state.players[1].id
    state.phase = 'battle-select'
    state.activePlayerId = attacker
    state.battleRound = 0
    state.arena = [
      { row: 0, col: 0, ownerId: attacker },
      { row: 1, col: 0, ownerId: defender },
    ]
    const battle = store.chooseAttack(room.roomId, attacker, 1, 0)
    const correct = (store as unknown as { questionAnswers: Map<string, number> }).questionAnswers.get(room.roomId) ?? 0
    vi.setSystemTime(100)
    store.submitAnswer(room.roomId, attacker, correct)
    vi.setSystemTime(200)
    const resolved = store.submitAnswer(room.roomId, defender, correct + 1)
    expect(resolved.scores[attacker]).toBe(40)
    expect(resolved.scores[defender]).toBe(-20)
    expect(resolved.arena.find((cell) => cell.row === 1 && cell.col === 0)?.ownerId).toBe(attacker)
    expect(battle.phase).toBe('results')
    vi.useRealTimers()
  })
})
