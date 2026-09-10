import { afterEach, expect, it, vi } from 'vitest'
import { emitState, store } from './index'

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('does not let obsolete question timers close a later round', () => {
  vi.useFakeTimers()
  const { state: room } = store.createRoom({ id: 9001, first_name: 'Host' })
  store.joinRoom(room.roomCode, { id: 9002, first_name: 'Guest' }, 'guest-timer')
  store.startGame(room.roomId)
  emitState(room)
  vi.advanceTimersByTime(1000)
  // Both players finish early; the old 20-second timer must be cancelled.
  store.finishAnswering(room.roomId)
  emitState(room)
  vi.advanceTimersByTime(3500)
  expect(room.round).toBe(2)
  expect(room.phase).toBe('expansion')
  vi.advanceTimersByTime(15500)
  expect(room.phase).toBe('expansion')
  expect(room.answers).toEqual({})
  vi.advanceTimersByTime(4500)
  expect(room.phase).toBe('expansion-review')
})

it('shows the final capture for two seconds before opening the next question', () => {
  vi.useFakeTimers()
  const { state: room } = store.createRoom({id:9011,first_name:'Host'})
  store.joinRoom(room.roomCode, {id:9012,first_name:'Guest'}, 'capture-guest')
  store.startGame(room.roomId)
  store.finishAnswering(room.roomId)
  room.turnQueue = [room.hostPlayerId]
  store.beginCapture(room.roomId)
  const [row,col] = room.availableHexes[0].split(':').map(Number)
  store.selectHex(room.roomId, room.hostPlayerId,row,col)
  emitState(room)
  expect(room.phase).toBe('expansion-between')
  expect(room.activePlayerId).toBeNull()
  expect(room.availableHexes).toEqual([])
  expect(room.arena.find(cell => cell.row === row && cell.col === col)?.ownerId).toBe(room.hostPlayerId)
  vi.advanceTimersByTime(1999)
  expect(room.phase).toBe('expansion-between')
  expect(room.round).toBe(1)
  vi.advanceTimersByTime(1)
  expect(room.phase).toBe('expansion')
  expect(room.round).toBe(2)
  expect(room.timerEndsAt! - Date.now()).toBe(20000)
})
