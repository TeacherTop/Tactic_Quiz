import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => vi.useRealTimers())

function enterNumeric(store: GameRoomStore, room: import('../shared/multiplayer').MultiplayerGameState) {
  vi.setSystemTime(room.timerEndsAt!)
  store.advanceBattle(room.roomId)
  const correct = (store as unknown as { questionAnswers: Map<string, number> }).questionAnswers.get(room.roomId)!
  const ids = [room.activePlayerId!, room.selectedAttack!.ownerId!]
  ids.forEach(id => store.submitAnswer(room.roomId, id, correct))
  vi.setSystemTime(room.timerEndsAt!)
  store.advanceBattle(room.roomId)
}

function user(id: number): TelegramUser {
  return { id, first_name: `Player ${id}` }
}

describe('GameRoomStore', () => {
  it('creates a six digit room and lets three players join', () => {
    const store = new GameRoomStore()
    const { state: room } = store.createRoom(user(1))
    expect(room.roomCode).toMatch(/^\d{6}$/)
    store.joinRoom(room.roomCode, user(2), 's2')
    const ready = store.joinRoom(room.roomCode, user(3), 's3').state
    expect(ready.players.filter((player) => !player.botReplacementFor)).toHaveLength(3)
    expect(ready.status).toBe('waiting')
  })

  it('rejects a fourth human player', () => {
    const store = new GameRoomStore()
    const { state: room } = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 's2')
    store.joinRoom(room.roomCode, user(3), 's3')
    expect(() => store.joinRoom(room.roomCode, user(4), 's4')).toThrow('В комнате уже максимум игроков')
  })





  it('assigns distinct map colors to three friends', () => {
    const store = new GameRoomStore()
    const { state: room } = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 's2')
    const ready = store.joinRoom(room.roomCode, user(3), 's3').state
    expect(ready.players.map((player) => player.color)).toEqual(['#b55239', '#6f8d32', '#58758f'])
    expect(new Set(ready.players.map((player) => player.color)).size).toBe(3)
  })

  it('keeps the room in lobby until the host starts it', () => {
    const store = new GameRoomStore()
    const { state: room } = store.createRoom(user(1))
    const guest = store.joinRoom(room.roomCode, user(2), 's2')
    expect(room.status).toBe('waiting')
    expect(() => store.startGame(room.roomId, guest.playerId)).toThrow('Запускать игру может только создатель комнаты')
    const playing = store.startGame(room.roomId, room.hostPlayerId)
    expect(playing.status).toBe('playing')
    expect(playing.arena.every((cell) => cell.ownerId === null)).toBe(true)
  })

  it('lets only the host change room settings before start', () => {
    const store = new GameRoomStore()
    const { state: room } = store.createRoom(user(1))
    const guest = store.joinRoom(room.roomCode, user(2), 's2')
    expect(() => store.updateSettings(room.roomId, guest.playerId, { maxPlayers: 2, arenaRadius: 1, categories: [] })).toThrow('Настройки может менять только создатель комнаты')
    const updated = store.updateSettings(room.roomId, room.hostPlayerId, { maxPlayers: 2, arenaRadius: 1, categories: [] })
    expect(updated.settings).toEqual({ maxPlayers: 2, arenaRadius: 1, categories: [] })
    expect(updated.arena).toHaveLength(7)
  })

  it('does not accept answers after the server timer expires', () => {
    vi.useFakeTimers()
    const store = new GameRoomStore()
    const { state: room } = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 's2')
    store.joinRoom(room.roomCode, user(3), 's3')
    const playing = store.startGame(room.roomId, room.hostPlayerId)
    vi.setSystemTime((playing.timerEndsAt ?? Date.now()) + 1)
    expect(() => store.submitAnswer(room.roomId, playing.players[0].id, 0)).toThrow('Время ответа истекло')
    vi.useRealTimers()
  })

  it('does not add bot replacements while players are still in lobby', () => {
    const store = new GameRoomStore()
    const { state: room } = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 'socket-two')
    const updated = store.markDisconnected('socket-two')
    expect(updated?.status).toBe('waiting')
    expect(updated?.players.some((player) => player.status === 'bot')).toBe(false)
  })

  it('marks disconnected players and creates a bot replacement', () => {
    const store = new GameRoomStore()
    const { state: room } = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 'socket-two')
    store.startGame(room.roomId, room.hostPlayerId)
    const updated = store.markDisconnected('socket-two')
    expect(updated?.players.find((player) => player.socketId === null && player.telegramId === 2)?.status).toBe('disconnected')
    expect(updated?.players.some((player) => player.status === 'bot' && player.botReplacementFor)).toBe(true)
  })

  it('orders expansion captures by server answer time', () => {
    vi.useFakeTimers()
    const store = new GameRoomStore()
    const { state: room } = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 's2')
    store.joinRoom(room.roomCode, user(3), 's3')
    const playing = store.startGame(room.roomId, room.hostPlayerId)
    const correct = (store as unknown as { questionAnswers: Map<string, number> }).questionAnswers.get(room.roomId) ?? 0
    vi.setSystemTime(100)
    store.submitAnswer(room.roomId, playing.players[1].id, correct)
    vi.setSystemTime(200)
    const reviewed = store.submitAnswer(room.roomId, playing.players[0].id, correct)
    expect(reviewed.phase).toBe('expansion')
    vi.setSystemTime(300)
    const closed = store.submitAnswer(room.roomId, playing.players[2].id, (correct + 1) % 4)
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
    const { state: room } = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 's2')
    store.joinRoom(room.roomCode, user(3), 's3')
    const state = store.startGame(room.roomId, room.hostPlayerId)
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
    enterNumeric(store, room)
    const correct = (store as unknown as { questionAnswers: Map<string, number> }).questionAnswers.get(room.roomId) ?? 0
    vi.setSystemTime(100)
    store.submitAnswer(room.roomId, attacker, correct)
    vi.setSystemTime(200)
    const resolved = store.submitAnswer(room.roomId, defender, correct + 1)
    expect(resolved.scores[attacker]).toBe(50)
    expect(resolved.scores[defender]).toBe(-10)
    expect(resolved.arena.find((cell) => cell.row === 1 && cell.col === 0)?.ownerId).toBe(attacker)
    expect(battle.phase).toBe('battle-result')
    vi.setSystemTime(room.timerEndsAt!)
    store.advanceBattle(room.roomId)
    expect(battle.phase).toBe('results')
    vi.useRealTimers()
  })
  it('rejects outsiders, invalid choices and answers during review', () => {
    const store = new GameRoomStore()
    const { state: room } = store.createRoom(user(1))
    const guest = store.joinRoom(room.roomCode, user(2), 's2')
    store.startGame(room.roomId)
    expect(() => store.submitAnswer(room.roomId, 'outsider', 0)).toThrow()
    for (const answer of [NaN, Infinity, -1, 99, 0.5]) {
      expect(() => store.submitAnswer(room.roomId, guest.playerId, answer)).toThrow()
    }
    store.submitAnswer(room.roomId, guest.playerId, 0)
    store.submitAnswer(room.roomId, room.hostPlayerId, 0)
    expect(() => store.submitAnswer(room.roomId, guest.playerId, 1)).toThrow()
  })

  it('reuses the selected bank when all questions have been used', () => {
    const store = new GameRoomStore()
    const { state: room } = store.createRoom(user(1))
    store.joinRoom(room.roomCode, user(2), 's2')
    store.updateSettings(room.roomId, room.hostPlayerId, { maxPlayers: 2, arenaRadius: 1, categories: ['Тест'] })
    store.startGame(room.roomId)
    store.finishAnswering(room.roomId)
    store.beginCapture(room.roomId)
    expect(room.round).toBe(2)
    expect(room.currentQuestion?.prompt).toBe('Два плюс два?')
  })

  it('rotates attacks and excludes the third player from a duel', () => {
    vi.useFakeTimers()
    const store = new GameRoomStore()
    const { state: room } = store.createRoom(user(1))
    const guest = store.joinRoom(room.roomCode, user(2), 's2')
    const spectator = store.joinRoom(room.roomCode, user(3), 's3')
    store.startGame(room.roomId)
    room.phase = 'battle-select'
    room.activePlayerId = room.hostPlayerId
    room.arena = [{ row: 0, col: 0, ownerId: room.hostPlayerId }, { row: 1, col: 0, ownerId: guest.playerId }]
    store.chooseAttack(room.roomId, room.hostPlayerId, 1, 0)
    enterNumeric(store, room)
    expect(() => store.submitAnswer(room.roomId, spectator.playerId, 1)).toThrow()
    store.submitAnswer(room.roomId, guest.playerId, 1)
    store.finishAnswering(room.roomId)
    vi.setSystemTime(room.timerEndsAt!)
    store.advanceBattle(room.roomId)
    expect(room.activePlayerId).toBe(guest.playerId)
  })

})

