import { numericDuel } from '../shared/battleRules'
import { BotGameSettings } from './components/BotGameSettings'
import { BOT_SETTINGS_KEY, BOT_SKILL, parseBotSettings, botPlayerIds, arenaRadius, questionsForTopics, numericQuestionsForTopics, type BotSettings } from './game/botSettings'
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArenaGrid } from './components/ArenaGrid'
import { OnlineArenaGrid } from './components/OnlineArenaGrid'
import { PlayerDock } from './components/PlayerDock'
import { TimerRing } from './components/TimerRing'
import { LOCALIZED_QUIZ_QUESTIONS, LOCALIZED_NUMERIC_QUESTIONS } from './data/localizedQuestions'
import {
  captureCell,
  captureOpponentCell,
  cellKey,
  createArena,
  getAttackTargets,
  getAvailableCells,
} from './game/arena'
import { botAnswerDelayMs, botNumericGuess, botQuizChoice } from './game/bots'
import { emptyScores, pickRandom, QUIZ_TIME_MS, SCORE_VALUES } from './game/engine'
import { PLAYER_BY_ID, PLAYERS } from './game/players'
import type { ArenaCell, NumericQuestion, PlayerId, QuizQuestion } from './game/types'
import { useQuestionLayout } from './hooks/useQuestionLayout'
import { useCountdown } from './hooks/useCountdown'
import { useTelegramControls } from './hooks/useTelegramControls'
import { ANIMATION_TIMINGS, useGameTimeline } from './hooks/useGameTimeline'
import { connectMultiplayerSocket, createMultiplayerRoom, joinMultiplayerRoom, type MultiplayerSocket } from './multiplayer/client'
import { getInviteRoomCode, getTelegramInviteUrl, shareTelegramInvite } from './telegram'
import type { MultiplayerGameState, MultiplayerRoomSettings } from '../shared/multiplayer'
import './styles.css'
import './parchment.css'

type Phase = 'home' | 'expansion' | 'expansion-review' | 'expansion-capture' | 'expansion-between' | 'expansion-final' | 'battle-select' | 'battle-approach' | 'battle-result' | 'battle-warmup' | 'battle-number' | 'results'
const MAX_BATTLE_ROUNDS = 9
const DUEL_BATTLE_ROUNDS = 8
const ANNOUNCEMENT_MS = 4500
const ROUND_RESULT_MS = 2000
const BOT_FALLBACK_BUFFER_MS = 500
const PLAYER_IDS: PlayerId[] = ['you', 'alex', 'marina']
type Answers = Record<PlayerId, number | null>
type RoundResult =
  | { kind: 'quiz'; question: QuizQuestion; answers: Answers; participants?: PlayerId[] }
  | { kind: 'numeric'; question: NumericQuestion; answers: Record<PlayerId, number | null>; participants?: PlayerId[] }

type PveStats = {
  games: number
  wins: number
  mcCorrect: number
  mcAnswered: number
  numericDeviationTotal: number
  numericAnswered: number
}

const STATS_STORAGE_KEY = 'strategi-quiz-pve-stats'
const HISTORY_STORAGE_KEY = 'strategi-quiz-pve-history'
const HISTORY_LIMIT = 30
const BOT_TOPICS = [...new Set([...LOCALIZED_QUIZ_QUESTIONS, ...LOCALIZED_NUMERIC_QUESTIONS].map(q => q.category ?? 'Общие знания'))].sort((a, b) => a.localeCompare(b, 'ru'))
function readBotSettings(): BotSettings {
  try { return parseBotSettings(localStorage.getItem(BOT_SETTINGS_KEY), BOT_TOPICS) } catch { return parseBotSettings(null, BOT_TOPICS) }
}

type PveHistoryPlayer = {
  id: PlayerId
  name: string
  score: number
  territories: number
  mcCorrect: number
  mcTotal: number
}

type PveHistoryEntry = {
  id: string
  finishedAt: string
  mode: 'duel' | 'trio'
  difficulty: BotSettings['difficulty']
  arenaSize: BotSettings['arenaSize']
  categories: string[]
  winnerId: PlayerId
  winnerName: string
  playerPlace: number
  rounds: {
    expansion: number
    battle: number
  }
  player: {
    score: number
    territories: number
    mcCorrect: number
    mcTotal: number
    numericAnswered: number
    averageNumericError: number | null
  }
  players: PveHistoryPlayer[]
}

type Match = {
  settings: BotSettings
  playerIds: PlayerId[]
  questions: QuizQuestion[]
  numericQuestions: NumericQuestion[]
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
  finalParticipants: PlayerId[]
  finalCellKeys: string[]
  finalCellIndex: number
  pveStats: Omit<PveStats, 'games' | 'wins'>
}

type State = { phase: Phase; match: Match | null; completedRoundResult: RoundResult | null }

type Action =
  | { type: 'finish-battle-approach' }
  | { type: 'finish-battle-result' }
  | { type: 'start'; settings: BotSettings; questions: QuizQuestion[] }
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

function readPveHistory(): PveHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isPveHistoryEntry) : []
  } catch {
    return []
  }
}

function savePveHistory(history: PveHistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)))
  } catch {
    // History is a convenience layer; stats and gameplay should keep working without storage.
  }
}

function isPveHistoryEntry(value: unknown): value is PveHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<PveHistoryEntry>
  return typeof entry.id === 'string'
    && typeof entry.finishedAt === 'string'
    && typeof entry.winnerName === 'string'
    && typeof entry.playerPlace === 'number'
    && Array.isArray(entry.players)
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

function maxBattleRoundsFor(match: Match): number {
  return match.playerIds.length === 2 ? DUEL_BATTLE_ROUNDS : MAX_BATTLE_ROUNDS
}

function allAnswered(answers: Answers, ids: PlayerId[]): boolean {
  return ids.every((id) => answers[id] !== null)
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

function playerAccuracyLabel(correct: number, total: number): string {
  return total ? `${Math.round((correct / total) * 100)}%` : '—'
}

function difficultyLabel(difficulty: BotSettings['difficulty']): string {
  return difficulty === 'easy' ? 'Легко' : difficulty === 'hard' ? 'Сложно' : 'Средне'
}

function arenaSizeLabel(size: BotSettings['arenaSize']): string {
  return `${size} сот`
}

function historyEntryFromMatch(match: Match): PveHistoryEntry {
  const players = match.playerIds.map((id) => ({
    id,
    name: PLAYER_BY_ID[id].name,
    score: match.scores[id],
    territories: match.arena.filter((cell) => cell.owner === id).length,
    mcCorrect: match.mcStats[id].correct,
    mcTotal: match.mcStats[id].total,
  })).sort((left, right) => {
    if (right.territories !== left.territories) return right.territories - left.territories
    if (right.score !== left.score) return right.score - left.score
    return right.mcCorrect - left.mcCorrect
  })
  const winner = players[0] ?? {
    id: 'you' as PlayerId,
    name: PLAYER_BY_ID.you.name,
    score: 0,
    territories: 0,
    mcCorrect: 0,
    mcTotal: 0,
  }
  const player = players.find((item) => item.id === 'you') ?? winner

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    finishedAt: new Date().toISOString(),
    mode: match.playerIds.length > 2 ? 'trio' : 'duel',
    difficulty: match.settings.difficulty,
    arenaSize: match.settings.arenaSize,
    categories: match.settings.categories.slice(0, 3),
    winnerId: winner.id,
    winnerName: winner.name,
    playerPlace: players.findIndex((item) => item.id === 'you') + 1,
    rounds: {
      expansion: match.expansionRound,
      battle: match.battleRound,
    },
    player: {
      score: player.score,
      territories: player.territories,
      mcCorrect: player.mcCorrect,
      mcTotal: player.mcTotal,
      numericAnswered: match.pveStats.numericAnswered,
      averageNumericError: match.pveStats.numericAnswered
        ? Math.round(match.pveStats.numericDeviationTotal / match.pveStats.numericAnswered)
        : null,
    },
    players,
  }
}

