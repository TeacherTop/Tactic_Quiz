import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GameRoomStore } from './gameRoomStore'

type Entry = { id: string; category: string; type: string; question: string; correct_answer: string; incorrect_answers: string[]; answers: string[] }
const bank = JSON.parse(fs.readFileSync(new URL('../question_bank/my_game_question1.json', import.meta.url), 'utf8')) as Entry[]
describe('Russian history batch 001–100', () => {
  it('contains exactly 100 unique questions with sequential stable IDs', () => {
    expect(bank).toHaveLength(100)
    expect(new Set(bank.map(q => q.question)).size).toBe(100)
    expect(bank.map(q => q.id)).toEqual(Array.from({ length: 100 }, (_, i) => `ru_hist_${String(i + 1).padStart(3, '0')}`))
  })
  it('has exactly four distinct choices, correct first, and the requested schema', () => {
    for (const q of bank) {
      expect(Object.keys(q).sort()).toEqual(['id', 'category', 'type', 'question', 'correct_answer', 'incorrect_answers', 'answers'].sort())
      expect(q.category).toBe('История России')
      expect(q.type).toBe('multiple')
      expect(q.question.endsWith('?')).toBe(true)
      expect(q.incorrect_answers).toHaveLength(3)
      expect(q.answers).toEqual([q.correct_answer, ...q.incorrect_answers])
      expect(new Set(q.answers.map(a => a.trim().toLowerCase())).size).toBe(4)
      expect(q.answers.every(a => a.length > 0)).toBe(true)
    }
  })
  it('is loaded by the multiplayer game and keeps the correct answer after shuffling', () => {
    const store = new GameRoomStore()
    expect(store.hasQuestions()).toBe(true)
    const room = store.createRoom({ id: 501, first_name: 'Проверка' })
    store.joinRoom(room.roomCode, { id: 502, first_name: 'Второй' }, 'test-2')
    store.joinRoom(room.roomCode, { id: 503, first_name: 'Третий' }, 'test-3')
    const state = store.startGame(room.roomId)
    const q = bank.find(q => q.question === state.currentQuestion?.prompt)
    expect(q).toBeDefined()
    expect([...state.currentQuestion!.options].sort()).toEqual([...q!.answers].sort())
    const correct = (store as unknown as { questionAnswers: Map<string, number> }).questionAnswers.get(room.roomId)!
    expect(state.currentQuestion!.options[correct]).toBe(q!.correct_answer)
  })
})
