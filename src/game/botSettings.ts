import type { NumericQuestion, PlayerId, QuizQuestion } from './types'

export type BotSettings = { difficulty: 'easy' | 'medium' | 'hard'; opponents: 1 | 2; arenaSize: 7 | 19 | 37; categories: string[] }
export const BOT_SETTINGS_KEY = 'quiz-bot-settings-v1'
export const BOT_SKILL = { easy: 0.2, medium: 0.65, hard: 0.98 } as const
export function defaultBotSettings(categories: string[]): BotSettings {
  return { difficulty: 'medium', opponents: 2, arenaSize: 19, categories: [...categories] }
}
export function parseBotSettings(raw: string | null, categories: string[]): BotSettings {
  const defaults = defaultBotSettings(categories)
  try {
    const value = JSON.parse(raw ?? 'null')
    if (!value || typeof value !== 'object') return defaults
    return {
      difficulty: ['easy', 'medium', 'hard'].includes(value.difficulty) ? value.difficulty : defaults.difficulty,
      opponents: value.opponents === 1 ? 1 : 2,
      arenaSize: [7, 19, 37].includes(value.arenaSize) ? value.arenaSize : 19,
      categories: Array.isArray(value.categories) ? [...new Set<string>(value.categories.filter((c: unknown) => typeof c === 'string' && categories.includes(c)))] : defaults.categories,
    }
  } catch { return defaults }
}
export function botPlayerIds(settings: BotSettings): PlayerId[] { return settings.opponents === 1 ? ['you', 'alex'] : ['you', 'alex', 'marina'] }
export function arenaRadius(size: BotSettings['arenaSize']): number { return size === 7 ? 1 : size === 37 ? 3 : 2 }
export function questionsForTopics(questions: QuizQuestion[], categories: string[]) { return questions.filter(q => categories.includes(q.category ?? 'Общие знания')) }
/** Numeric questions inherit the same topic selection as the multiple-choice bank. */
export function numericQuestionsForTopics(questions: QuizQuestion[]): NumericQuestion[] {
  return questions.flatMap(q => {
    const answer = q.options[q.correctIndex].trim()
    if (!/^-?\d+(?:[.,]\d+)?$/.test(answer)) return []
    return [{ id: `number-${q.id}`, prompt: q.prompt, answer: Number(answer.replace(',', '.')) }]
  })
}