function nextAttacker(arena: ArenaCell[], ids: PlayerId[], startIndex = 0): PlayerId | null {
  for (let offset = 0; offset < ids.length; offset += 1) {
    const id = ids[(startIndex + offset) % ids.length]
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

function pickUnusedQuizQuestion(usedIds: string[], bank: QuizQuestion[]): QuizQuestion {
  const unused = bank.filter((question) => !usedIds.includes(question.id))
  const available = unused.length ? unused : bank
  return shuffleQuizOptions(available[randomIndex(available.length)])
}

function pickUnusedNumericQuestion(usedIds: string[], bank: NumericQuestion[]): NumericQuestion {
  const unused = bank.filter((question) => !usedIds.includes(question.id))
  const available = unused.length ? unused : bank
  return available[randomIndex(available.length)]
}

function makeMatch(settings: BotSettings, questions: QuizQuestion[]): Match {
  const playerIds = botPlayerIds(settings)
  const suppliedNumeric = LOCALIZED_NUMERIC_QUESTIONS.filter(q => settings.categories.includes(q.category))
  const derivedNumeric = numericQuestionsForTopics(questions)
  const numericQuestions = suppliedNumeric.length ? suppliedNumeric : derivedNumeric.length ? derivedNumeric : LOCALIZED_NUMERIC_QUESTIONS
  const expansionQuestion = pickUnusedQuizQuestion([], questions)
  const warmupQuestion = pickUnusedQuizQuestion([expansionQuestion.id], questions)
  const numericQuestion = numericQuestions.length ? pickUnusedNumericQuestion([], numericQuestions) : { id: 'unused', prompt: '', answer: 0 }

  return {
    settings, playerIds, questions, numericQuestions,
    scores: emptyScores(),
    mcStats: blankMcStats(),
    arena: createArena(arenaRadius(settings.arenaSize), playerIds),
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
    finalParticipants: playerIds,
    finalCellKeys: [],
    finalCellIndex: 0,
    pveStats: { mcCorrect: 0, mcAnswered: 0, numericDeviationTotal: 0, numericAnswered: 0 },
  }
}

function beginBattle(match: Match): State {
  const attacker = nextAttacker(match.arena, match.playerIds)
  if (!attacker) return { phase: 'results', match, completedRoundResult: null }
  return { phase: 'battle-select', match: { ...match, attacker, battleRound: 0 }, completedRoundResult: null }
}

function beginFinalExpansion(match: Match, participants = match.playerIds, cellKeys = match.arena.filter((cell) => !cell.owner).map((cell) => cellKey(cell.row, cell.col)), cellIndex = 0): State {
  if (!match.numericQuestions.length) return beginNextExpansion(match)
  const finalQuestion = pickUnusedNumericQuestion(match.usedNumericQuestionIds, match.numericQuestions)
  return {
    phase: 'expansion-final',
    match: {
      ...match,
      finalQuestion,
      usedNumericQuestionIds: [...match.usedNumericQuestionIds, finalQuestion.id],
      finalAnswers: blankAnswers(),
      finalAnsweredAt: blankAnswerTimes(),
      finalParticipants: participants,
      finalCellKeys: cellKeys,
      finalCellIndex: cellIndex,
    },
    completedRoundResult: null,
  }
}

function beginNextExpansion(match: Match): State {
  const expansionQuestion = pickUnusedQuizQuestion(match.usedQuizQuestionIds, match.questions)
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

  }
  const progressed = { ...match, arena, captureIndex, pendingCapture: null, lastCapturedKey }

  if (arena.every((cell) => cell.owner)) return beginBattle(progressed)
  return {
    phase: 'expansion-between',
    match: progressed,
    completedRoundResult: null,
  }
}

function resolveFinalExpansion(match: Match): State {
  const participants = match.finalParticipants.length ? match.finalParticipants : match.playerIds
  const completedRoundResult: RoundResult = { kind: 'numeric', question: match.finalQuestion, answers: match.finalAnswers, participants }
  const winner = participants
    .filter((id) => match.finalAnswers[id] !== null)
    .sort((left, right) => {
      const leftDistance = Math.abs((match.finalAnswers[left] ?? 0) - match.finalQuestion.answer)
      const rightDistance = Math.abs((match.finalAnswers[right] ?? 0) - match.finalQuestion.answer)
      if (leftDistance !== rightDistance) return leftDistance - rightDistance
      return (match.finalAnsweredAt[left] ?? Number.POSITIVE_INFINITY)
        - (match.finalAnsweredAt[right] ?? Number.POSITIVE_INFINITY)
    })[0]
  const targetKey = match.finalCellKeys[match.finalCellIndex]
  const lastCell = targetKey
    ? match.arena.find((cell) => cellKey(cell.row, cell.col) === targetKey)
    : match.arena.find((cell) => !cell.owner)
  let scores = { ...match.scores }
  for (const id of participants) {
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
  const nextCellIndex = match.finalCellIndex + 1
  const nextParticipants = participants.filter((id) => id !== winner)
  if (nextCellIndex < match.finalCellKeys.length && nextParticipants.length) {
    return {
      ...beginFinalExpansion(
        { ...match, scores, arena, lastCapturedKey: cellKey(lastCell.row, lastCell.col) },
        nextParticipants,
        match.finalCellKeys,
        nextCellIndex,
      ),
      completedRoundResult,
    }
  }
  return { ...beginBattle({ ...match, scores, arena, lastCapturedKey: cellKey(lastCell.row, lastCell.col) }), completedRoundResult }
}

function resolveExpansion(match: Match): State {
  const completedRoundResult: RoundResult = { kind: 'quiz', question: match.expansionQuestion, answers: match.expansionAnswers, participants: match.playerIds }
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
  return { phase: 'battle-result', match, completedRoundResult: null }
}

function finishBattleResult(match: Match): State {
  const nextRound = match.battleRound + 1
  const maxBattleRounds = maxBattleRoundsFor(match)
  if (nextRound >= maxBattleRounds) return { phase: 'results', match: { ...match, battleRound: nextRound }, completedRoundResult: null }
  const attacker = nextAttacker(match.arena, match.playerIds, (match.playerIds.indexOf(match.attacker) + 1) % match.playerIds.length)
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
  if (!match.numericQuestions.length) return { ...startNextBattle({ ...match, scores: addScore(scores, match.defender, SCORE_VALUES.hold) }), completedRoundResult }
  const numericQuestion = pickUnusedNumericQuestion(match.usedNumericQuestionIds, match.numericQuestions)
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
  const decision = numericDuel(attackerAnswer, defenderAnswer, match.numericQuestion.answer)
  if (decision.replay) {
    const alternatives = match.numericQuestions.filter(question => question.id !== match.numericQuestion.id)
    const pool = alternatives.length ? alternatives : LOCALIZED_NUMERIC_QUESTIONS.filter(question => question.id !== match.numericQuestion.id)
    const numericQuestion = pickUnusedNumericQuestion(match.usedNumericQuestionIds, pool.length ? pool : match.numericQuestions)
    const tieBonus = decision.attackerExact && decision.defenderExact ? SCORE_VALUES.numericExactBonus : 0
    return { phase: 'battle-number', match: { ...match, numericQuestion, numericAnswers: blankAnswers(), usedNumericQuestionIds: [...match.usedNumericQuestionIds, numericQuestion.id], scores: addScores(match.scores, { [match.attacker]: tieBonus, [match.defender]: tieBonus }) }, completedRoundResult }
  }
  let arena = match.arena
  let scores = { ...match.scores }
  if (attackerAnswer !== null && isExactNumericHit(attackerAnswer, match.numericQuestion.answer)) {
    scores = addScore(scores, match.attacker, SCORE_VALUES.numericExactBonus)
  }
  if (defenderAnswer !== null && isExactNumericHit(defenderAnswer, match.numericQuestion.answer)) {
    scores = addScore(scores, match.defender, SCORE_VALUES.numericExactBonus)
  }
  if (decision.winner === 'attacker') {
    arena = captureOpponentCell(arena, match.attacker, match.target.row, match.target.col)
    scores = addScores(scores, {
      [match.attacker]: SCORE_VALUES.numericWin + SCORE_VALUES.capture,
      [match.defender]: SCORE_VALUES.lostTerritory,
    })
  } else if (decision.winner === 'defender') {
    arena = captureOpponentCell(arena, match.defender, match.target.row, match.target.col)
    scores = addScores(scores, {
      [match.defender]: SCORE_VALUES.numericWin + SCORE_VALUES.hold,
    })
  } else {
    scores = addScore(scores, match.defender, SCORE_VALUES.hold)
  }
  return { ...startNextBattle({ ...match, scores, arena, lastCapturedKey: arena === match.arena ? null : cellKey(match.target.row, match.target.col) }), completedRoundResult }
}

export function reducer(state: State, action: Action): State {
  const match = state.match
  switch (action.type) {
    case 'start': return { phase: 'expansion', match: makeMatch(action.settings, action.questions), completedRoundResult: null }
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
      return allAnswered(next.finalAnswers, next.finalParticipants) ? resolveFinalExpansion(next) : { ...state, match: next }
    }
    case 'finish-final':
      return match && state.phase === 'expansion-final' ? resolveFinalExpansion(match) : state
    case 'select-attack': {
      if (!match || state.phase !== 'battle-select') return state
      const target = getAttackTargets(match.arena, match.attacker).find((cell) => cell.row === action.row && cell.col === action.col)
      if (!target || !target.owner) return state
      const warmupQuestion = pickUnusedQuizQuestion(match.usedQuizQuestionIds, match.questions)
      return {
        phase: 'battle-approach',
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
    case 'finish-battle-approach': return match && state.phase === 'battle-approach' ? { ...state, phase: 'battle-warmup' } : state
    case 'finish-battle-result': return match && state.phase === 'battle-result' ? finishBattleResult(match) : state
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
  useQuestionLayout()
  const [state, dispatch] = useReducer(reducer, { phase: 'home', match: null, completedRoundResult: null })
  const [menuNotice] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paused, setPaused] = useState(false)
  const [announcement, setAnnouncement] = useState(true)
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null)
  const [homeScreen, setHomeScreen] = useState<'menu' | 'stats' | 'ranked' | 'friends' | 'history' | 'bot-settings'>('menu')
  const recordedMatch = useRef(false)
  const { phase, match, completedRoundResult } = state
  const [botSettings, setBotSettings] = useState(readBotSettings)
  const updateBotSettings = (next: BotSettings) => {
    setBotSettings(next)
    try { localStorage.setItem(BOT_SETTINGS_KEY, JSON.stringify(next)) } catch { /* Settings remain usable without storage. */ }
  }
  const startMatch = () => {
    const questions = questionsForTopics(LOCALIZED_QUIZ_QUESTIONS, botSettings.categories)
    if (!questions.length) return
    updateBotSettings(botSettings)
    setSettingsOpen(false); setHomeScreen('menu'); setPaused(false); setAnnouncement(false)
    recordedMatch.current = false
    dispatch({ type: 'start', settings: { ...botSettings, categories: [...botSettings.categories] }, questions })
  }
  const openBotSettings = () => { setBotSettings(readBotSettings()); setHomeScreen('bot-settings') }

  const exitGame = () => { setSettingsOpen(false); setPaused(false); dispatch({ type: 'exit' }) }
  useTelegramControls(() => { setHomeScreen('menu'); exitGame() }, null)
  const questionPhase = phase === 'expansion' || phase === 'expansion-final' || phase === 'battle-warmup' || phase === 'battle-number'
  const expansionAllAnswered = match ? allAnswered(match.expansionAnswers, match.playerIds) : false
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
  const announcementKey = match ? `${phase}-${match.expansionRound}-${match.battleRound}-${match.target?.row ?? ''}-${match.target?.col ?? ''}-${match.usedNumericQuestionIds.length}` : 'home'
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
  const timerKey = match ? `${phase}-${match.expansionRound}-${match.battleRound}-${match.target?.row ?? ''}-${match.target?.col ?? ''}-${match.usedNumericQuestionIds.length}` : 'none'
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
      PLAYERS.filter((player) => match.playerIds.includes(player.id) && player.kind === 'bot' && match.expansionAnswers[player.id] === null)
        .forEach((player) => {
          const value = botQuizChoice(match.expansionQuestion.correctIndex, BOT_SKILL[match.settings.difficulty])
          scheduleBotAnswer(player.id, botAnswerDelayMs(BOT_SKILL[match.settings.difficulty], QUIZ_TIME_MS), value, () => dispatch({ type: 'answer-expansion', id: player.id, pick: value, answeredAt: performance.now() }))
        })
    }
    if (phase === 'expansion-final') {
      PLAYERS.filter((player) => match.finalParticipants.includes(player.id) && player.kind === 'bot' && match.finalAnswers[player.id] === null)
        .forEach((player) => {
          const value = botNumericGuess(match.finalQuestion.answer, BOT_SKILL[match.settings.difficulty])
          scheduleBotAnswer(player.id, botAnswerDelayMs(BOT_SKILL[match.settings.difficulty], QUIZ_TIME_MS), value, () => dispatch({ type: 'answer-final', id: player.id, value, answeredAt: performance.now() }))
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
          const value = botQuizChoice(match.warmupQuestion.correctIndex, BOT_SKILL[match.settings.difficulty])
          scheduleBotAnswer(id, botAnswerDelayMs(BOT_SKILL[match.settings.difficulty], QUIZ_TIME_MS), value, () => dispatch({ type: 'answer-warmup', id, pick: value }))
        })
    }
    if (phase === 'battle-number' && match.defender) {
      [match.attacker, match.defender]
        .filter((id) => match.numericAnswers[id] === null && PLAYER_BY_ID[id].kind === 'bot')
        .forEach((id) => {
          const value = botNumericGuess(match.numericQuestion.answer, BOT_SKILL[match.settings.difficulty])
          scheduleBotAnswer(id, botAnswerDelayMs(BOT_SKILL[match.settings.difficulty], QUIZ_TIME_MS), value, () => dispatch({ type: 'answer-number', id, value }))
        })
    }
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [phase, paused, announcement, roundResult, timeline.questionAcceptsAnswers, match?.expansionRound, match?.battleRound, match?.target?.row, match?.target?.col, match?.numericQuestion.id, match?.usedNumericQuestionIds.length])

  useEffect(() => {
    if (paused || !['battle-approach', 'battle-result'].includes(phase)) return
    const id = window.setTimeout(() => dispatch({ type: phase === 'battle-approach' ? 'finish-battle-approach' : 'finish-battle-result' }), phase === 'battle-approach' ? 1000 : ROUND_RESULT_MS + 2500)
    return () => window.clearTimeout(id)
  }, [phase, paused])

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
  const finalHumanLocked = !match?.finalParticipants.includes('you') || match?.finalAnswers.you !== null

  useEffect(() => {
    if (phase !== 'results' || !match || recordedMatch.current) return
    const territory = match.playerIds.map((id) => ({ id, count: match.arena.filter((cell) => cell.owner === id).length }))
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
    savePveHistory([historyEntryFromMatch(match), ...readPveHistory()])
    recordedMatch.current = true
  }, [phase, match])

  return <div className={`arena ${phase === 'home' ? '' : `game-shell game-phase-${phase}`}`}>
    {phase !== 'home' ? <header className="topbar">
      <div><p className="kicker">Арена</p><h1>Ближе всех</h1></div>
      {match ? <div className="topbar-tools"><TurnIndicator playerIds={match.playerIds} activePlayer={activeTurn} /><PhaseBadge phase={phase} match={match} /><PlayerDock playerIds={match.playerIds} scores={match.scores} highlight={activeTurn} badges={{ [match.attacker]: phase.startsWith('battle') ? 'атакует' : undefined }} /><div className={`settings-menu${settingsOpen ? ' is-open' : ''}`}><button type="button" className="settings-button" aria-label="Настройки" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><span aria-hidden="true">⚙</span></button>{settingsOpen ? <div className="settings-popover"><button type="button" className="pause-button" onClick={togglePause}>{paused ? 'Продолжить' : 'Приостановить игру'}</button><button type="button" className="exit-button" onClick={exitGame}>Выйти из игры</button></div> : null}</div></div> : null}
    </header> : null}
    <main className="stage">
      {phase === 'home' && homeScreen === 'stats' ? <StatsScreen stats={readPveStats()} onBack={() => setHomeScreen('menu')} onHistory={() => setHomeScreen('history')} /> : null}
      {phase === 'home' && homeScreen === 'ranked' ? <RankedScreen onBack={() => setHomeScreen('menu')} /> : null}
      {phase === 'home' && homeScreen === 'friends' ? <FriendsScreen onBack={() => setHomeScreen('menu')} /> : null}
      {phase === 'home' && homeScreen === 'history' ? <HistoryScreen entries={readPveHistory()} onBack={() => setHomeScreen('stats')} /> : null}
      {phase === 'home' && homeScreen === 'bot-settings' ? <BotGameSettings settings={botSettings} topics={BOT_TOPICS.map(name => ({ name, count: [...LOCALIZED_QUIZ_QUESTIONS, ...LOCALIZED_NUMERIC_QUESTIONS].filter(q => (q.category ?? 'Общие знания') === name).length }))} onChange={updateBotSettings} onStart={startMatch} onBack={() => setHomeScreen('menu')} /> : null}
      {phase === 'home' && homeScreen === 'menu' ? <MenuScreen notice={menuNotice} onStart={openBotSettings} onStats={() => setHomeScreen('stats')} onRanked={() => setHomeScreen('ranked')} onFriends={() => setHomeScreen('friends')} /> : null}
      <AnimatePresence mode="wait">
        {match && !(phase === 'battle-result' && roundResult) && (timeline.mapVisible || (phase !== 'home' && phase !== 'results' && phase !== 'expansion' && !questionPhase)) ? <motion.div key="map" className={`map-stage ${timeline.mapReturning ? 'is-returning' : ''}`} initial={{ opacity: 0.5, y: 10, filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -10, filter: 'blur(10px)' }} transition={{ duration: Math.max(ANIMATION_TIMINGS.minTransition, timeline.mapReturning ? ANIMATION_TIMINGS.mapReturn : ANIMATION_TIMINGS.minTransition) / 1000 }}><MapActionBanner phase={phase} match={match} />{phase.startsWith('battle-') ? <BotBattleMap match={match} phase={phase} onChoose={(row, col) => dispatch({ type: 'select-attack', row, col })} /> : <ArenaGrid cells={match.arena} activePlayer={phase === 'expansion-capture' && match.pendingCapture === 'you' ? 'you' : null} selectableKeys={battleTargetKeys} lastCapturedKey={match.lastCapturedKey} onCapture={(row, col) => phase === 'battle-select' ? dispatch({ type: 'select-attack', row, col }) : dispatch({ type: 'capture-expansion', row, col })} />}</motion.div> : null}
        {((phase === 'expansion' && timeline.questionVisible) || (questionPhase && phase !== 'expansion' && !announcement)) ? <motion.div key="question" className={`question-stage ${timeline.inputExiting ? 'is-exiting' : ''}`} initial={{ opacity: 0, y: 50 }} animate={{ opacity: timeline.inputExiting ? 0 : 1, y: timeline.inputExiting ? -12 : 0 }} exit={{ opacity: 0, y: -18 }} transition={{ duration: (timeline.inputExiting ? ANIMATION_TIMINGS.inputExit : ANIMATION_TIMINGS.questionEnter) / 1000 }}>
          {phase === 'expansion' && match ? <>{expansionQueuePosition >= 0 ? <p className="queue-status">Ты в очереди захвата: {expansionQueuePosition + 1}-й</p> : null}{humanQuestion(match.expansionQuestion, match.expansionAnswers, 'expansion')}{match.expansionAnswers.you !== null && !expansionAllAnswered ? <p className="timeline-status">Ожидание соперников...</p> : null}</> : null}
          {phase === 'expansion-final' && match ? match.finalParticipants.includes('you') ? <FinalRoundPanel match={match} remainingMs={remainingMs} locked={finalHumanLocked || paused} onAnswer={(value) => dispatch({ type: 'answer-final', id: 'you', value, answeredAt: performance.now() })} /> : <BotWaiting remainingMs={remainingMs} /> : null}
          {phase === 'battle-warmup' && match && match.defender ? <><section className="panel battle-step battle-event" style={{ ['--attacker' as string]: PLAYER_BY_ID[match.attacker].accent, ['--defender' as string]: PLAYER_BY_ID[match.defender].accent }}><p className="kicker">Битва · шаг 1 из 2 · Разминка</p><h2>{PLAYER_BY_ID[match.attacker].name} атакует границу</h2><p className="hint">Защитник: {PLAYER_BY_ID[match.defender].name}. Первый вопрос решает, будет ли числовая дуэль.</p></section>{match.attacker === 'you' || match.defender === 'you' ? humanQuestion(match.warmupQuestion, match.warmupAnswers, 'warmup') : <BotWaiting remainingMs={remainingMs} />}</> : null}
          {phase === 'battle-number' && match && match.defender ? <><section className="panel battle-step battle-event" style={{ ['--attacker' as string]: PLAYER_BY_ID[match.attacker].accent, ['--defender' as string]: PLAYER_BY_ID[match.defender].accent }}><p className="kicker">Битва · шаг 2 из 2 · Числовая дуэль</p><h2>{PLAYER_BY_ID[match.attacker].name} и {PLAYER_BY_ID[match.defender].name}: спор за соту</h2><p className="hint">Ближайшее число решает судьбу территории.</p></section>{match.attacker === 'you' || match.defender === 'you' ? <NumberDuel key={match.usedNumericQuestionIds.length} match={match} remainingMs={remainingMs} paused={paused} onAnswer={(value) => dispatch({ type: 'answer-number', id: 'you', value })} /> : <BotWaiting remainingMs={remainingMs} />}</> : null}
        </motion.div> : null}
      </AnimatePresence>
      {phase === 'expansion' && (timeline.step === 'announcing' || timeline.step === 'pre-timer') ? <TimelineOverlay><RoundAnnouncement phase={phase} match={match} /></TimelineOverlay> : null}
      {announcement && questionPhase && phase !== 'expansion' ? <RoundAnnouncement phase={phase} match={match} /> : null}
      {paused ? <PauseOverlay onResume={togglePause} /> : null}
      {timeline.resultVisible && completedRoundResult?.kind === 'quiz' ? <RoundResultOverlay result={completedRoundResult} humanCorrect={match?.expansionAnswers.you === completedRoundResult.question.correctIndex} /> : null}
      {roundResult ? <RoundResultOverlay result={roundResult} /> : null}
      {phase === 'expansion-between' ? <section className="panel transition-panel"><p className="kicker">Переход</p><h2>Следующий раунд скоро начнется</h2><PauseProgress progress={timeline.progress} /><div className="transition-dots" aria-hidden="true"><i /><i /><i /></div></section> : null}
      {phase === 'battle-select' && match && match.attacker === 'you' ? <p className="map-instruction">Выбери подсвеченную вражескую соту на карте</p> : null}
      {phase === 'results' && match ? <FinalResultsScreen players={match.playerIds.map((playerId) => ({
        playerId,
        name: PLAYER_BY_ID[playerId].name,
        color: PLAYER_BY_ID[playerId].accent,
        totalScore: match.scores[playerId],
        mcCorrect: match.mcStats[playerId].correct,
        mcTotal: match.mcStats[playerId].total,
        hexCount: match.arena.filter((cell) => cell.owner === playerId).length,
      }))} onMenu={exitGame} /> : null}
    </main>
    <footer className="cartographic-footer" aria-hidden="true"><span>Знания объединяют</span></footer>
  </div>
}

