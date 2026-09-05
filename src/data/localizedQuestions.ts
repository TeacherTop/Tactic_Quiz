import localizedQuestions from '../../opentdb_questions_ru.json'
import type { QuizQuestion } from '../game/types'

type LocalizedQuestion = {
  type: 'multiple' | 'boolean'
  question: string
  correct_answer: string
  incorrect_answers: string[]
  answers: string[]
}

const source = localizedQuestions as LocalizedQuestion[]

function toQuizQuestion(question: LocalizedQuestion, index: number): QuizQuestion {
  if (question.type === 'boolean') {
    const correctIndex = question.correct_answer === 'Правда' ? 0 : 1
    const options: [string, string, string, string] = [
      'Правда',
      'Ложь',
      'Нельзя определить',
      'Нет верного варианта',
    ]
    return { id: `opentdb-${index}`, prompt: question.question, options, correctIndex }
  }

  const options = question.answers as [string, string, string, string]
  const correctIndex = options.indexOf(question.correct_answer)
  if (correctIndex < 0) {
    throw new Error(`Localized question has no correct answer: ${question.question}`)
  }
  return {
    id: `opentdb-${index}`,
    prompt: question.question,
    options,
    correctIndex: correctIndex as 0 | 1 | 2 | 3,
  }
}

export const LOCALIZED_QUIZ_QUESTIONS: QuizQuestion[] = source.map(toQuizQuestion)
