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
