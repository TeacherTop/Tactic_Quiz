export type JeopardyQuestion = { id: string; question: string; topic: string }
export type JeopardyVerdict = {
  verdict: 'correct' | 'incorrect' | 'clarify' | 'skipped'
  explanation: string
  answer?: string
}
