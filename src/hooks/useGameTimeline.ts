import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlayerId } from '../game/types'

export const ANIMATION_TIMINGS = {
  minTransition: 300,
  minPhasePause: 500,
  roundAnnouncement: 2000,
  announcementScale: 400,
  preTimerPause: 600,
  questionEnter: 300,
  answerPress: 150,
  inputExit: 500,
  inputExitPause: 300,
  resultReveal: 600,
  resultHold: 2200,
  mapReturn: 800,
  botCaptureMin: 600,
  botCaptureMax: 800,
  territoryCapture: 800,
  spreadPulse: 200,
  betweenRounds: 1000,
} as const

export type ExpansionTimelineStep =
  | 'idle'
  | 'announcing'
  | 'pre-timer'
  | 'question-entering'
  | 'answering'
  | 'input-exiting'
  | 'results'
  | 'map-return'
  | 'capture'
  | 'post-capture'
  | 'between-rounds'

type Args = {
  phase: string
  round: number
  allAnswered: boolean
  completedRoundKey: string | null
  pendingCapture: PlayerId | null
  lastCapturedKey: string | null
  paused: boolean
  onFinishExpansion: () => void
  onFinishExpansionReview: () => void
  onFinishExpansionBetween: () => void
  onBotCapture: () => void
}

type QueuedAnswer = null | (() => void)

function randomBotCaptureDelay(): number {
  const { botCaptureMin, botCaptureMax } = ANIMATION_TIMINGS
  return botCaptureMin + Math.random() * (botCaptureMax - botCaptureMin)
}

export function useGameTimeline({
  phase,
  round,
  allAnswered,
  completedRoundKey,
  pendingCapture,
  lastCapturedKey,
  paused,
  onFinishExpansion,
  onFinishExpansionReview,
  onFinishExpansionBetween,
  onBotCapture,
}: Args) {
  const [step, setStep] = useState<ExpansionTimelineStep>('idle')
  const [progress, setProgress] = useState(0)
  const queuedAnswer = useRef<QueuedAnswer>(null)
  const lastCompletedRound = useRef<string | null>(null)
  const roundKey = `${phase}-${round}`

  const runAfter = (callback: () => void, delay: number) => {
    const id = window.setTimeout(callback, Math.max(delay, ANIMATION_TIMINGS.minPhasePause))
    return () => window.clearTimeout(id)
  }

  useEffect(() => {
    if (phase !== 'expansion') {
      if (phase !== 'expansion-review' && phase !== 'expansion-capture') setStep('idle')
      return
    }
    setStep('announcing')
    setProgress(0)
    queuedAnswer.current = null
    return runAfter(() => setStep('pre-timer'), ANIMATION_TIMINGS.roundAnnouncement)
  }, [phase, roundKey])

  useEffect(() => {
    if (paused || step !== 'pre-timer') return
    return runAfter(() => setStep('question-entering'), ANIMATION_TIMINGS.preTimerPause)
  }, [paused, step])

  useEffect(() => {
    if (paused || step !== 'question-entering') return
    return runAfter(() => {
      setStep('answering')
      queuedAnswer.current?.()
      queuedAnswer.current = null
    }, ANIMATION_TIMINGS.questionEnter)
  }, [paused, step])

  useEffect(() => {
    if (paused || phase !== 'expansion' || step !== 'answering' || !allAnswered) return
    setStep('input-exiting')
  }, [allAnswered, paused, phase, step])

  useEffect(() => {
    if (paused || step !== 'input-exiting') return
    return runAfter(onFinishExpansion, ANIMATION_TIMINGS.inputExit + ANIMATION_TIMINGS.inputExitPause)
  }, [onFinishExpansion, paused, step])

  useEffect(() => {
    if (phase !== 'expansion-review' || !completedRoundKey || lastCompletedRound.current === completedRoundKey) return
    lastCompletedRound.current = completedRoundKey
    setStep('results')
    return runAfter(() => setStep('map-return'), ANIMATION_TIMINGS.resultReveal + ANIMATION_TIMINGS.resultHold)
  }, [completedRoundKey, phase])

  useEffect(() => {
    if (paused || step !== 'map-return') return
    return runAfter(onFinishExpansionReview, ANIMATION_TIMINGS.mapReturn)
  }, [onFinishExpansionReview, paused, step])

  useEffect(() => {
    if (phase !== 'expansion-capture') return
    if (pendingCapture) setStep('capture')
  }, [phase, pendingCapture])

  useEffect(() => {
    if (paused || phase !== 'expansion-capture' || step !== 'capture' || pendingCapture === 'you') return
    return runAfter(onBotCapture, randomBotCaptureDelay())
  }, [onBotCapture, paused, pendingCapture, phase, step])

  useEffect(() => {
    if (phase !== 'expansion-capture' || pendingCapture || !lastCapturedKey) return
    setStep('post-capture')
    return runAfter(onFinishExpansionReview, ANIMATION_TIMINGS.territoryCapture)
  }, [lastCapturedKey, onFinishExpansionReview, pendingCapture, phase])

  useEffect(() => {
    if (phase !== 'expansion-between' || paused) return
    setStep('between-rounds')
    return runAfter(onFinishExpansionBetween, ANIMATION_TIMINGS.betweenRounds)
  }, [onFinishExpansionBetween, paused, phase])

  useEffect(() => {
    const pauseDurations: Partial<Record<ExpansionTimelineStep, number>> = {
      announcing: ANIMATION_TIMINGS.roundAnnouncement,
      'pre-timer': ANIMATION_TIMINGS.preTimerPause,
      'question-entering': ANIMATION_TIMINGS.questionEnter,
      'input-exiting': ANIMATION_TIMINGS.inputExit + ANIMATION_TIMINGS.inputExitPause,
      results: ANIMATION_TIMINGS.resultReveal + ANIMATION_TIMINGS.resultHold,
      'map-return': ANIMATION_TIMINGS.mapReturn,
      'post-capture': ANIMATION_TIMINGS.territoryCapture,
      'between-rounds': ANIMATION_TIMINGS.betweenRounds,
    }
    const duration = pauseDurations[step]
    if (!duration || paused) {
      setProgress(0)
      return
    }
    const startedAt = performance.now()
    let frame = 0
    const tick = () => {
      setProgress(Math.min(1, (performance.now() - startedAt) / duration))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [paused, step])

  return useMemo(() => ({
    step,
    progress,
    questionVisible: phase === 'expansion' && (step === 'question-entering' || step === 'answering' || step === 'input-exiting'),
    questionAcceptsAnswers: phase === 'expansion' && step === 'answering',
    inputExiting: step === 'input-exiting',
    resultVisible: phase === 'expansion-review' && (step === 'results' || step === 'map-return'),
    mapVisible: phase === 'expansion-review' || phase === 'expansion-capture' || phase === 'expansion-between',
    mapReturning: step === 'map-return',
    phaseLocked: step !== 'answering' && step !== 'capture',
    finishInput: () => {
      if (phase === 'expansion' && step === 'answering') setStep('input-exiting')
    },
    queueAnswer: (answer: () => void) => {
      if (step === 'answering') answer()
      else queuedAnswer.current = answer
    },
  }), [phase, progress, step])
}
