import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArenaGrid } from './components/ArenaGrid'
import { OnlineArenaGrid } from './components/OnlineArenaGrid'
import { PlayerDock } from './components/PlayerDock'
import { TimerRing } from './components/TimerRing'
import { NUMERIC_QUESTIONS } from './data/questions'
import { LOCALIZED_QUIZ_QUESTIONS } from './data/localizedQuestions'
import {
  captureCell,
  captureOpponentCell,
  cellKey,
  createArena,
  getAttackTargets,
  getAvailableCells,
  isExpansionBreakthrough,
} from './game/arena'
import { botAnswerDelayMs, botNumericGuess, botQuizChoice } from './game/bots'
import { emptyScores, pickRandom, QUIZ_TIME_MS, SCORE_VALUES } from './game/engine'
import { PLAYER_BY_ID, PLAYERS } from './game/players'
import type { ArenaCell, NumericQuestion, PlayerId, QuizQuestion } from './game/types'
import { useCountdown } from './hooks/useCountdown'
import { useTelegramControls } from './hooks/useTelegramControls'
import { ANIMATION_TIMINGS, useGameTimeline } from './hooks/useGameTimeline'
import { connectMultiplayerSocket, createMultiplayerRoom, joinMultiplayerRoom, type MultiplayerSocket } from './multiplayer/client'
import { getInviteRoomCode, getTelegramInviteUrl, shareTelegramInvite } from './telegram'
import type { MultiplayerGameState } from '../shared/multiplayer'
import './styles.css'

type Phase = 'home' | 'expansion' | 'expansion-review' | 'expansion-capture' | 'expansion-between' | 'expansion-final' | 'battle-select' | 'battle-warmup' | 'battle-number' | 'results'
const MAX_BATTLE_ROUNDS = 9
const ANNOUNCEMENT_MS = 4500
const ROUND_RESULT_MS = 6000
const BOT_FALLBACK_BUFFER_MS = 500
const PLAYER_IDS: PlayerId[] = ['you', 'alex', 'marina']
const SOLO_STORAGE_KEY = 'solo_quiz_progress'
const QUESTION_BANK_SELECTION_KEY = 'question_bank_selection'
const QUESTION_BANK_CHUNK_SIZE = 100
const QUESTION_BANK_FILE_COUNT = Math.ceil(LOCALIZED_QUIZ_QUESTIONS.length / QUESTION_BANK_CHUNK_SIZE)
const API_URL = import.meta.env.VITE_MULTIPLAYER_API_URL ?? 'http://127.0.0.1:4000'
type Answers = Record<PlayerId, number | null>
type RoundResult =
  | { kind: 'quiz'; question: QuizQuestion; answers: Answers }
  | { kind: 'numeric'; question: NumericQuestion; answers: Record<PlayerId, number | null>; participants?: PlayerId[] }

type PveStats = {
  games: number
  wins: number
  mcCorrect: number
  mcAnswered: number
  numericDeviationTotal: number
  numericAnswered: number
}

type SoloProgress = {
  seenQuestionIds: string[]
  questionOrder: string[]
  currentStreak: number
  bestStreak: number
  totalAnswered: number
  correctAnswers: number
  lastMilestone: number
}

type SoloFlaggedQuestion = {
  id: string
  category?: string
  type: 'multiple'
  question: string
  correct_answer: string
  incorrect_answers: string[]
  answers: string[]
}

const STATS_STORAGE_KEY = 'strategi-quiz-pve-stats'
let activeQuizQuestionBank = LOCALIZED_QUIZ_QUESTIONS

type Match = {
  scores: Record<PlayerId, number>
  mcStats: Record<PlayerId, { correct: number; total: number }>
  arena: ArenaCell[]
  lastCapturedKey: string | null
  usedQuizQuestionIds: string[]
  usedNumericQuestionIds: string[]
  expansionQuestion: QuizQuestion
  expansionAnswers: Answers
  expansionAnsweredAt: Record<PlayerId, number | null>
  expansionQueue: PlayerId[]
  expansionRound: number
  pendingCapture: PlayerId | null
  captureIndex: number
  battleRound: number
  attacker: PlayerId
  defender: PlayerId | null
  target: ArenaCell | null
  warmupQuestion: QuizQuestion
  warmupAnswers: Answers
  numericQuestion: NumericQuestion
  numericAnswers: Record<PlayerId, number | null>
  finalQuestion: NumericQuestion
  finalAnswers: Record<PlayerId, number | null>
  finalAnsweredAt: Record<PlayerId, number | null>
  pveStats: Omit<PveStats, 'games' | 'wins'>
}

type State = { phase: Phase; match: Match | null; completedRoundResult: RoundResult | null }

type Action =
  | { type: 'start' }
  | { type: 'exit' }
  | { type: 'answer-expansion'; id: PlayerId; pick: number | null; answeredAt: number }
  | { type: 'finish-expansion' }
  | { type: 'finish-expansion-review' }
  | { type: 'finish-expansion-between' }
  | { type: 'capture-expansion'; row: number; col: number }
  | { type: 'answer-final'; id: PlayerId; value: number | null; answeredAt: number }
  | { type: 'finish-final' }
  | { type: 'select-attack'; row: number; col: number }
  | { type: 'answer-warmup'; id: PlayerId; pick: number | null }
  | { type: 'finish-warmup' }
  | { type: 'answer-number'; id: PlayerId; value: number | null }
  | { type: 'finish-number' }

function blankAnswers(): Answers {
  return { you: null, alex: null, marina: null }
}

function blankMcStats(): Record<PlayerId, { correct: number; total: number }> {
  return {
    you: { correct: 0, total: 0 },
    alex: { correct: 0, total: 0 },
    marina: { correct: 0, total: 0 },
  }
}

function blankAnswerTimes(): Record<PlayerId, number | null> {
  return { you: null, alex: null, marina: null }
}

function emptyPveStats(): PveStats {
  return { games: 0, wins: 0, mcCorrect: 0, mcAnswered: 0, numericDeviationTotal: 0, numericAnswered: 0 }
}

function readPveStats(): PveStats {
  try {
    const raw = localStorage.getItem(STATS_STORAGE_KEY)
    if (!raw) return emptyPveStats()
    return { ...emptyPveStats(), ...JSON.parse(raw) }
  } catch {
    return emptyPveStats()
  }
}

function savePveStats(stats: PveStats): void {
  try {
    localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats))
  } catch {
    // Local storage can be unavailable in private browsing; gameplay should continue.
  }
}

function allQuestionBankFiles(): number[] {
  return Array.from({ length: QUESTION_BANK_FILE_COUNT }, (_, index) => index + 1)
}

function normalizeQuestionBankSelection(files: number[]): number[] {
  const unique = new Set<number>()
  files.forEach((file) => {
    if (Number.isInteger(file) && file >= 1 && file <= QUESTION_BANK_FILE_COUNT) unique.add(file)
  })
  return [...unique].sort((a, b) => a - b)
}

function parseQuestionBankSelection(value: string): number[] {
  return normalizeQuestionBankSelection((value.match(/\d+/g) ?? []).map(Number))
}

function readQuestionBankSelection(): number[] {
  try {
    const raw = localStorage.getItem(QUESTION_BANK_SELECTION_KEY)
    if (!raw) return allQuestionBankFiles()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return allQuestionBankFiles()
    const selection = normalizeQuestionBankSelection(parsed.map(Number))
    return selection.length > 0 ? selection : allQuestionBankFiles()
  } catch {
    return allQuestionBankFiles()
  }
}

function saveQuestionBankSelection(files: number[]): void {
  try {
    localStorage.setItem(QUESTION_BANK_SELECTION_KEY, JSON.stringify(normalizeQuestionBankSelection(files)))
  } catch {
    // The selected bank files are allowed to fall back to the in-memory state.
  }
}

function questionsForBankFiles(files: number[]): QuizQuestion[] {
  const normalized = normalizeQuestionBankSelection(files)
  const selectedFiles = normalized.length > 0 ? normalized : allQuestionBankFiles()
  return selectedFiles.flatMap((file) => {
    const start = (file - 1) * QUESTION_BANK_CHUNK_SIZE
    return LOCALIZED_QUIZ_QUESTIONS.slice(start, start + QUESTION_BANK_CHUNK_SIZE)
  })
}

function emptySoloProgress(): SoloProgress {
  return {
    seenQuestionIds: [],
    questionOrder: [],
    currentStreak: 0,
    bestStreak: 0,
    totalAnswered: 0,
    correctAnswers: 0,
    lastMilestone: 0,
  }
}

function readSoloProgress(): SoloProgress {
  try {
    const raw = localStorage.getItem(SOLO_STORAGE_KEY)
    if (!raw) return emptySoloProgress()
    const parsed = JSON.parse(raw) as Partial<SoloProgress>
    return {
      ...emptySoloProgress(),
      ...parsed,
      seenQuestionIds: Array.isArray(parsed.seenQuestionIds) ? parsed.seenQuestionIds : [],
      questionOrder: Array.isArray(parsed.questionOrder) ? parsed.questionOrder : [],
    }
  } catch {
    return emptySoloProgress()
  }
}

function saveSoloProgress(progress: SoloProgress): void {
  try {
    localStorage.setItem(SOLO_STORAGE_KEY, JSON.stringify(progress))
  } catch {
    // Progress persistence is best-effort when browser storage is blocked.
  }
}

function randomIndex(length: number): number {
  if (length <= 0) return 0
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.getRandomValues) {
    const max = Math.floor(0x100000000 / length) * length
    const value = new Uint32Array(1)
    do {
      cryptoApi.getRandomValues(value)
    } while (value[0] >= max)
    return value[0] % length
  }
  return Math.floor(Math.random() * length)
}

function cryptoShuffle<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1)
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function nextSoloQuestion(progress: SoloProgress, questions = activeQuizQuestionBank): QuizQuestion | null {
  const seen = new Set(progress.seenQuestionIds)
  const orderedIds = progress.questionOrder.length > 0
    ? progress.questionOrder
    : questions.map((question) => question.id)
  const pool = orderedIds
    .filter((id) => !seen.has(id))
    .map((id) => questions.find((question) => question.id === id))
    .filter((question): question is QuizQuestion => Boolean(question))
  if (pool.length === 0) return null
  return shuffleQuizOptions(pool[randomIndex(pool.length)])
}

function toSoloFlaggedQuestion(question: QuizQuestion): SoloFlaggedQuestion {
  const correctAnswer = question.options[question.correctIndex]
  return {
    id: question.id,
    category: question.category,
    type: 'multiple',
    question: question.prompt,
    correct_answer: correctAnswer,
    incorrect_answers: question.options.filter((_, index) => index !== question.correctIndex),
    answers: [...question.options],
  }
}

function freeCellCount(arena: ArenaCell[]): number {
  return arena.filter((cell) => !cell.owner).length
}

