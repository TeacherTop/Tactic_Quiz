import { describe, it, expect } from 'vitest'
import { arenaRadius, botPlayerIds, defaultBotSettings, numericQuestionsForTopics, parseBotSettings, questionsForTopics, BOT_SKILL } from './botSettings'
import { createArena, getAvailableCells, captureCell, getAttackTargets } from './arena'
import type { QuizQuestion } from './types'

describe('Bot settings and arena rules', () => {
  it('defaults to medium, two opponents, 19 cells and every topic', () => {
    expect(parseBotSettings(null, ['История', 'Кино'])).toEqual({ difficulty: 'medium', opponents: 2, arenaSize: 19, categories: ['История', 'Кино'] })
  })
  it('restores valid choices while dropping removed categories', () => {
    const settings = { difficulty: 'hard', opponents: 1, arenaSize: 37, categories: ['История', 'Удалённая'] }
    expect(parseBotSettings(JSON.stringify(settings), ['История'])).toEqual({ ...settings, categories: ['История'] })
  })
  it('preserves an explicit reset and handles corrupt stored data', () => {
    expect(parseBotSettings('{broken', ['История'])).toEqual(defaultBotSettings(['История']))
    expect(parseBotSettings('{"categories":[]}', ['История']).categories).toEqual([])
  })
  it('uses distinctly increasing skills', () => { expect(BOT_SKILL.easy).toBeLessThan(BOT_SKILL.medium); expect(BOT_SKILL.medium).toBeLessThan(BOT_SKILL.hard) })
  for (const size of [7, 19, 37] as const) for (const opponents of [1, 2] as const) {
    it(`creates ${size} cells with ${opponents} opponent(s), with no off-board moves`, () => {
      const settings = { ...defaultBotSettings([]), arenaSize: size, opponents }
      const players = botPlayerIds(settings)
      let cells = createArena(arenaRadius(size), players)
      expect(cells).toHaveLength(size)
      expect(cells.filter(c => c.owner)).toHaveLength(opponents + 1)
      expect(new Set(cells.filter(c => c.owner).map(c => c.owner))).toEqual(new Set(players))
      // Fill every cell, ensuring frontier expansion works on small and large boards.
      let turn = 0
      while (cells.some(c => !c.owner)) {
        const player = players[turn++ % players.length]!
        const available = [...getAvailableCells(cells, player)]
        expect(available.length).toBeGreaterThan(0)
        for (const key of available) expect(cells.some(c => `${c.row}:${c.col}` === key && !c.owner)).toBe(true)
        const [row, col] = available[0]!.split(':').map(Number)
        cells = captureCell(cells, player, row!, col!)
      }
      expect(cells.every(c => c.owner)).toBe(true)
      expect(players.some(player => getAttackTargets(cells, player).length)).toBe(true)
      expect(getAvailableCells(cells, 'you').size).toBe(0)
    })
  }
  it('keeps questions and derived numeric duels within selected topics', () => {
    const questions: QuizQuestion[] = [
      { id: 'history', category: 'История', prompt: 'В каком году?', options: ['882', '900', '912', '988'], correctIndex: 0 },
      { id: 'math', category: 'Математика', prompt: 'Сколько?', options: ['1', '2', '3', '4'], correctIndex: 1 },
    ]
    const selected = questionsForTopics(questions, ['История'])
    expect(selected.map(q => q.id)).toEqual(['history'])
    expect(numericQuestionsForTopics(selected)).toEqual([{ id: 'number-history', prompt: 'В каком году?', answer: 882 }])
    expect(questionsForTopics(questions, [])).toEqual([])
  })
})