function MapActionBanner({ phase, match }: { phase: Phase; match: Match }) {
  if (phase === 'expansion-capture' && match.pendingCapture) {
    const player = PLAYER_BY_ID[match.pendingCapture]
    const pendingPlayerHasTerritory = match.arena.some((cell) => cell.owner === match.pendingCapture)
    return <div className="map-action-banner" style={{ ['--accent' as string]: player.accent }}>
      <span>{player.name.slice(0, 1)}</span>
      <div><strong>{match.pendingCapture === 'you' ? 'Твой захват' : `${player.name} выбирает соту`}</strong><small>{match.pendingCapture === 'you' ? pendingPlayerHasTerritory ? 'Выбери подсвеченную соседнюю территорию' : 'Поставь первую соту в любом месте карты' : pendingPlayerHasTerritory ? 'Граница карты меняется прямо сейчас' : 'Игрок ставит первую соту на пустой карте'}</small></div>
    </div>
  }
  if (phase === 'battle-select') {
    const player = PLAYER_BY_ID[match.attacker]
    return <div className="map-action-banner is-battle" style={{ ['--accent' as string]: player.accent }}>
      <span>⚔</span>
      <div><strong>{match.attacker === 'you' ? 'Выбери цель атаки' : `${player.name} готовит атаку`}</strong><small>Доступные вражеские соты подсвечены на карте</small></div>
    </div>
  }
  if (phase === 'expansion-final') {
    return <div className="map-action-banner is-final">
      <span>?</span>
      <div><strong>Спор за последние земли</strong><small>Каждая оставшаяся сота решается числовым раундом</small></div>
    </div>
  }
  return null
}