function allAnswered(answers: Answers): boolean {
  return PLAYER_IDS.every((id) => answers[id] !== null)
}

function addScore(scores: Record<PlayerId, number>, playerId: PlayerId, value: number): Record<PlayerId, number> {
  return { ...scores, [playerId]: scores[playerId] + value }
}

function addScores(scores: Record<PlayerId, number>, awards: Partial<Record<PlayerId, number>>): Record<PlayerId, number> {
  return PLAYER_IDS.reduce((next, id) => (
    awards[id] ? addScore(next, id, awards[id]) : next
  ), scores)
}

function recordMcAnswer(
  stats: Match['mcStats'],
  playerId: PlayerId,
  correct: boolean,
): Match['mcStats'] {
  return {
    ...stats,
    [playerId]: {
      correct: stats[playerId].correct + (correct ? 1 : 0),
      total: stats[playerId].total + 1,
    },
  }
}

function isExactNumericHit(value: number, answer: number): boolean {
  return Math.abs(value - answer) === 0
}

function nextAttacker(arena: ArenaCell[], startIndex = 0): PlayerId | null {
  for (let offset = 0; offset < PLAYER_IDS.length; offset += 1) {
    const id = PLAYER_IDS[(startIndex + offset) % PLAYER_IDS.length]
    if (getAttackTargets(arena, id).length > 0) return id
  }
  return null
}

function shuffleQuizOptions(question: QuizQuestion): QuizQuestion {
  const options = question.options.map((option, index) => ({ option, isCorrect: index === question.correctIndex }))
  for (let i = options.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1)
    ;[options[i], options[j]] = [options[j], options[i]]
  }
  return {
    ...question,
    options: options.map(({ option }) => option) as [string, string, string, string],
    correctIndex: options.findIndex(({ isCorrect }) => isCorrect) as 0 | 1 | 2 | 3,
  }
}

function pickUnusedQuizQuestion(usedIds: string[]): QuizQuestion {
  const available = activeQuizQuestionBank.filter((question) => !usedIds.includes(question.id))
  return shuffleQuizOptions(available[randomIndex(available.length)])
}

function pickUnusedNumericQuestion(usedIds: string[]): NumericQuestion {
  const available = NUMERIC_QUESTIONS.filter((question) => !usedIds.includes(question.id))
  return available[randomIndex(available.length)]
}

function makeMatch(): Match {
  const expansionQuestion = pickUnusedQuizQuestion([])
  const warmupQuestion = pickUnusedQuizQuestion([expansionQuestion.id])
  const numericQuestion = pickUnusedNumericQuestion([])

  return {
    scores: emptyScores(),
    mcStats: blankMcStats(),
    arena: createArena(),
    lastCapturedKey: null,
    usedQuizQuestionIds: [expansionQuestion.id, warmupQuestion.id],
    usedNumericQuestionIds: [numericQuestion.id],
    expansionQuestion,
    expansionAnswers: blankAnswers(),
    expansionAnsweredAt: blankAnswerTimes(),
    expansionQueue: [],
    expansionRound: 1,
    pendingCapture: null,
    captureIndex: 0,
    battleRound: 0,
    attacker: 'you',
    defender: null,
    target: null,
    warmupQuestion,
    warmupAnswers: blankAnswers(),
    numericQuestion,
    numericAnswers: blankAnswers(),
    finalQuestion: numericQuestion,
    finalAnswers: blankAnswers(),
    finalAnsweredAt: blankAnswerTimes(),
    pveStats: { mcCorrect: 0, mcAnswered: 0, numericDeviationTotal: 0, numericAnswered: 0 },
  }
}

function beginBattle(match: Match): State {
  const attacker = nextAttacker(match.arena)
  if (!attacker) return { phase: 'results', match, completedRoundResult: null }
  return { phase: 'battle-select', match: { ...match, attacker, battleRound: 0 }, completedRoundResult: null }
}

function beginFinalExpansion(match: Match): State {
  const finalQuestion = pickUnusedNumericQuestion(match.usedNumericQuestionIds)
  return {
    phase: 'expansion-final',
    match: {
      ...match,
      finalQuestion,
      usedNumericQuestionIds: [...match.usedNumericQuestionIds, finalQuestion.id],
      finalAnswers: blankAnswers(),
      finalAnsweredAt: blankAnswerTimes(),
    },
    completedRoundResult: null,
  }
}

function beginNextExpansion(match: Match): State {
  const expansionQuestion = pickUnusedQuizQuestion(match.usedQuizQuestionIds)
  return {
    phase: 'expansion',
    match: {
      ...match,
      expansionQuestion,
      usedQuizQuestionIds: [...match.usedQuizQuestionIds, expansionQuestion.id],
      expansionAnswers: blankAnswers(),
      expansionAnsweredAt: blankAnswerTimes(),
      expansionQueue: [],
      expansionRound: match.expansionRound + 1,
      captureIndex: 0,
      pendingCapture: null,
    },
    completedRoundResult: null,
  }
}

function advanceCaptureQueue(match: Match): State {
  let arena = match.arena
  let captureIndex = match.captureIndex
  let lastCapturedKey = match.lastCapturedKey
  while (captureIndex < match.expansionQueue.length) {
    const id = match.expansionQueue[captureIndex]
    const available = getAvailableCells(arena, id)
    if (available.size > 0) {
      return {
        phase: 'expansion-capture',
        match: { ...match, arena, captureIndex, pendingCapture: id, lastCapturedKey },
        completedRoundResult: null,
      }
    }
    captureIndex += 1
    if (freeCellCount(arena) === 1) {
      return beginFinalExpansion({ ...match, arena, captureIndex, pendingCapture: null, lastCapturedKey })
    }
  }
  const progressed = { ...match, arena, captureIndex, pendingCapture: null, lastCapturedKey }
  if (freeCellCount(arena) === 1) {
    return beginFinalExpansion(progressed)
  }
  if (arena.every((cell) => cell.owner)) return beginBattle(progressed)
  return {
    phase: 'expansion-between',
    match: progressed,
    completedRoundResult: null,
  }
}

function resolveFinalExpansion(match: Match): State {
  const completedRoundResult: RoundResult = { kind: 'numeric', question: match.finalQuestion, answers: match.finalAnswers }
  const winner = PLAYER_IDS
    .filter((id) => match.finalAnswers[id] !== null)
    .sort((left, right) => {
      const leftDistance = Math.abs((match.finalAnswers[left] ?? 0) - match.finalQuestion.answer)
      const rightDistance = Math.abs((match.finalAnswers[right] ?? 0) - match.finalQuestion.answer)
      if (leftDistance !== rightDistance) return leftDistance - rightDistance
      return (match.finalAnsweredAt[left] ?? Number.POSITIVE_INFINITY)
        - (match.finalAnsweredAt[right] ?? Number.POSITIVE_INFINITY)
    })[0]
  const lastCell = match.arena.find((cell) => !cell.owner)
  let scores = { ...match.scores }
  for (const id of PLAYER_IDS) {
    const answer = match.finalAnswers[id]
    if (answer !== null && isExactNumericHit(answer, match.finalQuestion.answer)) {
      scores = addScore(scores, id, SCORE_VALUES.numericExactBonus)
    }
  }
  if (winner) scores = addScore(scores, winner, SCORE_VALUES.numericWin)
  if (!winner || !lastCell) return { ...beginBattle({ ...match, scores }), completedRoundResult }
  const arena = match.arena.map((cell) => (
    cell.row === lastCell.row && cell.col === lastCell.col ? { ...cell, owner: winner } : cell
  ))
  scores = addScore(scores, winner, SCORE_VALUES.capture)
  return { ...beginBattle({ ...match, scores, arena, lastCapturedKey: cellKey(lastCell.row, lastCell.col) }), completedRoundResult }
}

function resolveExpansion(match: Match): State {
  const completedRoundResult: RoundResult = { kind: 'quiz', question: match.expansionQuestion, answers: match.expansionAnswers }
  const scores = { ...match.scores }
  for (const id of match.expansionQueue) {
    if (match.expansionAnswers[id] !== match.expansionQuestion.correctIndex) continue
    scores[id] += SCORE_VALUES.mcCorrect
  }
  return {
    phase: 'expansion-review',
    match: { ...match, scores, captureIndex: 0, pendingCapture: null, lastCapturedKey: null },
    completedRoundResult,
  }
}

function startNextBattle(match: Match): State {
  const nextRound = match.battleRound + 1
  if (nextRound >= MAX_BATTLE_ROUNDS) return { phase: 'results', match: { ...match, battleRound: nextRound }, completedRoundResult: null }
  const attacker = nextAttacker(match.arena, (PLAYER_IDS.indexOf(match.attacker) + 1) % PLAYER_IDS.length)
  if (!attacker) return { phase: 'results', match: { ...match, battleRound: nextRound }, completedRoundResult: null }
  return {
    phase: 'battle-select',
    match: { ...match, battleRound: nextRound, attacker, defender: null, target: null },
    completedRoundResult: null,
  }
}

function resolveWarmup(match: Match): State {
  const completedRoundResult: RoundResult = { kind: 'quiz', question: match.warmupQuestion, answers: match.warmupAnswers }
  const attackerCorrect = match.warmupAnswers[match.attacker] === match.warmupQuestion.correctIndex
  const defenderCorrect = match.defender !== null
    && match.warmupAnswers[match.defender] === match.warmupQuestion.correctIndex
  let scores = { ...match.scores }
  if (attackerCorrect) scores = addScore(scores, match.attacker, SCORE_VALUES.mcCorrect)
  if (match.defender && defenderCorrect) scores = addScore(scores, match.defender, SCORE_VALUES.mcCorrect)
  if (!match.defender || !match.target) return { ...startNextBattle({ ...match, scores }), completedRoundResult }
  if (!attackerCorrect) {
    scores = addScore(scores, match.defender, SCORE_VALUES.hold)
    return { ...startNextBattle({ ...match, scores }), completedRoundResult }
  }
  if (!defenderCorrect) {
    const arena = captureOpponentCell(match.arena, match.attacker, match.target.row, match.target.col)
    scores = addScores(scores, {
      [match.attacker]: SCORE_VALUES.capture,
      [match.defender]: SCORE_VALUES.lostTerritory,
    })
    return { ...startNextBattle({ ...match, scores, arena, lastCapturedKey: cellKey(match.target.row, match.target.col) }), completedRoundResult }
  }
  const numericQuestion = pickUnusedNumericQuestion(match.usedNumericQuestionIds)
  return {
    phase: 'battle-number',
    match: {
      ...match,
      scores,
      numericQuestion,
      usedNumericQuestionIds: [...match.usedNumericQuestionIds, numericQuestion.id],
      numericAnswers: blankAnswers(),
    },
    completedRoundResult,
  }
}