it.each([2, 3] as const)('completes a full match with %i friends', count => {
  vi.useFakeTimers()
  const store = new GameRoomStore()
  const { state: room } = store.createRoom(user(51))
  for (let i = 1; i < count; i++) store.joinRoom(room.roomCode, user(51 + i), `full-${i}`)
  store.updateSettings(room.roomId, room.hostPlayerId, {maxPlayers:count,arenaRadius:1,categories:['Тест']})
  store.startGame(room.roomId)
  let steps = 0
  while (room.status !== 'finished' && steps++ < 150) {
    const correct = (store as unknown as { questionAnswers: Map<string, number> }).questionAnswers.get(room.roomId)!
    if (room.phase === 'expansion') {
      for (const player of room.players) store.submitAnswer(room.roomId, player.id, correct)
    } else if (room.phase === 'expansion-review') store.beginCapture(room.roomId)
    else if (room.phase === 'expansion-between') {
      vi.advanceTimersByTime(2000)
      store.completeCapturePause(room.roomId)
    } else if (room.phase === 'expansion-capture' || room.phase === 'battle-select') {
      const [row, col] = room.availableHexes[0].split(':').map(Number)
      if (room.phase === 'battle-select') store.chooseAttack(room.roomId, room.activePlayerId!, row, col)
      else store.selectHex(room.roomId, room.activePlayerId!, row, col)
    } else if (['battle-approach', 'battle-review', 'battle-result'].includes(room.phase)) {
      vi.setSystemTime(room.timerEndsAt!)
      store.advanceBattle(room.roomId)
    } else if (room.phase === 'battle-warmup') {
      const ids = [room.activePlayerId!, room.selectedAttack!.ownerId!]
      ids.forEach(id => store.submitAnswer(room.roomId, id, correct))
    } else if (room.phase === 'battle-number') {
      const attacker = room.activePlayerId!
      const defender = room.selectedAttack!.ownerId!
      store.submitAnswer(room.roomId, defender, correct)
      store.submitAnswer(room.roomId, attacker, correct + 1)
    }
  }
  expect(room.status).toBe('finished')
  expect(room.battleRound).toBe(count === 2 ? 8 : 9)
  expect(room.arena.every(cell => cell.ownerId)).toBe(true)
  expect(Object.values(room.scores).every(Number.isFinite)).toBe(true)
  vi.useRealTimers()
})