function PhaseBadge({ phase, match }: { phase: Phase; match: Match }) {
  const battle = phase.startsWith('battle') || phase === 'results'
  const maxBattleRounds = maxBattleRoundsFor(match)
  return <div className="phase-badge"><strong>{battle ? 'Битва' : 'Завоевание'}</strong><small>{battle ? `Раунд ${Math.min(match.battleRound + 1, maxBattleRounds)} / ${maxBattleRounds}` : `Раунд ${match.expansionRound}`}</small></div>
}

function RoundAnnouncement({ phase, match }: { phase: Phase; match: Match | null }) {
  const battle = phase.startsWith('battle')
  const numeric = phase === 'expansion-final' || phase === 'battle-number'
  const maxBattleRounds = match ? maxBattleRoundsFor(match) : MAX_BATTLE_ROUNDS
  return <motion.section className="round-announcement" initial={{ opacity: 0, scale: 0.8, y: 18 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: -12 }} transition={{ duration: ANIMATION_TIMINGS.announcementScale / 1000 }}>
    <p className="kicker">Новый раунд</p>
    <h2>{battle ? `Раунд ${Math.min((match?.battleRound ?? 0) + 1, maxBattleRounds)} из ${maxBattleRounds}` : `Раунд ${match?.expansionRound ?? 1}`}</h2>
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

function playersForOption(answers: Answers, optionIndex: number, participants = PLAYER_IDS): PlayerId[] {
  return participants.filter((id) => {
    const answer = answers[id]
    return Number.isInteger(answer) && answer === optionIndex && Boolean(PLAYER_BY_ID[id]?.accent)
  })
}

function RoundResultOverlay({ result, humanCorrect = null }: { result: RoundResult; humanCorrect?: boolean | null }) {
  if (result.kind === 'quiz') {
    const correctIndex = result.question.correctIndex
    return <motion.div className="round-result-overlay" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -18 }} transition={{ duration: ANIMATION_TIMINGS.resultReveal / 1000 }}><section className="round-result-card"><p className="kicker">Результаты викторины · {result.question.category ?? 'Общие знания'}</p><h2 className="question-text">{result.question.prompt}</h2><div className="result-options">{result.question.options.map((option, index) => { const players = playersForOption(result.answers, index, result.participants); return <motion.div key={option} className={`result-option ${index === correctIndex ? 'is-correct is-gold-correct' : ''}`} style={{ background: answerBackground(players) }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: ANIMATION_TIMINGS.minTransition / 1000, delay: index * 0.04 }}><strong>{['А', 'Б', 'В', 'Г'][index]}</strong><span>{option}</span></motion.div> })}</div>{humanCorrect !== null ? <motion.p className={`answer-verdict ${humanCorrect ? 'is-correct' : 'is-wrong'}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: ANIMATION_TIMINGS.minTransition / 1000 }}> {humanCorrect ? 'Правильно!' : 'Неправильно'} </motion.p> : null}</section></motion.div>
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

function TurnIndicator({ activePlayer, playerIds }: { activePlayer: PlayerId | null; playerIds: PlayerId[] }) {
  return <div className="turn-indicator" aria-label={activePlayer ? `Ход: ${PLAYER_BY_ID[activePlayer].name}` : 'Ход не выбран'}>
    <svg viewBox="0 0 40 40" role="img" aria-hidden="true">
      {playerIds.map((id, index) => <circle key={id} cx={playerIds.length === 2 ? 12 + index * 16 : 8 + index * 12} cy="20" r={activePlayer === id ? 7 : 5} fill={PLAYER_BY_ID[id].accent} opacity={activePlayer === id ? 1 : 0.4} />)}
    </svg>
    <span>{activePlayer ? PLAYER_BY_ID[activePlayer].name : 'Ожидание'}</span>
  </div>
}

function QuestionPanel({ question, remainingMs, locked, selected, result, onChoose }: { question: QuizQuestion; remainingMs: number; locked: boolean; selected: number | null; result: boolean | null; onChoose: (pick: number) => void }) {
  return <section className="panel question-card"><p className="kicker">Общий вопрос · {question.category ?? 'Общие знания'}</p><h2 className="question-text">{question.prompt}</h2><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><div className="options">{question.options.map((option, index) => <motion.button key={option} type="button" className={`option ${selected === index ? 'is-selected' : ''}`} style={{ ['--answer-color' as string]: PLAYER_BY_ID.you.accent }} disabled={locked} whileTap={{ scale: 0.95 }} transition={{ duration: ANIMATION_TIMINGS.answerPress / 1000 }} onClick={() => onChoose(index)}><span className="opt-key">{['А', 'Б', 'В', 'Г'][index]}</span>{option}</motion.button>)}</div>{result !== null ? <p className={`answer-verdict ${result ? 'is-correct' : 'is-wrong'}`}>{result ? 'Правильно!' : 'Неправильно'}</p> : null}<p className="hint">{locked ? 'Ответ принят. Ждём остальных игроков.' : `На ответ есть ${Math.round(QUIZ_TIME_MS / 1000)} секунд.`}</p></section>
}

function NumberDuel({ match, remainingMs, paused, onAnswer }: { match: Match; remainingMs: number; paused: boolean; onAnswer: (value: number | null) => void }) {
  const [value, setValue] = useState('')
  const [locked, setLocked] = useState(false)
  return <section className="panel question-card"><p className="kicker">Числовая дуэль · {match.numericQuestion.category ?? 'Общие знания'}</p><h2 className="question-text">{match.numericQuestion.prompt}</h2><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><form className="guess-form" onSubmit={(event) => { event.preventDefault(); const parsed = Number(value.replace(',', '.')); if (locked || paused || remainingMs <= 0 || !value.trim() || !Number.isFinite(parsed)) return; setLocked(true); onAnswer(parsed) }}><input value={value} onChange={(event) => setValue(event.target.value)} disabled={locked || paused} inputMode="decimal" placeholder="Твоё число" aria-label="Числовой ответ" /><button type="submit" disabled={locked || paused || !value.trim() || remainingMs <= 0}>{locked ? 'Принято' : 'Ответить'}</button></form><p className="hint">Сравнивается только абсолютное отклонение, без бонуса за скорость.</p></section>
}

function FinalRoundPanel({ match, remainingMs, locked, onAnswer }: { match: Match; remainingMs: number; locked: boolean; onAnswer: (value: number | null) => void }) {
  const [value, setValue] = useState('')
  const totalCells = match.finalCellKeys.length || 1
  return <section className="panel question-card final-round-panel"><p className="kicker">Финальная сота {match.finalCellIndex + 1} из {totalCells} · {match.finalQuestion.category ?? 'Общие знания'}</p><h2 className="question-text">{match.finalQuestion.prompt}</h2><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><form className="guess-form" onSubmit={(event) => { event.preventDefault(); const parsed = Number(value.replace(',', '.')); if (!Number.isFinite(parsed)) return; onAnswer(parsed) }}><input value={value} onChange={(event) => setValue(event.target.value)} disabled={locked} inputMode="decimal" placeholder="Твоё число" aria-label="Ответ финального раунда" /><button type="submit" disabled={locked}>{locked ? 'Принято' : 'Ответить'}</button></form><p className="hint">Побеждает ближайший ответ. Победитель этой соты уступает место другим претендентам в следующем финальном раунде.</p></section>
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
  return <motion.section className="final-results-screen" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
    <ConfettiBurst />
    <p className="results-kicker">Матч завершён</p>
    <h2>РЕЗУЛЬТАТЫ МАТЧА</h2>
    <p className="results-subtitle">Итоговый счёт, точность и контроль территории</p>
    <div className="winner-podium">
      {ordered.map((player, index) => {
        const accuracy = mcAccuracy(player)
        const reason = tieReason(player, ordered[index - 1])
        return <motion.article key={player.playerId} className={`podium-card place-${index + 1}`} style={{ ['--accent' as string]: player.color }} initial={{ opacity: 0, y: 30, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5, delay: index * 0.2 }}>
          <div className="podium-rank" aria-label={`${index + 1} место`}><span>{String(index + 1).padStart(2, '0')}</span><small>МЕСТО</small></div>
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
  const winRate = stats.games ? Math.round((stats.wins / stats.games) * 100) : 0
  return <section className="stats-screen">
    <button type="button" className="stats-back" onClick={onBack}>← Главное меню</button>
    <header className="stats-title"><p className="menu-eyebrow">Летопись сражений</p><h2>МОЯ СТАТИСТИКА</h2><div className="title-rule" aria-hidden="true"><i /><b /><i /></div><button type="button" className="wood-plaque stats-history-button plaque-light" onClick={onHistory}>ИСТОРИЯ ИГР</button></header>
    <section className="stats-hero">
      <div><p className="stats-block-kicker">Текущая кампания PvE</p><strong>{stats.games}</strong><span>сыграно партий</span></div>
      <div><strong>{stats.wins}</strong><span>побед</span></div>
      <div><strong>{winRate}%</strong><span>винрейт</span></div>
      <div><strong>{mcAccuracy === null ? '—' : `${mcAccuracy}%`}</strong><span>точность</span></div>
    </section>
    <div className="stats-dashboard">
      <section className="stats-block stats-pve"><p className="stats-block-kicker">Активный режим · Игра с ботами</p><div className="stats-columns"><StatsColumn title="Дуэль · 1 бот" rows={[['Игр', String(stats.games)], ['Побед', String(stats.wins)], ['% правильных MC', mcAccuracy === null ? '0%' : `${mcAccuracy}%`]]} /><StatsColumn title="Троица · 2 бота" rows={[['1-е места', String(stats.wins)], ['Всего игр', String(stats.games)], ['Точность числовых', numericAccuracy === null ? '—' : `${numericAccuracy}%`]]} /></div></section>
      <section className="stats-block stats-pvp"><p className="stats-block-kicker">Раздел · Рейтинговые игры</p><div className="stats-columns"><StatsColumn title="Дуэль · 1v1" rows={[['Побед', '0'], ['Поражений', '0'], ['% правильных MC', '0%']]} /><StatsColumn title="Троица · 1v1v1" rows={[['1-е места', '0'], ['2-е места', '0'], ['3-е места', '0'], ['% правильных MC', '0%']]} /></div><p className="stats-empty-note">Рейтинговый режим пока не подключён</p></section>
      <section className="stats-block stats-friends"><p className="stats-block-kicker">Раздел · Игра с друзьями</p><div className="stats-columns"><StatsColumn title="Дуэль · 1v1" rows={[['Побед', '0'], ['Поражений', '0'], ['% правильных MC', '0%']]} /><StatsColumn title="Троица · 1v1v1" rows={[['1-е места', '0'], ['2-е места', '0'], ['3-е места', '0'], ['% правильных MC', '0%']]} /></div><p className="stats-empty-note">Статистика игр с друзьями появится после первых завершённых матчей</p></section>
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

function BotBattleMap({ match, phase, onChoose }: { match: Match; phase: Phase; onChoose: (row: number, col: number) => void }) {
  const captured = match.target && match.arena.find(cell => cell.row === match.target!.row && cell.col === match.target!.col)?.owner === match.attacker
  return <>
    <OnlineArenaGrid viewerPlayerId="you" onChoose={onChoose} state={{
      phase: phase === 'battle-approach' ? 'battle-approach' : phase === 'battle-result' ? 'battle-result' : 'battle-select',
      battleRound: match.battleRound,
      arena: match.arena.map(cell => ({ row: cell.row, col: cell.col, ownerId: cell.owner })),
      players: match.playerIds.map(id => ({ id, name: PLAYER_BY_ID[id].name, color: PLAYER_BY_ID[id].accent, telegramId: null, status: 'connected', socketId: null, joinedAt: 0, disconnectedAt: null })),
      availableHexes: phase === 'battle-select' ? getAttackTargets(match.arena, match.attacker).map(cell => cellKey(cell.row, cell.col)) : [],
      activePlayerId: match.attacker,
      selectedAttack: match.target ? { row: match.target.row, col: match.target.col, ownerId: match.defender } : null,
      roundResult: phase === 'battle-result' ? { correctPlayerIds: [], exactBonusPlayerIds: [], battleWinnerId: captured ? match.attacker : match.defender ?? undefined } : null,
    }} />
    {phase === 'battle-result' ? <p className="map-instruction">{captured ? `${PLAYER_BY_ID[match.attacker].name} захватывает соту!` : 'Атака отбита — территория остаётся защитнику'}</p> : null}
  </>
}

function FriendsScreen({ onBack }: { onBack: () => void }) {
  const [roomCode, setRoomCode] = useState(() => getInviteRoomCode())
  const [state, setState] = useState<MultiplayerGameState | null>(null)
  const [viewerPlayerId, setViewerPlayerId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [socket, setSocket] = useState<MultiplayerSocket | null>(null)
  const currentRoomCode = state?.roomCode ?? null
  const isHost = Boolean(state && viewerPlayerId && state.hostPlayerId === viewerPlayerId)
  const humanPlayers = state?.players.filter((player) => !player.botReplacementFor) ?? []
  const canStart = Boolean(isHost && state?.status === 'waiting' && humanPlayers.length >= 2)
  const categoryOptions = BOT_TOPICS
  useTelegramControls(onBack, currentRoomCode)

  useEffect(() => {
    if (!currentRoomCode) return
    const socket = connectMultiplayerSocket(currentRoomCode, setState, setNotice, setViewerPlayerId)
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
      setViewerPlayerId(response.playerId)
      setRoomCode(response.roomCode)
      setNotice(`Комната ${response.roomCode} создана. Настрой матч и отправь код друзьям.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось создать комнату')
    }
  }

  const joinRoom = async () => {
    try {
      const response = await joinMultiplayerRoom(roomCode)
      setState(response.state)
      setViewerPlayerId(response.playerId)
      setNotice(`Ты вошёл в комнату ${response.state.roomCode}. Ждём создателя.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось войти в комнату')
    }
  }

  const updateSettings = (settings: MultiplayerRoomSettings) => {
    if (!socket || !state || !isHost) return
    socket.emit('room_settings_updated', { roomId: state.roomId, settings }, (response) => {
      setNotice(response.ok ? 'Настройки комнаты обновлены' : response.error)
    })
  }

  const patchSettings = (patch: Partial<MultiplayerRoomSettings>) => {
    if (!state) return
    updateSettings({ ...state.settings, ...patch })
  }

  const toggleCategory = (category: string) => {
    if (!state) return
    const selected = new Set(state.settings.categories)
    if (selected.has(category)) selected.delete(category)
    else selected.add(category)
    patchSettings({ categories: [...selected] })
  }

  const startGame = () => {
    if (!socket || !state) return
    socket.emit('game_started', { roomId: state.roomId }, (response) => {
      setNotice(response.ok ? 'Матч запущен' : response.error)
    })
  }

  return <section className="ranked-screen friends-screen">
    <button type="button" className="stats-back" onClick={onBack}>← Главное меню</button>
    <header className="stats-title"><p className="menu-eyebrow">Сражение за одним столом</p><h2>ИГРА С ДРУЗЬЯМИ</h2><div className="title-rule" aria-hidden="true"><i /><b /><i /></div></header>
    {!state ? <div className="friends-room-card">
      <p className="stats-block-kicker">Комната по коду</p>
      <button type="button" className="wood-plaque plaque-red friends-create" onClick={createRoom}><span>Создать комнату</span><small>Настройки и старт будут только у создателя</small></button>
      <label className="room-code-field">
        <span>Код комнаты</span>
        <input value={roomCode} onChange={(event) => setRoomCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" placeholder="000000" />
      </label>
      <button type="button" className="wood-plaque plaque-light friends-join" disabled={roomCode.length !== 6} onClick={joinRoom}><span>Войти по коду</span><small>{roomCode.length === 6 ? 'Подключиться к партии' : 'Введите 6 цифр'}</small></button>
      {currentRoomCode ? <button type="button" className="wood-plaque plaque-light friends-invite" onClick={() => { shareTelegramInvite(currentRoomCode); setNotice(`Ссылка-приглашение готова: ${getTelegramInviteUrl(currentRoomCode)}`) }}><span>Пригласить друга</span><small>Через Telegram</small></button> : null}
    </div> : null}
    {state?.status === 'waiting' ? <div className="online-room-panel friends-lobby-panel">
      <p className="menu-eyebrow">Комната {state.roomCode}</p>
      <button type="button" className="friends-share" onClick={() => shareTelegramInvite(state.roomCode)}>Пригласить друга ↗</button>
      <h3>{isHost ? 'Ты создатель комнаты' : 'Ждём создателя комнаты'}</h3>
      <div className="online-player-list">
        {humanPlayers.map((player) => <span key={player.id} className={player.id === state.hostPlayerId ? 'is-host' : ''} style={{ borderColor: player.color, color: player.color }}>{player.name}{player.id === state.hostPlayerId ? ' · создатель' : ''} · {player.status === 'connected' ? 'в комнате' : 'нет связи'}</span>)}
      </div>
      {state.status === 'waiting' ? <div className="friends-settings-panel">
        <div className="friends-settings-summary">
          <span>{state.settings.maxPlayers === 2 ? 'Дуэль' : 'Трое игроков'}</span>
          <span>{state.settings.arenaRadius === 1 ? '7 сот' : state.settings.arenaRadius === 3 ? '37 сот' : '19 сот'}</span>
          <span>{state.settings.categories.length ? `${state.settings.categories.length} тем` : 'Все темы'}</span>
        </div>
        {isHost ? <>
          <div className="friends-setting-row">
            <p>Формат</p>
            <button type="button" className={state.settings.maxPlayers === 2 ? 'is-selected' : ''} onClick={() => patchSettings({ maxPlayers: 2 })}>1 на 1</button>
            <button type="button" className={state.settings.maxPlayers === 3 ? 'is-selected' : ''} onClick={() => patchSettings({ maxPlayers: 3 })}>Трое</button>
          </div>
          <div className="friends-setting-row">
            <p>Карта</p>
            <button type="button" className={state.settings.arenaRadius === 1 ? 'is-selected' : ''} onClick={() => patchSettings({ arenaRadius: 1 })}>Быстрая · 7 сот</button>
            <button type="button" className={state.settings.arenaRadius === 2 ? 'is-selected' : ''} onClick={() => patchSettings({ arenaRadius: 2 })}>Классика · 19 сот</button>
            <button type="button" className={state.settings.arenaRadius === 3 ? 'is-selected' : ''} onClick={() => patchSettings({ arenaRadius: 3 })}>Большая · 37 сот</button>
          </div>
          <details className="friends-topics"><summary>Темы вопросов · {state.settings.categories.length || 'все'}</summary><div className="friends-category-grid" aria-label="Темы комнаты">
            {categoryOptions.map((category) => <button key={category} type="button" className={state.settings.categories.includes(category) ? 'is-selected' : ''} onClick={() => toggleCategory(category)}>{category}</button>)}
          </div></details>
          <button type="button" className="wood-plaque plaque-red friends-start" disabled={!canStart} onClick={startGame}><span>Начать игру</span><small>{canStart ? 'Все готовы — открываем первый вопрос' : 'Нужно минимум два игрока'}</small></button>
        </> : <p className="friends-wait-note">Настройки выбирает создатель. Когда он нажмёт старт, матч начнётся у всех игроков одновременно.</p>}
      </div> : null}
    </div> : null}
    {state && (state.status === 'playing' || state.status === 'finished') ? <OnlineGameView state={state} socket={socket} viewerPlayerId={viewerPlayerId} /> : null}
    {notice && state?.status !== 'playing' ? <p className="ranked-notice">{notice}</p> : null}
  </section>
}

function useServerRemainingMs(timerEndsAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!timerEndsAt) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [timerEndsAt])
  return timerEndsAt ? Math.max(0, timerEndsAt - now) : 0
}

function OnlineGameView({ state, socket, viewerPlayerId }: { state: MultiplayerGameState; socket: MultiplayerSocket | null; viewerPlayerId: string | null }) {
  const remainingMs = useServerRemainingMs(state.timerEndsAt)
  const active = state.players.find((player) => player.id === state.activePlayerId)
  const [notice, setNotice] = useState('')
  const questionKey = `${state.round}:${state.battleRound}:${state.currentQuestion?.id}`
  const pending = useRef<string | null>(null)
  const [submitted, setSubmitted] = useState<string | null>(null)
  const isParticipant = Boolean(viewerPlayerId && (state.phase === 'expansion' || (['battle-number', 'battle-warmup'].includes(state.phase) && [state.activePlayerId, state.selectedAttack?.ownerId].includes(viewerPlayerId))))
  const answered = submitted === questionKey || Boolean(viewerPlayerId && state.answerTimes[viewerPlayerId] !== undefined)
  const canAnswer = isParticipant && !answered && remainingMs > 0
  const sendAnswer = (answer: number) => {
    if (!socket?.connected || !canAnswer || pending.current === questionKey) return
    pending.current = questionKey
    setSubmitted(questionKey)
    socket.emit('answer_submitted', { roomId: state.roomId, answer }, (response) => {
      if (!response.ok) { pending.current = null; setSubmitted(null) }
      setNotice(response.ok ? '' : response.error)
    })
  }
  const chooseHex = (row: number, col: number) => {
    const event = state.phase === 'battle-select' ? 'attack_chosen' : 'hex_selected'
    socket?.emit(event, { roomId: state.roomId, row, col }, (response) => {
      setNotice(response.ok ? '' : response.error)
    })
  }

  return <motion.section className="online-game-view" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
    <div className="online-topline">
      <strong>{state.phase.startsWith('battle-') && state.phase !== 'battle-number' ? 'Битва' : state.phase === 'battle-number' ? 'Числовая дуэль' : 'Завоевание'}</strong>
      <span>{active ? `Ход: ${active.name}` : state.phase === 'expansion' ? `Раунд ${state.round} · отвечают все` : state.phase === 'results' ? 'Матч завершён' : 'Итоги вопроса'}</span>
    </div>
    <div className="online-score-row">
      {state.players.filter((player) => !player.botReplacementFor).map((player) => <article key={player.id} className={state.activePlayerId === player.id ? 'is-active' : ''} style={{ ['--accent' as string]: player.color }}>
        <b>{player.name}</b>
        <span>{state.scores[player.id] ?? 0}</span>
      </article>)}
    </div>
    <OnlineArenaGrid state={state} viewerPlayerId={viewerPlayerId} onChoose={chooseHex} />
    {state.currentQuestion && state.currentQuestion.type !== 'numeric' && ['expansion', 'battle-warmup'].includes(state.phase) ? <section className="panel online-question-panel">
      <p className="kicker">{state.phase === 'battle-warmup' ? 'Битва · выбор ответа' : 'Онлайн · общий вопрос'} · {state.currentQuestion.category}</p>
      <h2>{state.currentQuestion.prompt}</h2>
      <TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} />
      <div className="options">
        {state.currentQuestion.options.map((option, index) => <motion.button key={`${option}-${index}`} type="button" className="option" disabled={!canAnswer} style={{ ['--answer-color' as string]: active?.color ?? '#b55239' }} whileTap={{ scale: 0.95 }} onClick={() => sendAnswer(index)}>
          <span className="opt-key">{['А', 'Б', 'В', 'Г'][index]}</span>{option}
        </motion.button>)}
      </div>
      <p className="hint">{!isParticipant ? 'Отвечают нападающий и защитник. Ты наблюдаешь за дуэлью.' : answered ? 'Ответ принят. Ждём остальных игроков.' : 'Выбери один ответ. Изменить его после отправки нельзя.'}</p>
    </section> : null}
    {state.currentQuestion?.type === 'numeric' && state.phase === 'battle-number' ? <OnlineNumberPanel key={questionKey} disabled={!canAnswer} state={state} remainingMs={remainingMs} onAnswer={(answer) => sendAnswer(answer)} /> : null}
    {['expansion-review', 'battle-review'].includes(state.phase) && state.roundResult ? <OnlineRoundResults state={state} /> : null}
    {state.phase === 'battle-approach' ? <p className="map-instruction">{active?.name} отправляется в атаку</p> : null}
    {state.phase === 'battle-result' ? <p className="map-instruction">{state.roundResult?.battleWinnerId === state.activePlayerId ? `${active?.name} захватывает соту!` : 'Атака отбита — территория остаётся защитнику'}</p> : null}
    {state.phase === 'expansion-between' ? <p className="map-instruction">Территории заняты · следующий этап через 2 секунды</p> : null}
    {state.phase === 'expansion-capture' ? <p className="map-instruction">{active ? `${active.name} выбирает территорию` : 'Ожидание хода'}</p> : null}
    {state.phase === 'battle-select' ? <p className="map-instruction">{active ? `${active.name} выбирает цель атаки` : 'Ожидание атаки'}</p> : null}
    {notice ? <p className="online-action-notice">{notice}</p> : null}
    {state.phase === 'results' ? <OnlineFinalResults state={state} /> : null}
  </motion.section>
}

function OnlineRoundResults({ state }: { state: MultiplayerGameState }) {
  const correctOption = state.roundResult?.correctOption
  return <motion.section className="panel online-question-panel" initial={{ opacity: 0, y: 30, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5 }}>
    <p className="kicker">Результаты раунда · {state.currentQuestion?.category ?? 'Общие знания'}</p>
    <h2>{state.currentQuestion?.prompt ?? 'Результаты вопроса'}</h2>
    {state.currentQuestion ? <div className="result-options">
      {state.currentQuestion.options.map((option, index) => <motion.div key={`${option}-${index}`} className={`result-option ${index === correctOption ? 'is-correct is-gold-correct' : ''}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: index * 0.06 }}>
        <strong>{['А', 'Б', 'В', 'Г'][index]}</strong>
        <span>{option}</span>
      </motion.div>)}
    </div> : null}
    <p className="hint">{state.phase === 'battle-review' ? 'Верно ответили: ' : 'К захвату допущены: '}{state.roundResult?.correctPlayerIds.map((id) => state.players.find((player) => player.id === id)?.name ?? id).join(', ') || 'никто'}</p>
  </motion.section>
}