function resolveNumber(match: Match): State {
  const completedRoundResult: RoundResult = {
    kind: 'numeric',
    question: match.numericQuestion,
    answers: match.numericAnswers,
    participants: match.defender ? [match.attacker, match.defender] : [match.attacker],
  }
  if (!match.defender || !match.target) return { ...startNextBattle(match), completedRoundResult }
  const attackerAnswer = match.numericAnswers[match.attacker]
  const defenderAnswer = match.numericAnswers[match.defender]
  const attackerDistance = attackerAnswer === null ? null : Math.abs(attackerAnswer - match.numericQuestion.answer)
  const defenderDistance = defenderAnswer === null ? null : Math.abs(defenderAnswer - match.numericQuestion.answer)
  let arena = match.arena
  let scores = { ...match.scores }
  if (attackerAnswer !== null && isExactNumericHit(attackerAnswer, match.numericQuestion.answer)) {
    scores = addScore(scores, match.attacker, SCORE_VALUES.numericExactBonus)
  }
  if (defenderAnswer !== null && isExactNumericHit(defenderAnswer, match.numericQuestion.answer)) {
    scores = addScore(scores, match.defender, SCORE_VALUES.numericExactBonus)
  }
  if (attackerDistance !== null && (defenderDistance === null || attackerDistance < defenderDistance)) {
    arena = captureOpponentCell(arena, match.attacker, match.target.row, match.target.col)
    scores = addScores(scores, {
      [match.attacker]: SCORE_VALUES.numericWin + SCORE_VALUES.capture,
      [match.defender]: SCORE_VALUES.lostTerritory,
    })
  } else if (defenderDistance !== null && (attackerDistance === null || defenderDistance < attackerDistance)) {
    arena = captureOpponentCell(arena, match.defender, match.target.row, match.target.col)
    scores = addScores(scores, {
      [match.defender]: SCORE_VALUES.numericWin + SCORE_VALUES.hold,
    })
  } else {
    scores = addScore(scores, match.defender, SCORE_VALUES.hold)
  }
  return { ...startNextBattle({ ...match, scores, arena, lastCapturedKey: arena === match.arena ? null : cellKey(match.target.row, match.target.col) }), completedRoundResult }
}