it.each([
  [true, false, 'a'], [false, true, 'b'], [false, false, 'b'], [null, null, 'b'], [true, true, 'numeric'],
] as const)('resolves battle choices: attacker %s defender %s', (aCorrect,bCorrect,outcome) => {
  vi.useFakeTimers()
  const store = new GameRoomStore()
  const {state:room} = store.createRoom(user(71))
  const guest = store.joinRoom(room.roomCode,user(72),'battle-guest')
  const third = store.joinRoom(room.roomCode,user(73),'battle-spectator')
  store.startGame(room.roomId)
  const attacker = room.hostPlayerId, defender = guest.playerId
  room.arena = [{row:0,col:0,ownerId:attacker},{row:1,col:0,ownerId:defender}]
  room.phase = 'battle-select'; room.activePlayerId = attacker
  store.chooseAttack(room.roomId,attacker,1,0)
  expect(room.phase).toBe('battle-approach')
  expect(room.currentQuestion?.type).not.toBe('numeric')
  expect(() => store.submitAnswer(room.roomId,attacker,0)).toThrow()
  vi.setSystemTime(room.timerEndsAt!)
  store.advanceBattle(room.roomId)
  expect(room.phase).toBe('battle-warmup')
  expect(() => store.submitAnswer(room.roomId,third.playerId,0)).toThrow()
  const answer = (store as unknown as {questionAnswers:Map<string,number>}).questionAnswers.get(room.roomId)!
  if(aCorrect !== null) store.submitAnswer(room.roomId,attacker,aCorrect ? answer : (answer+1)%4)
  if(bCorrect !== null) store.submitAnswer(room.roomId,defender,bCorrect ? answer : (answer+1)%4)
  store.finishAnswering(room.roomId)
  expect(room.phase).toBe('battle-review')
  vi.setSystemTime(room.timerEndsAt!)
  store.advanceBattle(room.roomId)
  if(outcome === 'numeric') {
    expect(room.phase).toBe('battle-number')
    expect(room.currentQuestion?.type).toBe('numeric')
    expect(room.answers).toEqual({})
    expect(room.timerEndsAt! - Date.now()).toBe(20000)
  } else {
    expect(room.phase).toBe('battle-result')
    expect(room.roundResult?.battleWinnerId).toBe(outcome === 'a' ? attacker : defender)
    expect(room.arena[1].ownerId).toBe(outcome === 'a' ? attacker : defender)
    // Keep the original defender for the result animation after a capture.
    expect(room.selectedAttack?.ownerId).toBe(defender)
    expect(room.timerEndsAt! - Date.now()).toBe(2500)
  }
})
