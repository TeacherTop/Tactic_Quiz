import type { QuizQuestion } from '../game/types'

type LocalizedQuestion = {
  category?: string
  type: 'multiple' | 'boolean'
  question: string
  correct_answer: string
  incorrect_answers: string[]
  answers: string[]
}

const questionBankFiles = import.meta.glob('../../question_bank/my_game_question*.json', {
  eager: true,
  import: 'default',
}) as Record<string, LocalizedQuestion[]>

const source = Object.entries(questionBankFiles)
  .sort(([left], [right]) => questionBankFileNumber(left) - questionBankFileNumber(right))
  .flatMap(([, questions]) => questions)

function questionBankFileNumber(path: string): number {
  return Number(path.match(/my_game_question(\d+)\.json$/)?.[1] ?? Number.MAX_SAFE_INTEGER)
}

function toQuizQuestion(question: LocalizedQuestion, index: number): QuizQuestion {
  if (question.type === 'boolean') {
    const correctIndex = question.correct_answer === 'Правда' ? 0 : 1
    const options: [string, string, string, string] = [
      'Правда',
      'Ложь',
      'Нельзя определить',
      'Нет верного варианта',
    ]
    return { id: `opentdb-${index}`, category: question.category, prompt: question.question, options, correctIndex }
  }

  const options = question.answers as [string, string, string, string]
  const correctIndex = options.indexOf(question.correct_answer)
  if (correctIndex < 0) {
    throw new Error(`Localized question has no correct answer: ${question.question}`)
  }
  return {
    id: `opentdb-${index}`,
    category: question.category,
    prompt: question.question,
    options,
    correctIndex: correctIndex as 0 | 1 | 2 | 3,
  }
}

export const LOCALIZED_QUIZ_QUESTIONS: QuizQuestion[] = source.map(toQuizQuestion)