function reducer(state: State, action: Action): State {
  const match = state.match
  switch (action.type) {
    case 'start': return { phase: 'expansion', match: makeMatch(), completedRoundResult: null }
    case 'exit': return { phase: 'home', match: null, completedRoundResult: null }
    case 'answer-expansion': {
      if (!match || state.phase !== 'expansion' || match.expansionAnswers[action.id] !== null) return state
      const isCorrect = action.pick === match.expansionQuestion.correctIndex
      const next = {
        ...match,
        expansionAnswers: { ...match.expansionAnswers, [action.id]: action.pick },
        expansionAnsweredAt: { ...match.expansionAnsweredAt, [action.id]: action.answeredAt },
        expansionQueue: isCorrect ? [...match.expansionQueue, action.id] : match.expansionQueue,
        mcStats: recordMcAnswer(match.mcStats, action.id, isCorrect),
        pveStats: action.id === 'you'
          ? { ...match.pveStats, mcCorrect: match.pveStats.mcCorrect + (isCorrect ? 1 : 0), mcAnswered: match.pveStats.mcAnswered + 1 }
          : match.pveStats,
      }
      return { ...state, match: next }
    }
    case 'finish-expansion':
      return match && state.phase === 'expansion' ? resolveExpansion(match) : state
    case 'finish-expansion-review':
      return match && (state.phase === 'expansion-review' || state.phase === 'expansion-capture') ? advanceCaptureQueue(match) : state
    case 'finish-expansion-between':
      return match && state.phase === 'expansion-between' ? beginNextExpansion(match) : state
    case 'capture-expansion': {
      if (!match || state.phase !== 'expansion-capture' || !match.pendingCapture) return state
      const arena = captureCell(match.arena, match.pendingCapture, action.row, action.col)
      if (arena === match.arena) return state
      return {
        phase: 'expansion-capture',
        match: {
          ...match,
          scores: addScore(match.scores, match.pendingCapture, SCORE_VALUES.capture),
          arena,
          captureIndex: match.captureIndex + 1,
          pendingCapture: null,
          lastCapturedKey: cellKey(action.row, action.col),
        },
        completedRoundResult: null,
      }
    }
    case 'answer-final': {
      if (!match || state.phase !== 'expansion-final' || match.finalAnswers[action.id] !== null) return state
      const next = {
        ...match,
        finalAnswers: { ...match.finalAnswers, [action.id]: action.value },
        finalAnsweredAt: { ...match.finalAnsweredAt, [action.id]: action.answeredAt },
        pveStats: action.id === 'you' && action.value !== null
          ? { ...match.pveStats, numericDeviationTotal: match.pveStats.numericDeviationTotal + Math.abs(action.value - match.finalQuestion.answer), numericAnswered: match.pveStats.numericAnswered + 1 }
          : match.pveStats,
      }
      return allAnswered(next.finalAnswers) ? resolveFinalExpansion(next) : { ...state, match: next }
    }
    case 'finish-final':
      return match && state.phase === 'expansion-final' ? resolveFinalExpansion(match) : state
    case 'select-attack': {
      if (!match || state.phase !== 'battle-select') return state
      const target = getAttackTargets(match.arena, match.attacker).find((cell) => cell.row === action.row && cell.col === action.col)
      if (!target || !target.owner) return state
      const warmupQuestion = pickUnusedQuizQuestion(match.usedQuizQuestionIds)
      return {
        phase: 'battle-warmup',
        match: {
          ...match,
          target,
          defender: target.owner,
          warmupQuestion,
          usedQuizQuestionIds: [...match.usedQuizQuestionIds, warmupQuestion.id],
          warmupAnswers: blankAnswers(),
        },
        completedRoundResult: null,
      }
    }
    case 'answer-warmup': {
      if (!match || state.phase !== 'battle-warmup' || match.warmupAnswers[action.id] !== null) return state
      const isCorrect = action.pick === match.warmupQuestion.correctIndex
      const next = {
        ...match,
        warmupAnswers: { ...match.warmupAnswers, [action.id]: action.pick },
        mcStats: recordMcAnswer(match.mcStats, action.id, isCorrect),
        pveStats: action.id === 'you'
          ? { ...match.pveStats, mcCorrect: match.pveStats.mcCorrect + (isCorrect ? 1 : 0), mcAnswered: match.pveStats.mcAnswered + 1 }
          : match.pveStats,
      }
      return match.defender && next.warmupAnswers[match.attacker] !== null && next.warmupAnswers[match.defender] !== null
        ? resolveWarmup(next)
        : { ...state, match: next }
    }
    case 'finish-warmup': return match && state.phase === 'battle-warmup' ? resolveWarmup(match) : state
    case 'answer-number': {
      if (!match || state.phase !== 'battle-number' || match.numericAnswers[action.id] !== null) return state
      const next = {
        ...match,
        numericAnswers: { ...match.numericAnswers, [action.id]: action.value },
        pveStats: action.id === 'you' && action.value !== null
          ? { ...match.pveStats, numericDeviationTotal: match.pveStats.numericDeviationTotal + Math.abs(action.value - match.numericQuestion.answer), numericAnswered: match.pveStats.numericAnswered + 1 }
          : match.pveStats,
      }
      return match.defender && next.numericAnswers[match.attacker] !== null && next.numericAnswers[match.defender] !== null
        ? resolveNumber(next)
        : { ...state, match: next }
    }
    case 'finish-number': return match && state.phase === 'battle-number' ? resolveNumber(match) : state
    default: return state
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, { phase: 'home', match: null, completedRoundResult: null })
  const [menuNotice] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paused, setPaused] = useState(false)
  const [announcement, setAnnouncement] = useState(true)
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null)
  const [homeScreen, setHomeScreen] = useState<'menu' | 'stats' | 'ranked' | 'friends' | 'history' | 'solo'>('menu')
  const [selectedQuestionBankFiles, setSelectedQuestionBankFiles] = useState(() => readQuestionBankSelection())
  const recordedMatch = useRef(false)
  const { phase, match, completedRoundResult } = state
  const quizQuestions = questionsForBankFiles(selectedQuestionBankFiles)
  activeQuizQuestionBank = quizQuestions
  const startMatch = () => { setSettingsOpen(false); setHomeScreen('menu'); setPaused(false); setAnnouncement(false); recordedMatch.current = false; dispatch({ type: 'start' }) }
  const startSolo = () => { setSettingsOpen(false); setPaused(false); setAnnouncement(false); setHomeScreen('solo') }
  const updateQuestionBankFiles = (files: number[]) => {
    const next = normalizeQuestionBankSelection(files)
    if (next.length === 0) return
    saveQuestionBankSelection(next)
    setSelectedQuestionBankFiles(next)
  }
  const exitGame = () => { setSettingsOpen(false); setPaused(false); dispatch({ type: 'exit' }) }
  useTelegramControls(() => { setHomeScreen('menu'); exitGame() }, null)
  const questionPhase = phase === 'expansion' || phase === 'expansion-final' || phase === 'battle-warmup' || phase === 'battle-number'
  const expansionAllAnswered = match ? allAnswered(match.expansionAnswers) : false
  const completedRoundKey = completedRoundResult && phase === 'expansion-review' && match
    ? `${match.expansionRound}-${completedRoundResult.kind}`
    : null
  const timeline = useGameTimeline({
    phase,
    round: match?.expansionRound ?? 0,
    allAnswered: expansionAllAnswered,
    completedRoundKey,
    pendingCapture: match?.pendingCapture ?? null,
    lastCapturedKey: match?.lastCapturedKey ?? null,
    paused,
    onFinishExpansion: () => dispatch({ type: 'finish-expansion' }),
    onFinishExpansionReview: () => dispatch({ type: 'finish-expansion-review' }),
    onFinishExpansionBetween: () => dispatch({ type: 'finish-expansion-between' }),
    onBotCapture: () => {
      if (!match?.pendingCapture) return
      const key = [...getAvailableCells(match.arena, match.pendingCapture)][0]
      if (!key) return
      const [row, col] = key.split(':').map(Number)
      dispatch({ type: 'capture-expansion', row, col })
    },
  })
  const shouldAnnounce = questionPhase && phase !== 'expansion' && Boolean(match)
  const timedPhase = (phase === 'expansion' ? timeline.questionAcceptsAnswers : questionPhase) && !roundResult
  const announcementKey = match ? `${phase}-${match.expansionRound}-${match.battleRound}-${match.target?.row ?? ''}-${match.target?.col ?? ''}` : 'home'
  useEffect(() => {
    if (!shouldAnnounce) return
    setAnnouncement(true)
    const id = window.setTimeout(() => setAnnouncement(false), ANNOUNCEMENT_MS)
    return () => window.clearTimeout(id)
  }, [announcementKey, shouldAnnounce])
  useEffect(() => {
    if (phase === 'expansion-review') return
    if (!completedRoundResult) return
    setRoundResult(completedRoundResult)
    const id = window.setTimeout(() => setRoundResult(null), ROUND_RESULT_MS)
    return () => window.clearTimeout(id)
  }, [completedRoundResult, phase])
  const timerKey = match ? `${phase}-${match.expansionRound}-${match.battleRound}-${match.target?.row ?? ''}-${match.target?.col ?? ''}` : 'none'
  const remainingMs = useCountdown(timedPhase, QUIZ_TIME_MS, () => {
    if (phase === 'expansion') {
      timeline.finishInput()
      return
    }
    dispatch({
      type: phase === 'expansion-final'
        ? 'finish-final'
        : phase === 'battle-warmup'
          ? 'finish-warmup'
          : 'finish-number',
    })
  }, timerKey, paused || announcement || Boolean(roundResult))

  useEffect(() => {
    if (!match || paused || announcement || roundResult || (phase === 'expansion' && !timeline.questionAcceptsAnswers)) return
    const timers: number[] = []
    const schedule = (callback: () => void, delay: number) => {
      timers.push(window.setTimeout(callback, delay))
    }
    const scheduleBotAnswer = (
      playerId: PlayerId,
      delay: number,
      value: number,
      send: () => void,
    ) => {
      const player = PLAYER_BY_ID[playerId]
      const fallbackDelay = QUIZ_TIME_MS - BOT_FALLBACK_BUFFER_MS
      const safeDelay = Math.min(delay, fallbackDelay - 100)
      console.info(`[bot] ${player.name} начал думать`)
      schedule(() => {
        console.info(`[bot] ${player.name} отправил ответ ${value}`)
        send()
      }, safeDelay)
      schedule(() => {
        console.info(`[bot] ${player.name} отправил fallback-ответ ${value}`)
        send()
      }, fallbackDelay)
    }
    if (phase === 'expansion') {
      PLAYERS.filter((player) => player.kind === 'bot' && match.expansionAnswers[player.id] === null)
        .forEach((player) => {
          const value = botQuizChoice(match.expansionQuestion.correctIndex, player.skill)
          scheduleBotAnswer(player.id, botAnswerDelayMs(player.skill, QUIZ_TIME_MS), value, () => dispatch({ type: 'answer-expansion', id: player.id, pick: value, answeredAt: performance.now() }))
        })
    }
    if (phase === 'expansion-final') {
      PLAYERS.filter((player) => player.kind === 'bot' && match.finalAnswers[player.id] === null)
        .forEach((player) => {
          const value = botNumericGuess(match.finalQuestion.answer, player.skill)
          scheduleBotAnswer(player.id, botAnswerDelayMs(player.skill, QUIZ_TIME_MS), value, () => dispatch({ type: 'answer-final', id: player.id, value, answeredAt: performance.now() }))
        })
    }
    if (phase === 'battle-select' && PLAYER_BY_ID[match.attacker].kind === 'bot') {
      const target = pickRandom(getAttackTargets(match.arena, match.attacker), 1)[0]
      if (target) schedule(() => dispatch({ type: 'select-attack', row: target.row, col: target.col }), 900)
    }
    if (phase === 'battle-warmup' && match.defender) {
      [match.attacker, match.defender]
        .filter((id) => match.warmupAnswers[id] === null && PLAYER_BY_ID[id].kind === 'bot')
        .forEach((id) => {
          const value = botQuizChoice(match.warmupQuestion.correctIndex, PLAYER_BY_ID[id].skill)
          scheduleBotAnswer(id, botAnswerDelayMs(PLAYER_BY_ID[id].skill, QUIZ_TIME_MS), value, () => dispatch({ type: 'answer-warmup', id, pick: value }))
        })
    }
    if (phase === 'battle-number' && match.defender) {
      [match.attacker, match.defender]
        .filter((id) => match.numericAnswers[id] === null && PLAYER_BY_ID[id].kind === 'bot')
        .forEach((id) => {
          const value = botNumericGuess(match.numericQuestion.answer, PLAYER_BY_ID[id].skill)
          scheduleBotAnswer(id, botAnswerDelayMs(PLAYER_BY_ID[id].skill, QUIZ_TIME_MS), value, () => dispatch({ type: 'answer-number', id, value }))
        })
    }
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [phase, paused, announcement, roundResult, timeline.questionAcceptsAnswers, match?.expansionRound, match?.battleRound, match?.target?.row, match?.target?.col])

  const togglePause = () => {
    setSettingsOpen(false)
    setPaused((value) => !value)
  }

  const humanQuestion = (question: QuizQuestion, answers: Answers, type: 'expansion' | 'warmup') => (
    <QuestionPanel
      question={question}
      remainingMs={remainingMs}
      locked={answers.you !== null || paused || (type === 'expansion' && timeline.inputExiting)}
      selected={answers.you}
      result={type === 'expansion' && timeline.resultVisible ? answers.you === question.correctIndex : null}
      onChoose={(pick) => {
        const send = () => type === 'expansion'
          ? dispatch({ type: 'answer-expansion', id: 'you', pick, answeredAt: performance.now() })
          : dispatch({ type: 'answer-warmup', id: 'you', pick })
        if (type === 'expansion') timeline.queueAnswer(send)
        else send()
      }}
    />
  )
  const battleTargetKeys = phase === 'battle-select' && match && match.attacker === 'you'
    ? new Set(getAttackTargets(match.arena, match.attacker).map((cell) => cellKey(cell.row, cell.col)))
    : undefined
  const expansionQueuePosition = match?.expansionQueue.indexOf('you') ?? -1
  const activeTurn = match
    ? phase.startsWith('battle')
      ? match.attacker
      : phase === 'expansion-review'
        ? match.expansionQueue[0] ?? null
        : match.pendingCapture ?? null
    : null
  const finalHumanLocked = match?.finalAnswers.you !== null

  useEffect(() => {
    if (phase !== 'results' || !match || recordedMatch.current) return
    const territory = PLAYER_IDS.map((id) => ({ id, count: match.arena.filter((cell) => cell.owner === id).length }))
    const winner = territory.sort((a, b) => b.count - a.count)[0]?.id
    const previous = readPveStats()
    savePveStats({
      games: previous.games + 1,
      wins: previous.wins + (winner === 'you' ? 1 : 0),
      mcCorrect: previous.mcCorrect + match.pveStats.mcCorrect,
      mcAnswered: previous.mcAnswered + match.pveStats.mcAnswered,
      numericDeviationTotal: previous.numericDeviationTotal + match.pveStats.numericDeviationTotal,
      numericAnswered: previous.numericAnswered + match.pveStats.numericAnswered,
    })
    recordedMatch.current = true
  }, [phase, match])

  return <div className={`arena ${phase === 'home' ? '' : `game-shell game-phase-${phase}`}`}>
    {phase !== 'home' ? <header className="topbar">
      <div><p className="kicker">Арена</p><h1>Ближе всех</h1></div>
      {match ? <div className="topbar-tools"><TurnIndicator activePlayer={activeTurn} /><PhaseBadge phase={phase} match={match} /><PlayerDock scores={match.scores} highlight={activeTurn} badges={{ [match.attacker]: phase.startsWith('battle') ? 'атакует' : undefined }} /><div className={`settings-menu${settingsOpen ? ' is-open' : ''}`}><button type="button" className="settings-button" aria-label="Настройки" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><span aria-hidden="true">⚙</span></button>{settingsOpen ? <div className="settings-popover"><button type="button" className="pause-button" onClick={togglePause}>{paused ? 'Продолжить' : 'Приостановить игру'}</button><button type="button" className="exit-button" onClick={exitGame}>Выйти из игры</button></div> : null}</div></div> : null}
    </header> : null}
    <main className="stage">
      {phase === 'home' && homeScreen === 'stats' ? <StatsScreen stats={readPveStats()} onBack={() => setHomeScreen('menu')} onHistory={() => setHomeScreen('history')} /> : null}
      {phase === 'home' && homeScreen === 'ranked' ? <RankedScreen onBack={() => setHomeScreen('menu')} /> : null}
      {phase === 'home' && homeScreen === 'friends' ? <FriendsScreen onBack={() => setHomeScreen('menu')} /> : null}
      {phase === 'home' && homeScreen === 'history' ? <HistoryScreen onBack={() => setHomeScreen('stats')} /> : null}
      {phase === 'home' && homeScreen === 'solo' ? <SoloQuizScreen questions={quizQuestions} onExit={() => setHomeScreen('menu')} /> : null}
      {phase === 'home' && homeScreen === 'menu' ? <MenuScreen notice={menuNotice} selectedQuestionBankFiles={selectedQuestionBankFiles} connectedQuestionCount={quizQuestions.length} onQuestionBankFilesChange={updateQuestionBankFiles} onSolo={startSolo} onStart={startMatch} onStats={() => setHomeScreen('stats')} onRanked={() => setHomeScreen('ranked')} onFriends={() => setHomeScreen('friends')} /> : null}
      <AnimatePresence mode="wait">
        {match && (timeline.mapVisible || (phase !== 'home' && phase !== 'expansion' && !questionPhase)) ? <motion.div key="map" className={`map-stage ${timeline.mapReturning ? 'is-returning' : ''}`} initial={{ opacity: 0.5, y: 10, filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -10, filter: 'blur(10px)' }} transition={{ duration: Math.max(ANIMATION_TIMINGS.minTransition, timeline.mapReturning ? ANIMATION_TIMINGS.mapReturn : ANIMATION_TIMINGS.minTransition) / 1000 }}><ArenaGrid cells={match.arena} activePlayer={phase === 'expansion-capture' && match.pendingCapture === 'you' ? 'you' : null} selectableKeys={battleTargetKeys} lastCapturedKey={match.lastCapturedKey} onCapture={(row, col) => phase === 'battle-select' ? dispatch({ type: 'select-attack', row, col }) : dispatch({ type: 'capture-expansion', row, col })} /></motion.div> : null}
        {((phase === 'expansion' && timeline.questionVisible) || (questionPhase && phase !== 'expansion' && !announcement)) ? <motion.div key="question" className={`question-stage ${timeline.inputExiting ? 'is-exiting' : ''}`} initial={{ opacity: 0, y: 50 }} animate={{ opacity: timeline.inputExiting ? 0 : 1, y: timeline.inputExiting ? -12 : 0 }} exit={{ opacity: 0, y: -18 }} transition={{ duration: (timeline.inputExiting ? ANIMATION_TIMINGS.inputExit : ANIMATION_TIMINGS.questionEnter) / 1000 }}>
          {phase === 'expansion' && match ? <>{expansionQueuePosition >= 0 ? <p className="queue-status">Ты в очереди захвата: {expansionQueuePosition + 1}-й</p> : null}{humanQuestion(match.expansionQuestion, match.expansionAnswers, 'expansion')}{match.expansionAnswers.you !== null && !expansionAllAnswered ? <p className="timeline-status">Ожидание соперников...</p> : null}</> : null}
          {phase === 'expansion-final' && match ? <FinalRoundPanel match={match} remainingMs={remainingMs} locked={finalHumanLocked || paused} onAnswer={(value) => dispatch({ type: 'answer-final', id: 'you', value, answeredAt: performance.now() })} /> : null}
          {phase === 'battle-warmup' && match && match.defender ? <><section className="panel battle-step"><p className="kicker">Битва · шаг 1 из 2 · Разминка</p><p className="hint">{PLAYER_BY_ID[match.attacker].name} атакует {PLAYER_BY_ID[match.defender].name}.</p></section>{match.attacker === 'you' || match.defender === 'you' ? humanQuestion(match.warmupQuestion, match.warmupAnswers, 'warmup') : <BotWaiting remainingMs={remainingMs} />}</> : null}
          {phase === 'battle-number' && match && match.defender ? <><section className="panel battle-step"><p className="kicker">Битва · шаг 2 из 2 · Числовая дуэль</p><h2>Ближе к правильному числу побеждает</h2><p className="hint">Скорость не влияет на результат.</p></section>{match.attacker === 'you' || match.defender === 'you' ? <NumberDuel match={match} remainingMs={remainingMs} paused={paused} onAnswer={(value) => dispatch({ type: 'answer-number', id: 'you', value })} /> : <BotWaiting remainingMs={remainingMs} />}</> : null}
        </motion.div> : null}
      </AnimatePresence>
      {phase === 'expansion' && (timeline.step === 'announcing' || timeline.step === 'pre-timer') ? <TimelineOverlay><RoundAnnouncement phase={phase} match={match} /></TimelineOverlay> : null}
      {announcement && questionPhase && phase !== 'expansion' ? <RoundAnnouncement phase={phase} match={match} /> : null}
      {paused ? <PauseOverlay onResume={togglePause} /> : null}
      {timeline.resultVisible && completedRoundResult?.kind === 'quiz' ? <RoundResultOverlay result={completedRoundResult} humanCorrect={match?.expansionAnswers.you === completedRoundResult.question.correctIndex} /> : null}
      {roundResult ? <RoundResultOverlay result={roundResult} /> : null}
      {phase === 'expansion-capture' && match?.pendingCapture === 'you' ? <section className="panel"><p className="kicker">Завоевание · правильный ответ</p><h2>{isExpansionBreakthrough(match.arena, 'you') ? 'Прорыв блокады: выбери любую свободную соту' : 'Выбери свободную соседнюю соту'}</h2><p className="hint">{isExpansionBreakthrough(match.arena, 'you') ? 'Твоя территория окружена. Десант можно высадить в любой свободной точке карты.' : 'Только соседняя свободная сота доступна для расширения.'}</p></section> : null}
      {phase === 'expansion-capture' && match?.pendingCapture && match.pendingCapture !== 'you' ? <section className="panel"><p className="kicker">Завоевание · правильный ответ</p><h2>{PLAYER_BY_ID[match.pendingCapture].name} выбирает территорию</h2><p className="hint">Следи за картой: захваты ботов теперь проходят по очереди.</p></section> : null}
      {phase === 'expansion-between' ? <section className="panel transition-panel"><p className="kicker">Переход</p><h2>Следующий раунд скоро начнется</h2><PauseProgress progress={timeline.progress} /></section> : null}
      {phase === 'battle-select' && match && match.attacker === 'you' ? <p className="map-instruction">Выбери подсвеченную вражескую соту на карте</p> : null}
      {phase === 'results' && match ? <FinalResultsScreen players={PLAYER_IDS.map((playerId) => ({
        playerId,
        name: PLAYER_BY_ID[playerId].name,
        color: PLAYER_BY_ID[playerId].accent,
        totalScore: match.scores[playerId],
        mcCorrect: match.mcStats[playerId].correct,
        mcTotal: match.mcStats[playerId].total,
        hexCount: match.arena.filter((cell) => cell.owner === playerId).length,
      }))} onMenu={exitGame} /> : null}
    </main>
  </div>
}