function OnlineNumberPanel({ state, remainingMs, onAnswer, disabled }: { disabled: boolean; state: MultiplayerGameState; remainingMs: number; onAnswer: (answer: number) => void }) {
  const [value, setValue] = useState('')
  return <section className="panel online-question-panel">
    <p className="kicker">Онлайн · числовая дуэль · {state.currentQuestion?.category ?? 'Общие знания'}</p>
    <h2>{state.currentQuestion?.prompt}</h2>
      <TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} />
    <form className="guess-form" onSubmit={(event) => { event.preventDefault(); const parsed = Number(value.replace(',', '.')); if (!disabled && value.trim() && Number.isFinite(parsed)) onAnswer(parsed) }}>
      <input disabled={disabled} aria-label="Числовой ответ" value={value} onChange={(event) => setValue(event.target.value)} inputMode="decimal" placeholder="Твоё число" />
      <button type="submit" disabled={disabled || !value.trim()}>Ответить</button>
    </form>
    <p className="hint">Побеждает тот, чей ответ ближе к правильному числу.</p>
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

function HistoryScreen({ entries, onBack }: { entries: PveHistoryEntry[]; onBack: () => void }) {
  return <section className="history-screen">
    <button type="button" className="stats-back" onClick={onBack}>← Статистика</button>
    <header className="stats-title"><p className="menu-eyebrow">Летопись матчей</p><h2>ИСТОРИЯ ИГР</h2><div className="title-rule" aria-hidden="true"><i /><b /><i /></div></header>
    {entries.length ? <div className="history-list">
      {entries.map((entry, index) => <HistoryEntryCard key={entry.id} entry={entry} index={index} />)}
    </div> : <div className="history-empty"><span aria-hidden="true">✦</span><h3>История пуста</h3><p>Завершённые матчи появятся здесь.</p></div>}
  </section>
}

