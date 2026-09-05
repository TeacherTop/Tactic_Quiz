function gaussian(): number {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function botNumericGuess(answer: number, skill: number): number {
  const mag = Math.max(Math.abs(answer), 1)
  const relative = 0.045 + (1 - skill) * 0.16
  let guess = answer + gaussian() * mag * relative

  if (Number.isInteger(answer)) {
    guess = Math.round(guess)
    if (guess === answer && Math.random() > skill * 0.35) {
      const nudge = Math.max(1, Math.round(mag * 0.01))
      guess += Math.random() < 0.5 ? -nudge : nudge
    }
  } else {
    guess = Math.round(guess * 10) / 10
  }

  return guess
}

export function botQuizChoice(correctIndex: number, skill: number): number {
  const hit = 0.38 + skill * 0.48
  if (Math.random() < hit) return correctIndex
  const wrong = [0, 1, 2, 3].filter((i) => i !== correctIndex)
  return wrong[Math.floor(Math.random() * wrong.length)]
}

export function botAnswerDelayMs(skill: number, maxMs: number): number {
  const min = 900
  const window = Math.max(1200, maxMs * (0.72 - skill * 0.25))
  return Math.min(maxMs - 200, min + Math.random() * window)
}