function PhaseBadge({ phase, match }: { phase: Phase; match: Match }) {
  const battle = phase.startsWith('battle') || phase === 'results'
  return <div className="phase-badge"><strong>{battle ? 'Битва' : 'Завоевание'}</strong><small>{battle ? `Раунд ${Math.min(match.battleRound + 1, MAX_BATTLE_ROUNDS)} / ${MAX_BATTLE_ROUNDS}` : `Раунд ${match.expansionRound}`}</small></div>
}

function RoundAnnouncement({ phase, match }: { phase: Phase; match: Match | null }) {
  const battle = phase.startsWith('battle')
  const numeric = phase === 'expansion-final' || phase === 'battle-number'
  return <motion.section className="round-announcement" initial={{ opacity: 0, scale: 0.8, y: 18 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: -12 }} transition={{ duration: ANIMATION_TIMINGS.announcementScale / 1000 }}>
    <p className="kicker">Новый раунд</p>
    <h2>{battle ? `Раунд ${Math.min((match?.battleRound ?? 0) + 1, MAX_BATTLE_ROUNDS)} из ${MAX_BATTLE_ROUNDS}` : `Раунд ${match?.expansionRound ?? 1}`}</h2>
    <p>{numeric ? 'Числовая дуэль' : 'Викторина'}</p>
    <span className="announcement-mark">✦</span>
  </motion.section>
}

function TimelineOverlay({ children }: { children: ReactNode }) {
  return <motion.div className="timeline-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: ANIMATION_TIMINGS.minTransition / 1000 }}>
    {children}
  </motion.div>
}

function PauseProgress({ progress }: { progress: number }) {
  return <div className="pause-progress" aria-label={`Пауза ${Math.round(progress * 100)}%`}><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
}

function PauseOverlay({ onResume }: { onResume: () => void }) {
  return <motion.div className="pause-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><section className="pause-card"><p className="kicker">Игра приостановлена</p><h2>Пауза</h2><p>Таймер и ответы остановлены.</p><button type="button" className="primary" onClick={onResume}>Продолжить</button></section></motion.div>
}

function answerBackground(playerIds: PlayerId[]): string {
  if (playerIds.length === 0) return 'var(--paper-deep)'
  const colors = playerIds.map((id) => PLAYER_BY_ID[id].accent)
  if (colors.length === 1) return colors[0]
  const step = 100 / colors.length
  const stops = colors.flatMap((color, index) => [`${color} ${index * step}%`, `${color} ${(index + 1) * step}%`])
  return `linear-gradient(to right, ${stops.join(', ')})`
}

function playersForOption(answers: Answers, optionIndex: number): PlayerId[] {
  return PLAYER_IDS.filter((id) => {
    const answer = answers[id]
    return Number.isInteger(answer) && answer === optionIndex && Boolean(PLAYER_BY_ID[id]?.accent)
  })
}