function HistoryEntryCard({ entry, index }: { entry: PveHistoryEntry; index: number }) {
  const finishedAt = new Date(entry.finishedAt)
  const date = Number.isNaN(finishedAt.getTime())
    ? 'Дата неизвестна'
    : new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(finishedAt)
  const result = entry.winnerId === 'you' ? 'Победа' : `Победил ${entry.winnerName}`
  const categories = entry.categories.length ? entry.categories.join(' · ') : 'Все темы'

  return <article className={`history-entry ${entry.winnerId === 'you' ? 'is-win' : ''}`}>
    <header className="history-entry-head">
      <div>
        <p className="history-entry-kicker">Партия {entriesNumber(index)} · {date}</p>
        <h3>{result}</h3>
      </div>
      <span className="history-place">{entry.playerPlace}</span>
    </header>
    <div className="history-entry-map" aria-hidden="true">
      {entry.players.map((player) => <i key={player.id} style={{ ['--size' as string]: `${Math.max(16, 20 + player.territories * 5)}px`, ['--color' as string]: PLAYER_BY_ID[player.id].accent }} />)}
    </div>
    <div className="history-metrics">
      <span><b>{entry.player.score}</b> очков</span>
      <span><b>{entry.player.territories}</b> территорий</span>
      <span><b>{playerAccuracyLabel(entry.player.mcCorrect, entry.player.mcTotal)}</b> точность</span>
      <span><b>{entry.player.averageNumericError === null ? '—' : entry.player.averageNumericError}</b> ср. ошибка</span>
    </div>
    <footer className="history-entry-foot">
      <span>{entry.mode === 'trio' ? 'Троица' : 'Дуэль'} · {difficultyLabel(entry.difficulty)} · {arenaSizeLabel(entry.arenaSize)}</span>
      <span>{categories}</span>
    </footer>
  </article>
}