function RoundResultOverlay({ result, humanCorrect = null }: { result: RoundResult; humanCorrect?: boolean | null }) {
  if (result.kind === 'quiz') {
    const correctIndex = result.question.correctIndex
    return <motion.div className="round-result-overlay" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -18 }} transition={{ duration: ANIMATION_TIMINGS.resultReveal / 1000 }}><section className="round-result-card"><p className="kicker">Результаты викторины</p><h2 className="question-text">{result.question.prompt}</h2><div className="result-options">{result.question.options.map((option, index) => { const players = playersForOption(result.answers, index); return <motion.div key={option} className={`result-option ${index === correctIndex ? 'is-correct' : ''}`} style={{ background: answerBackground(players) }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: ANIMATION_TIMINGS.minTransition / 1000, delay: index * 0.04 }}><strong>{['А', 'Б', 'В', 'Г'][index]}</strong><span>{option}</span></motion.div> })}</div>{humanCorrect !== null ? <motion.p className={`answer-verdict ${humanCorrect ? 'is-correct' : 'is-wrong'}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: ANIMATION_TIMINGS.minTransition / 1000 }}> {humanCorrect ? 'Правильно!' : 'Неправильно'} </motion.p> : null}</section></motion.div>
  }
  const participants = result.participants ?? PLAYER_IDS
  const rows = participants
    .map((id) => {
      const value = result.answers[id]
      const distance = value === null ? null : Math.abs(value - result.question.answer)
      return { id, value, distance, exact: value !== null && isExactNumericHit(value, result.question.answer) }
    })
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
  return <motion.div className="round-result-overlay" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}><section className="round-result-card"><p className="kicker">Результаты числовой дуэли</p><h2>Правильный ответ: {result.question.answer}</h2><div className="numeric-result-cards">{rows.map((row, index) => <article key={row.id} className={`numeric-result-card ${index === 0 ? 'is-winner' : ''} ${row.exact ? 'has-exact-bonus' : ''}`} style={{ ['--accent' as string]: PLAYER_BY_ID[row.id].accent }}><strong>{PLAYER_BY_ID[row.id].name}</strong><span>{row.value === null ? 'нет ответа' : row.value}</span><small>{row.distance === null ? '—' : `Отклонение: ${row.value! - result.question.answer > 0 ? '+' : ''}${row.value! - result.question.answer}`}</small>{row.exact ? <em>Бонус за точный ответ: +5</em> : null}</article>)}</div></section></motion.div>
}

function TurnIndicator({ activePlayer }: { activePlayer: PlayerId | null }) {
  return <div className="turn-indicator" aria-label={activePlayer ? `Ход: ${PLAYER_BY_ID[activePlayer].name}` : 'Ход не выбран'}>
    <svg viewBox="0 0 40 40" role="img" aria-hidden="true">
      <path className={activePlayer === 'you' ? 'is-active' : ''} fill={PLAYER_BY_ID.you.accent} d="M20 20 20 2A18 18 0 0 1 35.6 29Z" />
      <path className={activePlayer === 'alex' ? 'is-active' : ''} fill={PLAYER_BY_ID.alex.accent} d="M20 20 35.6 29A18 18 0 0 1 4.4 29Z" />
      <path className={activePlayer === 'marina' ? 'is-active' : ''} fill={PLAYER_BY_ID.marina.accent} d="M20 20 4.4 29A18 18 0 0 1 20 2Z" />
    </svg>
    <span>{activePlayer ? PLAYER_BY_ID[activePlayer].name : 'Ожидание'}</span>
  </div>
}

function QuestionPanel({ question, remainingMs, locked, selected, result, onChoose }: { question: QuizQuestion; remainingMs: number; locked: boolean; selected: number | null; result: boolean | null; onChoose: (pick: number) => void }) {
  return <section className="panel question-card"><p className="kicker">Общий вопрос · отвечают все одновременно</p><h2 className="question-text">{question.prompt}</h2><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><div className="options">{question.options.map((option, index) => <motion.button key={option} type="button" className={`option ${selected === index ? 'is-selected' : ''}`} style={{ ['--answer-color' as string]: PLAYER_BY_ID.you.accent }} disabled={locked} whileTap={{ scale: 0.95 }} transition={{ duration: ANIMATION_TIMINGS.answerPress / 1000 }} onClick={() => onChoose(index)}><span className="opt-key">{['А', 'Б', 'В', 'Г'][index]}</span>{option}</motion.button>)}</div>{result !== null ? <p className={`answer-verdict ${result ? 'is-correct' : 'is-wrong'}`}>{result ? 'Правильно!' : 'Неправильно'}</p> : null}<p className="hint">{locked ? 'Ответ принят. Ждём остальных игроков.' : `На ответ есть ${Math.round(QUIZ_TIME_MS / 1000)} секунд.`}</p></section>
}

function NumberDuel({ match, remainingMs, paused, onAnswer }: { match: Match; remainingMs: number; paused: boolean; onAnswer: (value: number | null) => void }) {
  const [value, setValue] = useState('')
  const [locked, setLocked] = useState(false)
  return <section className="panel question-card"><p className="kicker">Одновременный ответ</p><p className="hint question-text">{match.numericQuestion.prompt}</p><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><form className="guess-form" onSubmit={(event) => { event.preventDefault(); const parsed = Number(value.replace(',', '.')); if (!Number.isFinite(parsed)) return; setLocked(true); onAnswer(parsed) }}><input value={value} onChange={(event) => setValue(event.target.value)} disabled={locked || paused} inputMode="decimal" placeholder="Твоё число" aria-label="Числовой ответ" /><button type="submit" disabled={locked || paused}>{locked ? 'Принято' : 'Ответить'}</button></form><p className="hint">Сравнивается только абсолютное отклонение, без бонуса за скорость.</p></section>
}

function FinalRoundPanel({ match, remainingMs, locked, onAnswer }: { match: Match; remainingMs: number; locked: boolean; onAnswer: (value: number | null) => void }) {
  const [value, setValue] = useState('')
  return <section className="panel question-card final-round-panel"><p className="kicker">РЕШАЮЩИЙ РАУНД · ФИНАЛЬНАЯ СОТА</p><h2 className="question-text">{match.finalQuestion.prompt}</h2><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><form className="guess-form" onSubmit={(event) => { event.preventDefault(); const parsed = Number(value.replace(',', '.')); if (!Number.isFinite(parsed)) return; onAnswer(parsed) }}><input value={value} onChange={(event) => setValue(event.target.value)} disabled={locked} inputMode="decimal" placeholder="Твоё число" aria-label="Ответ финального раунда" /><button type="submit" disabled={locked}>{locked ? 'Принято' : 'Ответить'}</button></form><p className="hint">Осталась одна сота. Побеждает ближайший ответ; при равенстве решает время отправки.</p></section>
}

function BotWaiting({ remainingMs }: { remainingMs: number }) { return <section className="panel"><p className="kicker">Одновременный ответ</p><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><p className="hint">Боты отвечают…</p></section> }

type FinalResultPlayer = {
  playerId: string
  name: string
  color: string
  totalScore: number
  mcCorrect: number
  mcTotal: number
  hexCount: number
}

function mcAccuracy(player: FinalResultPlayer): number | null {
  return player.mcTotal === 0 ? null : Math.round((player.mcCorrect / player.mcTotal) * 100)
}

function tieReason(player: FinalResultPlayer, previous: FinalResultPlayer | undefined): 'accuracy' | 'territory' | null {
  if (!previous || player.totalScore !== previous.totalScore) return null
  const playerAccuracy = mcAccuracy(player) ?? -1
  const previousAccuracy = mcAccuracy(previous) ?? -1
  if (playerAccuracy !== previousAccuracy) return 'accuracy'
  if (player.hexCount !== previous.hexCount) return 'territory'
  return null
}

function AnimatedNumber({ value }: { value: number }) {
  const [display, setDisplay] = useState(0)
  useEffect(() => {
    const startedAt = performance.now()
    let frame = 0
    const tick = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / 800)
      setDisplay(Math.round(value * progress))
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value])
  return <>{display}</>
}

function FinalResultsScreen({ players, onMenu }: { players: FinalResultPlayer[]; onMenu: () => void }) {
  const ordered = [...players].sort((left, right) => {
    if (right.totalScore !== left.totalScore) return right.totalScore - left.totalScore
    const rightAccuracy = mcAccuracy(right) ?? -1
    const leftAccuracy = mcAccuracy(left) ?? -1
    if (rightAccuracy !== leftAccuracy) return rightAccuracy - leftAccuracy
    return right.hexCount - left.hexCount
  })
  const medals = ['🥇', '🥈', '🥉']
  return <motion.section className="final-results-screen" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
    <ConfettiBurst />
    <h2>РЕЗУЛЬТАТЫ МАТЧА</h2>
    <div className="winner-podium">
      {ordered.map((player, index) => {
        const accuracy = mcAccuracy(player)
        const reason = tieReason(player, ordered[index - 1])
        return <motion.article key={player.playerId} className={`podium-card place-${index + 1}`} style={{ ['--accent' as string]: player.color }} initial={{ opacity: 0, y: 30, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5, delay: index * 0.2 }}>
          <div className="podium-medal" aria-hidden="true">{medals[index]}</div>
          <header className="podium-player">
            <span className="podium-avatar" aria-hidden="true">{player.name.slice(0, 1)}</span>
            <div>
              <strong>{player.name}</strong>
              {reason ? <small>{reason === 'accuracy' ? 'По точности' : 'По территориям'}</small> : null}
            </div>
          </header>
          <div className="podium-score"><AnimatedNumber value={player.totalScore} /><span>ОЧКИ</span></div>
          <motion.p className="podium-stat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.8 + index * 0.2 }}>Точность ответов: {accuracy === null ? '—' : `${accuracy}%`}</motion.p>
          <p className="podium-territory">Захвачено территорий: {player.hexCount}</p>
        </motion.article>
      })}
    </div>
    <button type="button" className="wood-plaque plaque-red final-menu-button" onClick={onMenu}>Выйти в меню</button>
  </motion.section>
}

function ConfettiBurst() {
  return <div className="confetti-burst" aria-hidden="true">
    {Array.from({ length: 18 }, (_, index) => <i key={index} style={{ ['--x' as string]: `${(index % 6) * 18 - 45}px`, ['--delay' as string]: `${index * 0.055}s` }} />)}
  </div>
}

function StatsScreen({ stats, onBack, onHistory }: { stats: PveStats; onBack: () => void; onHistory: () => void }) {
  const mcAccuracy = stats.mcAnswered ? Math.round((stats.mcCorrect / stats.mcAnswered) * 100) : null
  const numericAccuracy = stats.numericAnswered ? Math.max(0, Math.round(100 - (stats.numericDeviationTotal / stats.numericAnswered))) : null
  return <section className="stats-screen">
    <button type="button" className="stats-back" onClick={onBack}>← Главное меню</button>
    <header className="stats-title"><p className="menu-eyebrow">Летопись сражений</p><h2>СТАТИСТИКА</h2><div className="title-rule" aria-hidden="true"><i /><b /><i /></div><button type="button" className="wood-plaque stats-history-button plaque-light" onClick={onHistory}>ИСТОРИЯ ИГР</button></header>
    <div className="stats-dashboard">
      <section className="stats-block stats-pvp"><p className="stats-block-kicker">Блок A · Рейтинговые игры (PvP)</p><div className="stats-columns"><StatsColumn title="Дуэль · 1v1" rows={[['Побед', '0'], ['Поражений', '0'], ['% правильных MC', '0%']]} /><StatsColumn title="Троица · 1v1v1" rows={[['1-е места', '0 🥇'], ['2-е места', '0 🥈'], ['3-е места', '0 🥉'], ['% правильных MC', '0%']]} /></div><p className="stats-empty-note">Рейтинговый режим пока не подключён</p></section>
      <section className="stats-block stats-pve"><p className="stats-block-kicker">Блок B · Игра с ботами (PvE)</p><div className="pve-grid"><StatMetric label="Всего игр" value={stats.games} /><StatMetric label="Побед над ботами" value={stats.wins} /><StatMetric label="% правильных MC" value={mcAccuracy === null ? '0%' : `${mcAccuracy}%`} progress={mcAccuracy ?? 0} /><StatMetric label="Точность числовых ответов" value={numericAccuracy === null ? '—' : `${numericAccuracy}%`} progress={numericAccuracy ?? 0} /></div></section>
    </div>
    <p className="menu-version">Данные хранятся на этом устройстве · v1.0</p>
  </section>
}

function RankedScreen({ onBack }: { onBack: () => void }) {
  const [notice, setNotice] = useState('')
  const showNotice = (label: string) => setNotice(`${label}: скоро будет доступно`)
  return <section className="ranked-screen">
    <button type="button" className="stats-back" onClick={onBack}>← Главное меню</button>
    <header className="stats-title"><p className="menu-eyebrow">Летопись соперников</p><h2>РЕЙТИНГОВАЯ ИГРА</h2><div className="title-rule" aria-hidden="true"><i /><b /><i /></div></header>
    <div className="ranked-actions">
      <button type="button" className="wood-plaque plaque-red" onClick={() => showNotice('Игра втроём')}><span>ИГРАТЬ ВТРОЕМ</span><small>1V1V1 · СКОРО</small></button>
      <button type="button" className="wood-plaque plaque-light" onClick={() => showNotice('Дуэль')}><span>ДУЭЛЬ</span><small>1V1 · СКОРО</small></button>
    </div>
    {notice ? <p className="ranked-notice">{notice}</p> : null}
  </section>
}

function FriendsScreen({ onBack }: { onBack: () => void }) {
  const [roomCode, setRoomCode] = useState(() => getInviteRoomCode())
  const [state, setState] = useState<MultiplayerGameState | null>(null)
  const [notice, setNotice] = useState('')
  const [socket, setSocket] = useState<MultiplayerSocket | null>(null)
  const currentRoomCode = state?.roomCode ?? null
  useTelegramControls(onBack, currentRoomCode)

  useEffect(() => {
    if (!currentRoomCode) return
    const socket = connectMultiplayerSocket(currentRoomCode, setState, setNotice)
    socket.on('connect_error', (error) => setNotice(`Ошибка подключения: ${error.message}`))
    socket.on('error_message', setNotice)
    setSocket(socket)
    return () => {
      socket.disconnect()
      setSocket(null)
    }
  }, [currentRoomCode])

  const createRoom = async () => {
    try {
      const response = await createMultiplayerRoom()
      setState(response.state)
      setRoomCode(response.roomCode)
      setNotice(`Комната ${response.roomCode} создана. Ждем 3 игроков.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось создать комнату')
    }
  }

  const joinRoom = async () => {
    try {
      const response = await joinMultiplayerRoom(roomCode)
      setState(response.state)
      setNotice(`Подключение к комнате ${response.state.roomCode}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось войти в комнату')
    }
  }

  return <section className="ranked-screen">
    <button type="button" className="stats-back" onClick={onBack}>← Главное меню</button>
    <header className="stats-title"><p className="menu-eyebrow">Сражение за одним столом</p><h2>ИГРА С ДРУЗЬЯМИ</h2><div className="title-rule" aria-hidden="true"><i /><b /><i /></div></header>
    <div className="ranked-actions">
      <button type="button" className="wood-plaque plaque-red" onClick={createRoom}><span>СОЗДАТЬ КОМНАТУ</span><small>КОД НА 3 ИГРОКОВ</small></button>
      <label className="room-code-field">
        <span>Код комнаты</span>
        <input value={roomCode} onChange={(event) => setRoomCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" placeholder="000000" />
      </label>
      <button type="button" className="wood-plaque plaque-light" disabled={roomCode.length !== 6} onClick={joinRoom}><span>ВОЙТИ ПО КОДУ</span><small>ONLINE · SOCKET.IO</small></button>
      {currentRoomCode ? <button type="button" className="wood-plaque plaque-light" onClick={() => { shareTelegramInvite(currentRoomCode); setNotice(`Ссылка-приглашение готова: ${getTelegramInviteUrl(currentRoomCode)}`) }}><span>ПРИГЛАСИТЬ ДРУГА</span><small>TELEGRAM LINK</small></button> : null}
    </div>
    {state ? <div className="online-room-panel">
      <p className="menu-eyebrow">Комната {state.roomCode}</p>
      <h3>{state.status === 'preparing' ? 'Матч скоро начнется' : state.status === 'playing' ? `Раунд ${state.round}` : state.status === 'finished' ? 'Матч завершен' : 'Ожидание игроков'}</h3>
      <div className="online-player-list">
        {state.players.map((player) => <span key={player.id} style={{ borderColor: player.color, color: player.color }}>{player.name} · {player.status}</span>)}
      </div>
    </div> : null}
    {state && (state.status === 'playing' || state.status === 'finished') ? <OnlineGameView state={state} socket={socket} /> : null}
    {notice ? <p className="ranked-notice">{notice}</p> : null}
  </section>
}

function useServerRemainingMs(timerEndsAt: number | null): number {
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!timerEndsAt) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [timerEndsAt])
  return timerEndsAt ? Math.max(0, timerEndsAt - now) : 0
}

function OnlineGameView({ state, socket }: { state: MultiplayerGameState; socket: MultiplayerSocket | null }) {
  const remainingMs = useServerRemainingMs(state.timerEndsAt)
  const active = state.players.find((player) => player.id === state.activePlayerId)
  const [notice, setNotice] = useState('')
  const sendAnswer = (answer: number) => socket?.emit('answer_submitted', { roomId: state.roomId, answer }, (response) => {
    setNotice(response.ok ? 'Ответ принят' : response.error)
  })
  const chooseHex = (row: number, col: number) => {
    const event = state.phase === 'battle-select' ? 'attack_chosen' : 'hex_selected'
    socket?.emit(event, { roomId: state.roomId, row, col }, (response) => {
      setNotice(response.ok ? '' : response.error)
    })
  }

  return <motion.section className="online-game-view" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
    <div className="online-topline">
      <strong>{state.phase === 'battle-select' ? 'Битва' : state.phase === 'battle-number' ? 'Числовая дуэль' : 'Завоевание'}</strong>
      <span>{active ? `Ход: ${active.name}` : 'Ожидание сервера'}</span>
    </div>
    <div className="online-score-row">
      {state.players.filter((player) => !player.botReplacementFor).map((player) => <article key={player.id} className={state.activePlayerId === player.id ? 'is-active' : ''} style={{ ['--accent' as string]: player.color }}>
        <b>{player.name}</b>
        <span>{state.scores[player.id] ?? 0}</span>
      </article>)}
    </div>
    <OnlineArenaGrid state={state} onChoose={chooseHex} />
    {state.currentQuestion && state.currentQuestion.type !== 'numeric' && state.phase === 'expansion' ? <section className="panel online-question-panel">
      <p className="kicker">Онлайн · общий вопрос</p>
      <h2>{state.currentQuestion.prompt}</h2>
      <TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} />
      <div className="options">
        {state.currentQuestion.options.map((option, index) => <motion.button key={`${option}-${index}`} type="button" className="option" style={{ ['--answer-color' as string]: active?.color ?? '#b55239' }} whileTap={{ scale: 0.95 }} onClick={() => sendAnswer(index)}>
          <span className="opt-key">{['А', 'Б', 'В', 'Г'][index]}</span>{option}
        </motion.button>)}
      </div>
      <p className="hint">Ответ проверит сервер; правильный вариант клиенту не отправляется.</p>
    </section> : null}
    {state.currentQuestion?.type === 'numeric' && state.phase === 'battle-number' ? <OnlineNumberPanel state={state} remainingMs={remainingMs} onAnswer={(answer) => sendAnswer(answer)} /> : null}
    {state.phase === 'expansion-review' && state.roundResult ? <OnlineRoundResults state={state} /> : null}
    {state.phase === 'expansion-capture' ? <p className="map-instruction">{active ? `${active.name} выбирает территорию` : 'Ожидание хода'}</p> : null}
    {state.phase === 'battle-select' ? <p className="map-instruction">{active ? `${active.name} выбирает цель атаки` : 'Ожидание атаки'}</p> : null}
    {notice ? <p className="online-action-notice">{notice}</p> : null}
    {state.phase === 'results' ? <OnlineFinalResults state={state} /> : null}
  </motion.section>
}

function OnlineRoundResults({ state }: { state: MultiplayerGameState }) {
  const correctOption = state.roundResult?.correctOption
  return <motion.section className="panel online-question-panel" initial={{ opacity: 0, y: 30, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5 }}>
    <p className="kicker">Результаты раунда</p>
    <h2>{state.currentQuestion?.prompt ?? 'Результаты вопроса'}</h2>
    {state.currentQuestion ? <div className="result-options">
      {state.currentQuestion.options.map((option, index) => <motion.div key={`${option}-${index}`} className={`result-option ${index === correctOption ? 'is-correct' : ''}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: index * 0.06 }}>
        <strong>{['А', 'Б', 'В', 'Г'][index]}</strong>
        <span>{option}</span>
      </motion.div>)}
    </div> : null}
    <p className="hint">К захвату допущены: {state.roundResult?.correctPlayerIds.map((id) => state.players.find((player) => player.id === id)?.name ?? id).join(', ') || 'никто'}</p>
  </motion.section>
}

function OnlineNumberPanel({ state, remainingMs, onAnswer }: { state: MultiplayerGameState; remainingMs: number; onAnswer: (answer: number) => void }) {
  const [value, setValue] = useState('')
  return <section className="panel online-question-panel">
    <p className="kicker">Онлайн · числовая дуэль</p>
    <h2>{state.currentQuestion?.prompt}</h2>
      <TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} />
    <form className="guess-form" onSubmit={(event) => { event.preventDefault(); const parsed = Number(value.replace(',', '.')); if (Number.isFinite(parsed)) onAnswer(parsed) }}>
      <input value={value} onChange={(event) => setValue(event.target.value)} inputMode="decimal" placeholder="Твоё число" />
      <button type="submit">Ответить</button>
    </form>
    <p className="hint">Сервер сравнит только участников дуэли.</p>
  </section>
}

function OnlineFinalResults({ state }: { state: MultiplayerGameState }) {
  return <FinalResultsScreen players={state.players.filter((player) => !player.botReplacementFor).map((player) => ({
    playerId: player.id,
    name: player.name,
    color: player.color,
    totalScore: state.scores[player.id] ?? 0,
    mcCorrect: state.mcStats[player.id]?.correct ?? 0,
    mcTotal: state.mcStats[player.id]?.total ?? 0,
    hexCount: state.arena.filter((cell) => cell.ownerId === player.id).length,
  }))} onMenu={() => window.location.reload()} />
}