function entriesNumber(index: number): string {
  return String(index + 1).padStart(2, '0')
}

function StatsColumn({ title, rows }: { title: string; rows: string[][] }) {
  return <div className="stats-column"><h3>{title}</h3>{rows.map(([label, value]) => <div className="stats-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
}

function MenuScreen({
  notice,
  onStart,
  onStats,
  onRanked,
  onFriends,
}: {
  notice: string
  onStart: () => void
  onStats: () => void
  onRanked: () => void
  onFriends: () => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return <section className="menu-map-screen">
    <div className="map-ornament map-ornament-top" aria-hidden="true" />
    <div className="menu-settings-wrap">
      <button type="button" className="menu-settings" aria-label="Настройки" title="Настройки" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm8.2 3.6c0-.5-.1-1-.2-1.5l2-1.5-2-3.4-2.4 1a9 9 0 0 0-2.6-1.5L14.7 2H9.3L9 5.1a9 9 0 0 0-2.6 1.5L4 5.6 2 9l2 1.5a8 8 0 0 0 0 3L2 15l2 3.4 2.4-1A9 9 0 0 0 9 18.9l.3 3.1h5.4l.3-3.1a9 9 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5c.1-.5.2-1 .2-1.5Z" /></svg>
      </button>
      {settingsOpen ? <div className="menu-settings-popover">
        <p className="menu-settings-empty">Настройки матча открываются перед игрой с ботами.</p>
      </div> : null}
    </div>
    <header className="menu-title">
      <p className="menu-eyebrow">Знания решают всё</p>
      <h2>Ближе <span>всех.</span></h2><p className="menu-subtitle">Твой ум. Твоя стратегия. Твоя победа.</p>
      <div className="title-rule" aria-hidden="true"><i /><b /><i /></div>
    </header>
    <div className="map-scene" aria-hidden="true">
      <div className="orbit orbit-one" /><div className="orbit orbit-two" />
      <div className="hero-monogram">?</div>
      <HexToken className="token-top" color="terracotta" label="" />
      <HexToken className="token-left" color="olive" label="" />
      <HexToken className="token-right" color="blue" label="" />
      <span className="scene-caption">Каждый ответ — новый ход</span>
    </div>
    <div className="menu-actions menu-plaques" aria-label="Режимы игры">
      <button type="button" className="wood-plaque plaque-red" onClick={onRanked}><i className="mode-icon" aria-hidden="true">♜</i><span>Рейтинговая игра<small>Брось вызов лучшим</small></span><b aria-hidden="true">↗</b></button>
      <button type="button" className="wood-plaque plaque-light" onClick={onStart}><i className="mode-icon" aria-hidden="true">⬡</i><span>Битва умов<small>Захватывай территорию с ботами</small></span><b aria-hidden="true">↗</b></button>
      <button type="button" className="wood-plaque plaque-light" onClick={onFriends}><i className="mode-icon" aria-hidden="true">⌘</i><span>С друзьями<small>Собери свою компанию</small></span><b aria-hidden="true">↗</b></button>
    </div>
    <button type="button" className="stats-link" onClick={onStats}><span className="stats-link-icon" aria-hidden="true">↗</span><span><b>Моя статистика</b><small>Результаты, точность и история матчей</small></span><strong aria-hidden="true">→</strong></button>
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