function SoloQuizScreen({ questions, onExit }: { questions: QuizQuestion[]; onExit: () => void }) {
  const [progress, setProgress] = useState<SoloProgress>(() => readSoloProgress())
  const [question, setQuestion] = useState<QuizQuestion | null>(() => nextSoloQuestion(readSoloProgress(), questions))
  const [selected, setSelected] = useState<number | null>(null)
  const [result, setResult] = useState<'correct' | 'wrong' | null>(null)
  const [toastPercent, setToastPercent] = useState<number | null>(null)
  const [flagNotice, setFlagNotice] = useState('')
  const totalQuestions = questions.length
  const selectedQuestionIds = new Set(questions.map((item) => item.id))
  const seenSelectedCount = progress.seenQuestionIds.filter((id) => selectedQuestionIds.has(id)).length
  const progressPercent = Math.floor((seenSelectedCount / totalQuestions) * 100)
  const accuracy = progress.totalAnswered === 0 ? 0 : Math.round((progress.correctAnswers / progress.totalAnswered) * 100)
  const roundDone = result !== null || !question

  const commitProgress = (next: SoloProgress) => {
    setProgress(next)
    saveSoloProgress(next)
  }

  const showMilestone = (percent: number, next: SoloProgress) => {
    setToastPercent(percent)
    window.setTimeout(() => {
      setToastPercent(null)
      const latest = readSoloProgress()
      if (latest.lastMilestone >= percent) return
      commitProgress({ ...latest, lastMilestone: percent })
    }, 2000)
    commitProgress(next)
  }

  function answerSolo(pick: number | null) {
    if (!question || result !== null) return
    const correct = pick === question.correctIndex
    const seenQuestionIds = progress.seenQuestionIds.includes(question.id)
      ? progress.seenQuestionIds
      : [...progress.seenQuestionIds, question.id]
    const currentStreak = correct ? progress.currentStreak + 1 : 0
    const next: SoloProgress = {
      ...progress,
      seenQuestionIds,
      currentStreak,
      bestStreak: Math.max(progress.bestStreak, currentStreak),
      totalAnswered: progress.totalAnswered + 1,
      correctAnswers: progress.correctAnswers + (correct ? 1 : 0),
    }
    setSelected(pick)
    setResult(correct ? 'correct' : 'wrong')
    const percent = Math.floor((seenQuestionIds.filter((id) => selectedQuestionIds.has(id)).length / totalQuestions) * 100)
    if (correct && percent > progress.lastMilestone && percent >= 1 && percent <= 100) {
      showMilestone(percent, next)
    } else {
      commitProgress(next)
    }
  }

  const nextRound = () => {
    const latest = readSoloProgress()
    const nextQuestion = nextSoloQuestion(latest, questions)
    setProgress(latest)
    setQuestion(nextQuestion)
    setSelected(null)
    setResult(null)
  }

  const restart = () => {
    const fresh: SoloProgress = {
      ...emptySoloProgress(),
      questionOrder: cryptoShuffle(questions.map((item) => item.id)),
    }
    saveSoloProgress(fresh)
    setProgress(fresh)
    setQuestion(nextSoloQuestion(fresh, questions))
    setSelected(null)
    setResult(null)
    setToastPercent(null)
    setFlagNotice('')
  }

  const flagQuestion = async () => {
    if (!question) return
    const flaggedQuestion = toSoloFlaggedQuestion(question)
    try {
      const response = await fetch(`${API_URL}/api/solo-flag-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flaggedQuestion),
      })
      if (!response.ok) throw new Error('server unavailable')
      setFlagNotice('Вопрос добавлен в solo_flagged_questions.json')
    } catch {
      setFlagNotice('Backend не запущен, вопрос не сохранен')
    }
    window.setTimeout(() => setFlagNotice(''), 2200)
  }

  if (!question) {
    return <section className="solo-screen">
      <button type="button" className="solo-exit" onClick={onExit}>Выйти в меню</button>
      <div className="solo-complete panel">
        <p className="kicker">Соло</p>
        <h2>Все вопросы пройдены!</h2>
        <div className="solo-stats">
          <StatMetric label="Всего отвечено" value={progress.totalAnswered} />
          <StatMetric label="Лучший стрик" value={progress.bestStreak} />
          <StatMetric label="Точность" value={`${accuracy}%`} progress={accuracy} />
        </div>
        <button type="button" className="wood-plaque plaque-red solo-next" onClick={restart}>НАЧАТЬ ЗАНОВО</button>
      </div>
    </section>
  }

  return <section className="solo-screen">
    <button type="button" className="solo-exit" onClick={onExit}>Пауза / Выход в меню</button>
    <header className="solo-hud">
      <div className="solo-progress">
        <span>% правильных ответов: {accuracy}%</span>
        <i><b style={{ width: `${progressPercent}%` }} /></i>
      </div>
      <motion.div key={progress.currentStreak} className="solo-streak" initial={{ scale: 1 }} animate={{ scale: [1, 1.08, 1] }} transition={{ duration: 0.32 }}>
        Серия: {progress.currentStreak}
      </motion.div>
    </header>
    <section className="panel solo-question-panel">
      <button type="button" className="solo-flag-button" onClick={flagQuestion} title="Отправить вопрос в solo_flagged_questions.json" aria-label="Отправить вопрос в JSON-файл">!</button>
      <p className="kicker">Соло · вопрос {seenSelectedCount + (result ? 0 : 1)} из {totalQuestions}</p>
      <p className="solo-category">{question.category ?? 'Общие знания'}</p>
      <h2>{question.prompt}</h2>
      <div className="options">
        {question.options.map((option, index) => (
          <motion.button key={`${question.id}-${option}`} type="button" className={`option ${selected === index ? 'is-selected' : ''} ${result && index === question.correctIndex ? 'is-correct' : ''}`} disabled={roundDone} whileTap={{ scale: 0.95 }} onClick={() => answerSolo(index)}>
            <span className="opt-key">{['А', 'Б', 'В', 'Г'][index]}</span>{option}
          </motion.button>
        ))}
      </div>
      {result ? <button type="button" className="primary solo-next" onClick={nextRound}>Следующий вопрос</button> : null}
      {flagNotice ? <p className="solo-flag-notice">{flagNotice}</p> : null}
    </section>
    <AnimatePresence>
      {toastPercent !== null ? <motion.div className="solo-toast" initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.25 }}>🎉 Пройдено {toastPercent}% вопросов!</motion.div> : null}
    </AnimatePresence>
  </section>
}

function HistoryScreen({ onBack }: { onBack: () => void }) {
  return <section className="history-screen">
    <button type="button" className="stats-back" onClick={onBack}>← Статистика</button>
    <header className="stats-title"><p className="menu-eyebrow">Летопись матчей</p><h2>ИСТОРИЯ ИГР</h2><div className="title-rule" aria-hidden="true"><i /><b /><i /></div></header>
    <div className="history-empty"><span aria-hidden="true">✦</span><h3>История пуста</h3><p>Завершённые матчи появятся здесь.</p></div>
  </section>
}

function StatsColumn({ title, rows }: { title: string; rows: string[][] }) {
  return <div className="stats-column"><h3>{title}</h3>{rows.map(([label, value]) => <div className="stats-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
}

function StatMetric({ label, value, progress }: { label: string; value: number | string; progress?: number }) {
  return <div className="stat-metric"><span>{label}</span><strong>{value}</strong>{progress !== undefined ? <i><b style={{ width: `${progress}%` }} /></i> : null}</div>
}

function MenuScreen({
  notice,
  selectedQuestionBankFiles,
  connectedQuestionCount,
  onQuestionBankFilesChange,
  onSolo,
  onStart,
  onStats,
  onRanked,
  onFriends,
}: {
  notice: string
  selectedQuestionBankFiles: number[]
  connectedQuestionCount: number
  onQuestionBankFilesChange: (files: number[]) => void
  onSolo: () => void
  onStart: () => void
  onStats: () => void
  onRanked: () => void
  onFriends: () => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bankOpen, setBankOpen] = useState(false)
  const [bankInput, setBankInput] = useState(() => selectedQuestionBankFiles.join(', '))
  const selectedBankSet = new Set(selectedQuestionBankFiles)

  useEffect(() => {
    setBankInput(selectedQuestionBankFiles.join(', '))
  }, [selectedQuestionBankFiles])

  const applyBankInput = () => {
    const next = parseQuestionBankSelection(bankInput)
    if (next.length > 0) onQuestionBankFilesChange(next)
    else setBankInput(selectedQuestionBankFiles.join(', '))
  }

  const toggleQuestionBankFile = (file: number) => {
    const next = selectedBankSet.has(file)
      ? selectedQuestionBankFiles.filter((item) => item !== file)
      : [...selectedQuestionBankFiles, file]
    if (next.length > 0) onQuestionBankFilesChange(next)
  }

  return <section className="menu-map-screen">
    <div className="map-ornament map-ornament-top" aria-hidden="true" />
    <div className="menu-settings-wrap">
      <button type="button" className="menu-settings" aria-label="Настройки" title="Настройки" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm8.2 3.6c0-.5-.1-1-.2-1.5l2-1.5-2-3.4-2.4 1a9 9 0 0 0-2.6-1.5L14.7 2H9.3L9 5.1a9 9 0 0 0-2.6 1.5L4 5.6 2 9l2 1.5a8 8 0 0 0 0 3L2 15l2 3.4 2.4-1A9 9 0 0 0 9 18.9l.3 3.1h5.4l.3-3.1a9 9 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5c.1-.5.2-1 .2-1.5Z" /></svg>
      </button>
      {settingsOpen ? <div className="menu-settings-popover">
        <button type="button" className="menu-bank-toggle" onClick={() => setBankOpen((open) => !open)}>банк вопросов</button>
        {bankOpen ? <div className="menu-bank-control">
          <div className="menu-bank-summary">
            <span>Файлов: {selectedQuestionBankFiles.length} / {QUESTION_BANK_FILE_COUNT}</span>
            <strong>Вопросов: {connectedQuestionCount}</strong>
          </div>
          <div className="menu-bank-actions">
            <button type="button" onClick={() => onQuestionBankFilesChange(allQuestionBankFiles())}>Все файлы</button>
            <button type="button" onClick={() => onQuestionBankFilesChange([1])}>Только 1</button>
          </div>
          <label className="menu-bank-input">
            <span>Номера файлов</span>
            <input
              type="text"
              value={bankInput}
              placeholder="Например: 3, 5, 7"
              onChange={(event) => setBankInput(event.target.value)}
              onBlur={applyBankInput}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur()
                  applyBankInput()
                }
              }}
            />
          </label>
          <div className="menu-bank-files" aria-label="Файлы банка вопросов">
            {allQuestionBankFiles().map((file) => <button
              type="button"
              key={file}
              className={`menu-bank-file${selectedBankSet.has(file) ? ' is-selected' : ''}`}
              title={`question_bank/my_game_question${file}.json`}
              onClick={() => toggleQuestionBankFile(file)}
            >
              {file}
            </button>)}
          </div>
        </div> : null}
      </div> : null}
    </div>
    <header className="menu-title">
      <p className="menu-eyebrow">Средневековая карта знаний</p>
      <h2>STRATEGI <span>QUIZ</span></h2>
      <div className="title-rule" aria-hidden="true"><i /><b /><i /></div>
    </header>
    <div className="map-scene" aria-label="Карта стратегической викторины">
      <div className="mountain mountain-left" aria-hidden="true"><i /><i /><i /></div>
      <div className="mountain mountain-right" aria-hidden="true"><i /><i /><i /></div>
      <div className="hex-field" aria-hidden="true" />
      <div className="route route-one" aria-hidden="true" />
      <div className="route route-two" aria-hidden="true" />
      <HexToken className="token-top" color="terracotta" label="Игрок 1" />
      <HexToken className="token-left" color="olive" label="Игрок 2" />
      <HexToken className="token-right" color="blue" label="Игрок 3" />
    </div>
    <div className="menu-actions menu-plaques" aria-label="Режимы игры">
      <button type="button" className="wood-plaque plaque-red" onClick={onSolo}><span>СОЛО</span><small>БЕСКОНЕЧНО</small></button>
      <button type="button" className="wood-plaque plaque-red" onClick={onRanked}><span>РЕЙТИНГОВАЯ ИГРА</span><small>ОТКРЫТЬ</small></button>
      <button type="button" className="wood-plaque plaque-light" onClick={onStart}><span>ИГРА С БОТАМИ</span><small>НАЧАТЬ</small></button>
      <button type="button" className="wood-plaque plaque-light" onClick={onFriends}><span>ИГРА С ДРУЗЬЯМИ</span><small>ОТКРЫТЬ</small></button>
    </div>
    <button type="button" className="stats-link" onClick={onStats}>ОТКРЫТЬ СТАТИСТИКУ</button>
    {notice ? <p className="menu-notice">{notice}</p> : null}
    <p className="menu-version">v1.0</p>
  </section>
}

function HexToken({ className, color, label }: { className: string; color: 'terracotta' | 'olive' | 'blue'; label: string }) {
  return <div className={`hex-token ${className} token-${color}`} title={label} aria-label={label}>
    <svg viewBox="0 0 100 112" aria-hidden="true">
      <polygon points="50,3 96,28 96,84 50,109 4,84 4,28" />
      <path className="castle-mark" d="M32 76V48h7V39h7v9h8V39h7v9h7v28H32Zm-5 5h46M42 76V64h7v12m9 0V64h7v12M25 81h50" />
    </svg>
  </div>
}
