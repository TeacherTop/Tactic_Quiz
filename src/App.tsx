import { useEffect, useReducer, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArenaGrid } from './components/ArenaGrid'
import { PlayerDock } from './components/PlayerDock'
import { TimerRing } from './components/TimerRing'
import { NUMERIC_QUESTIONS, QUIZ_QUESTIONS } from './data/questions'
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
import { emptyScores, pickRandom, QUIZ_TIME_MS } from './game/engine'
import { PLAYER_BY_ID, PLAYERS } from './game/players'
import type { ArenaCell, NumericQuestion, PlayerId, QuizQuestion } from './game/types'
import { useCountdown } from './hooks/useCountdown'
import './styles.css'

type Phase = 'home' | 'expansion' | 'expansion-capture' | 'expansion-final' | 'battle-select' | 'battle-warmup' | 'battle-number' | 'results'
const MAX_BATTLE_ROUNDS = 10
const ANNOUNCEMENT_MS = 3500
const ROUND_RESULT_MS = 4500
const PLAYER_IDS: PlayerId[] = ['you', 'alex', 'marina']
type Answers = Record<PlayerId, number | null>
type RoundResult =
  | { kind: 'quiz'; question: QuizQuestion; answers: Answers }
  | { kind: 'numeric'; question: NumericQuestion; answers: Record<PlayerId, number | null> }

type PveStats = {
  games: number
  wins: number
  mcCorrect: number
  mcAnswered: number
  numericDeviationTotal: number
  numericAnswered: number
}

const STATS_STORAGE_KEY = 'strategi-quiz-pve-stats'

type Match = {
  scores: Record<PlayerId, number>
  arena: ArenaCell[]
  lastCapturedKey: string | null
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

type State = { phase: Phase; match: Match | null }

type Action =
  | { type: 'start' }
  | { type: 'exit' }
  | { type: 'answer-expansion'; id: PlayerId; pick: number | null; answeredAt: number }
  | { type: 'finish-expansion' }
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
  localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats))
}

function freeCellCount(arena: ArenaCell[]): number {
  return arena.filter((cell) => !cell.owner).length
}

function allAnswered(answers: Answers): boolean {
  return PLAYER_IDS.every((id) => answers[id] !== null)
}

function nextAttacker(arena: ArenaCell[], startIndex = 0): PlayerId | null {
  for (let offset = 0; offset < PLAYER_IDS.length; offset += 1) {
    const id = PLAYER_IDS[(startIndex + offset) % PLAYER_IDS.length]
    if (getAttackTargets(arena, id).length > 0) return id
  }
  return null
}

function makeMatch(): Match {
  return {
    scores: emptyScores(),
    arena: createArena(),
    lastCapturedKey: null,
    expansionQuestion: pickRandom(QUIZ_QUESTIONS, 1)[0],
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
    warmupQuestion: pickRandom(QUIZ_QUESTIONS, 1)[0],
    warmupAnswers: blankAnswers(),
    numericQuestion: pickRandom(NUMERIC_QUESTIONS, 1)[0],
    numericAnswers: blankAnswers(),
    finalQuestion: pickRandom(NUMERIC_QUESTIONS, 1)[0],
    finalAnswers: blankAnswers(),
    finalAnsweredAt: blankAnswerTimes(),
    pveStats: { mcCorrect: 0, mcAnswered: 0, numericDeviationTotal: 0, numericAnswered: 0 },
  }
}

function beginBattle(match: Match): State {
  const attacker = nextAttacker(match.arena)
  if (!attacker) return { phase: 'results', match }
  return { phase: 'battle-select', match: { ...match, attacker, battleRound: 0 } }
}

function beginFinalExpansion(match: Match): State {
  return {
    phase: 'expansion-final',
    match: {
      ...match,
      finalQuestion: pickRandom(NUMERIC_QUESTIONS, 1)[0],
      finalAnswers: blankAnswers(),
      finalAnsweredAt: blankAnswerTimes(),
    },
  }
}

function advanceCaptureQueue(match: Match): State {
  let arena = match.arena
  let captureIndex = match.captureIndex
  let lastCapturedKey = match.lastCapturedKey
  while (captureIndex < match.expansionQueue.length) {
    const id = match.expansionQueue[captureIndex]
    if (id === 'you') {
      return {
        phase: 'expansion-capture',
        match: { ...match, arena, captureIndex, pendingCapture: id, lastCapturedKey },
      }
    }
    const key = [...getAvailableCells(arena, id)][0]
    if (key) {
      const [row, col] = key.split(':').map(Number)
      arena = captureCell(arena, id, row, col)
      lastCapturedKey = key
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
    phase: 'expansion',
    match: {
      ...progressed,
      expansionQuestion: pickRandom(QUIZ_QUESTIONS, 1)[0],
      expansionAnswers: blankAnswers(),
      expansionAnsweredAt: blankAnswerTimes(),
      expansionQueue: [],
      expansionRound: match.expansionRound + 1,
      captureIndex: 0,
    },
  }
}

function resolveFinalExpansion(match: Match): State {
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
  if (!winner || !lastCell) return beginBattle(match)
  const arena = match.arena.map((cell) => (
    cell.row === lastCell.row && cell.col === lastCell.col ? { ...cell, owner: winner } : cell
  ))
  return beginBattle({ ...match, arena, lastCapturedKey: cellKey(lastCell.row, lastCell.col) })
}

function resolveExpansion(match: Match): State {
  const scores = { ...match.scores }
  for (const id of match.expansionQueue) {
    if (match.expansionAnswers[id] !== match.expansionQuestion.correctIndex) continue
    scores[id] += 100
  }
  return advanceCaptureQueue({ ...match, scores, captureIndex: 0, pendingCapture: null, lastCapturedKey: null })
}

function startNextBattle(match: Match): State {
  const nextRound = match.battleRound + 1
  if (nextRound >= MAX_BATTLE_ROUNDS) return { phase: 'results', match: { ...match, battleRound: nextRound } }
  const attacker = nextAttacker(match.arena, (PLAYER_IDS.indexOf(match.attacker) + 1) % PLAYER_IDS.length)
  if (!attacker) return { phase: 'results', match: { ...match, battleRound: nextRound } }
  return {
    phase: 'battle-select',
    match: { ...match, battleRound: nextRound, attacker, defender: null, target: null },
  }
}

function resolveWarmup(match: Match): State {
  const attackerCorrect = match.warmupAnswers[match.attacker] === match.warmupQuestion.correctIndex
  const defenderCorrect = match.defender !== null
    && match.warmupAnswers[match.defender] === match.warmupQuestion.correctIndex
  if (!attackerCorrect || !match.defender || !match.target) return startNextBattle(match)
  if (!defenderCorrect) {
    const arena = captureOpponentCell(match.arena, match.attacker, match.target.row, match.target.col)
    return startNextBattle({ ...match, arena, lastCapturedKey: cellKey(match.target.row, match.target.col) })
  }
  return {
    phase: 'battle-number',
    match: { ...match, numericQuestion: pickRandom(NUMERIC_QUESTIONS, 1)[0], numericAnswers: blankAnswers() },
  }
}

function resolveNumber(match: Match): State {
  if (!match.defender || !match.target) return startNextBattle(match)
  const attackerAnswer = match.numericAnswers[match.attacker]
  const defenderAnswer = match.numericAnswers[match.defender]
  const attackerDistance = attackerAnswer === null ? null : Math.abs(attackerAnswer - match.numericQuestion.answer)
  const defenderDistance = defenderAnswer === null ? null : Math.abs(defenderAnswer - match.numericQuestion.answer)
  let arena = match.arena
  if (attackerDistance !== null && (defenderDistance === null || attackerDistance < defenderDistance)) {
    arena = captureOpponentCell(arena, match.attacker, match.target.row, match.target.col)
  } else if (defenderDistance !== null && (attackerDistance === null || defenderDistance < attackerDistance)) {
    arena = captureOpponentCell(arena, match.defender, match.target.row, match.target.col)
  }
  return startNextBattle({ ...match, arena, lastCapturedKey: arena === match.arena ? null : cellKey(match.target.row, match.target.col) })
}

function reducer(state: State, action: Action): State {
  const match = state.match
  switch (action.type) {
    case 'start': return { phase: 'expansion', match: makeMatch() }
    case 'exit': return { phase: 'home', match: null }
    case 'answer-expansion': {
      if (!match || state.phase !== 'expansion' || match.expansionAnswers[action.id] !== null) return state
      const isCorrect = action.pick === match.expansionQuestion.correctIndex
      const next = {
        ...match,
        expansionAnswers: { ...match.expansionAnswers, [action.id]: action.pick },
        expansionAnsweredAt: { ...match.expansionAnsweredAt, [action.id]: action.answeredAt },
        expansionQueue: isCorrect ? [...match.expansionQueue, action.id] : match.expansionQueue,
        pveStats: action.id === 'you'
          ? { ...match.pveStats, mcCorrect: match.pveStats.mcCorrect + (isCorrect ? 1 : 0), mcAnswered: match.pveStats.mcAnswered + 1 }
          : match.pveStats,
      }
      return allAnswered(next.expansionAnswers) ? resolveExpansion(next) : { ...state, match: next }
    }
    case 'finish-expansion':
      return match && state.phase === 'expansion' ? resolveExpansion(match) : state
    case 'capture-expansion': {
      if (!match || state.phase !== 'expansion-capture' || match.pendingCapture !== 'you') return state
      const arena = captureCell(match.arena, 'you', action.row, action.col)
      if (arena === match.arena) return state
      return advanceCaptureQueue({
        ...match,
        arena,
        captureIndex: match.captureIndex + 1,
        pendingCapture: null,
        lastCapturedKey: cellKey(action.row, action.col),
      })
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
      return { phase: 'battle-warmup', match: { ...match, target, defender: target.owner, warmupQuestion: pickRandom(QUIZ_QUESTIONS, 1)[0], warmupAnswers: blankAnswers() } }
    }
    case 'answer-warmup': {
      if (!match || state.phase !== 'battle-warmup' || match.warmupAnswers[action.id] !== null) return state
      const isCorrect = action.pick === match.warmupQuestion.correctIndex
      const next = {
        ...match,
        warmupAnswers: { ...match.warmupAnswers, [action.id]: action.pick },
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
  const [state, dispatch] = useReducer(reducer, { phase: 'home', match: null })
  const [menuNotice, setMenuNotice] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paused, setPaused] = useState(false)
  const [announcement, setAnnouncement] = useState(true)
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null)
  const [showStats, setShowStats] = useState(false)
  const recordedMatch = useRef(false)
  const previousRef = useRef<{ phase: Phase; match: Match | null }>({ phase: 'home', match: null })
  const { phase, match } = state
  const startMatch = () => { setSettingsOpen(false); setShowStats(false); setPaused(false); setAnnouncement(true); recordedMatch.current = false; dispatch({ type: 'start' }) }
  const exitGame = () => { setSettingsOpen(false); setPaused(false); dispatch({ type: 'exit' }) }
  const questionPhase = phase === 'expansion' || phase === 'expansion-final' || phase === 'battle-warmup' || phase === 'battle-number'
  const shouldAnnounce = questionPhase && Boolean(match)
  const timedPhase = questionPhase
  const announcementKey = match ? `${phase}-${match.expansionRound}-${match.battleRound}-${match.target?.row ?? ''}-${match.target?.col ?? ''}` : 'home'
  useEffect(() => {
    if (!shouldAnnounce) return
    setAnnouncement(true)
    const id = window.setTimeout(() => setAnnouncement(false), ANNOUNCEMENT_MS)
    return () => window.clearTimeout(id)
  }, [announcementKey, shouldAnnounce])
  useEffect(() => {
    const previous = previousRef.current
    if (previous.match && previous.phase !== phase) {
      if (previous.phase === 'expansion') {
        setRoundResult({ kind: 'quiz', question: previous.match.expansionQuestion, answers: previous.match.expansionAnswers })
      } else if (previous.phase === 'battle-warmup') {
        setRoundResult({ kind: 'quiz', question: previous.match.warmupQuestion, answers: previous.match.warmupAnswers })
      } else if (previous.phase === 'battle-number') {
        setRoundResult({ kind: 'numeric', question: previous.match.numericQuestion, answers: previous.match.numericAnswers })
      } else if (previous.phase === 'expansion-final') {
        setRoundResult({ kind: 'numeric', question: previous.match.finalQuestion, answers: previous.match.finalAnswers })
      }
      const id = window.setTimeout(() => setRoundResult(null), ROUND_RESULT_MS)
      previousRef.current = { phase, match }
      return () => window.clearTimeout(id)
    }
    previousRef.current = { phase, match }
  }, [phase, match])
  const timerKey = match ? `${phase}-${match.expansionRound}-${match.battleRound}-${match.target?.row ?? ''}-${match.target?.col ?? ''}` : 'none'
  const remainingMs = useCountdown(timedPhase, QUIZ_TIME_MS, () => {
    dispatch({
      type: phase === 'expansion'
        ? 'finish-expansion'
        : phase === 'expansion-final'
          ? 'finish-final'
          : phase === 'battle-warmup'
            ? 'finish-warmup'
            : 'finish-number',
    })
  }, timerKey, paused || announcement)

  useEffect(() => {
    if (!match || paused || announcement) return
    if (phase === 'expansion') {
      const player = PLAYERS.find((candidate) => candidate.kind === 'bot' && match.expansionAnswers[candidate.id] === null)
      if (player) {
        const id = window.setTimeout(() => dispatch({ type: 'answer-expansion', id: player.id, pick: botQuizChoice(match.expansionQuestion.correctIndex, player.skill), answeredAt: performance.now() }), botAnswerDelayMs(player.skill, QUIZ_TIME_MS))
        return () => window.clearTimeout(id)
      }
    }
    if (phase === 'expansion-final') {
      const player = PLAYERS.find((candidate) => candidate.kind === 'bot' && match.finalAnswers[candidate.id] === null)
      if (player) {
        const id = window.setTimeout(() => dispatch({
          type: 'answer-final',
          id: player.id,
          value: botNumericGuess(match.finalQuestion.answer, player.skill),
          answeredAt: performance.now(),
        }), botAnswerDelayMs(player.skill, QUIZ_TIME_MS))
        return () => window.clearTimeout(id)
      }
    }
    if (phase === 'battle-select' && PLAYER_BY_ID[match.attacker].kind === 'bot') {
      const target = pickRandom(getAttackTargets(match.arena, match.attacker), 1)[0]
      if (target) {
        const id = window.setTimeout(() => dispatch({ type: 'select-attack', row: target.row, col: target.col }), 650)
        return () => window.clearTimeout(id)
      }
    }
    if (phase === 'battle-warmup' && match.defender) {
      const waiting = [match.attacker, match.defender].find((id) => match.warmupAnswers[id] === null && PLAYER_BY_ID[id].kind === 'bot')
      if (waiting) {
        const id = window.setTimeout(() => dispatch({ type: 'answer-warmup', id: waiting, pick: botQuizChoice(match.warmupQuestion.correctIndex, PLAYER_BY_ID[waiting].skill) }), botAnswerDelayMs(PLAYER_BY_ID[waiting].skill, QUIZ_TIME_MS))
        return () => window.clearTimeout(id)
      }
    }
    if (phase === 'battle-number' && match.defender) {
      const waiting = [match.attacker, match.defender].find((id) => match.numericAnswers[id] === null && PLAYER_BY_ID[id].kind === 'bot')
      if (waiting) {
        const id = window.setTimeout(() => dispatch({ type: 'answer-number', id: waiting, value: botNumericGuess(match.numericQuestion.answer, PLAYER_BY_ID[waiting].skill) }), botAnswerDelayMs(PLAYER_BY_ID[waiting].skill, QUIZ_TIME_MS))
        return () => window.clearTimeout(id)
      }
    }
  }, [phase, match, paused, announcement])

  const togglePause = () => {
    setSettingsOpen(false)
    setPaused((value) => !value)
  }

  const humanQuestion = (question: QuizQuestion, answers: Answers, type: 'expansion' | 'warmup') => (
    <QuestionPanel question={question} remainingMs={remainingMs} locked={answers.you !== null || paused} onChoose={(pick) => type === 'expansion'
      ? dispatch({ type: 'answer-expansion', id: 'you', pick, answeredAt: performance.now() })
      : dispatch({ type: 'answer-warmup', id: 'you', pick })} />
  )
  const battleTargetKeys = phase === 'battle-select' && match && match.attacker === 'you'
    ? new Set(getAttackTargets(match.arena, match.attacker).map((cell) => cellKey(cell.row, cell.col)))
    : undefined
  const expansionQueuePosition = match?.expansionQueue.indexOf('you') ?? -1
  const activeTurn = match
    ? phase.startsWith('battle')
      ? match.attacker
      : match.pendingCapture ?? match.expansionQueue[0] ?? null
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

  return <div className={`arena ${phase === 'home' ? '' : 'game-shell'}`}>
    {phase !== 'home' ? <header className="topbar">
      <div><p className="kicker">Арена</p><h1>Ближе всех</h1></div>
      {match ? <div className="topbar-tools"><TurnIndicator activePlayer={activeTurn} /><PhaseBadge phase={phase} match={match} /><PlayerDock scores={match.scores} badges={{ [match.attacker]: phase.startsWith('battle') ? 'атакует' : undefined }} /><div className={`settings-menu${settingsOpen ? ' is-open' : ''}`}><button type="button" className="settings-button" aria-label="Настройки" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><span aria-hidden="true">⚙</span></button>{settingsOpen ? <div className="settings-popover"><button type="button" className="pause-button" onClick={togglePause}>{paused ? 'Продолжить' : 'Приостановить игру'}</button><button type="button" className="exit-button" onClick={exitGame}>Выйти из игры</button></div> : null}</div></div> : null}
    </header> : null}
    <main className="stage">
      {phase === 'home' && showStats ? <StatsScreen stats={readPveStats()} onBack={() => setShowStats(false)} /> : null}
      {phase === 'home' && !showStats ? <MenuScreen notice={menuNotice} onStart={startMatch} onStats={() => setShowStats(true)} onStub={(label) => setMenuNotice(`${label} появится в следующем этапе.`)} /> : null}
      <AnimatePresence mode="wait">
        {match && phase !== 'home' && !questionPhase ? <motion.div key="map" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.3 }}><ArenaGrid cells={match.arena} activePlayer={phase === 'expansion-capture' ? 'you' : null} selectableKeys={battleTargetKeys} lastCapturedKey={match.lastCapturedKey} onCapture={(row, col) => phase === 'battle-select' ? dispatch({ type: 'select-attack', row, col }) : dispatch({ type: 'capture-expansion', row, col })} /></motion.div> : null}
        {questionPhase && !announcement ? <motion.div key="question" className="question-stage" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -18 }} transition={{ duration: 0.3 }}>
          {phase === 'expansion' && match ? <>{expansionQueuePosition >= 0 ? <p className="queue-status">Ты в очереди захвата: {expansionQueuePosition + 1}-й</p> : null}{humanQuestion(match.expansionQuestion, match.expansionAnswers, 'expansion')}</> : null}
          {phase === 'expansion-final' && match ? <FinalRoundPanel match={match} remainingMs={remainingMs} locked={finalHumanLocked || paused} onAnswer={(value) => dispatch({ type: 'answer-final', id: 'you', value, answeredAt: performance.now() })} /> : null}
          {phase === 'battle-warmup' && match && match.defender ? <><section className="panel battle-step"><p className="kicker">Битва · шаг 1 из 2 · Разминка</p><p className="hint">{PLAYER_BY_ID[match.attacker].name} атакует {PLAYER_BY_ID[match.defender].name}.</p></section>{match.attacker === 'you' || match.defender === 'you' ? humanQuestion(match.warmupQuestion, match.warmupAnswers, 'warmup') : <BotWaiting remainingMs={remainingMs} />}</> : null}
          {phase === 'battle-number' && match && match.defender ? <><section className="panel battle-step"><p className="kicker">Битва · шаг 2 из 2 · Числовая дуэль</p><h2>Ближе к правильному числу побеждает</h2><p className="hint">Скорость не влияет на результат.</p></section>{match.attacker === 'you' || match.defender === 'you' ? <NumberDuel match={match} remainingMs={remainingMs} paused={paused} onAnswer={(value) => dispatch({ type: 'answer-number', id: 'you', value })} /> : <BotWaiting remainingMs={remainingMs} />}</> : null}
        </motion.div> : null}
      </AnimatePresence>
      {announcement && questionPhase ? <RoundAnnouncement phase={phase} match={match} /> : null}
      {paused ? <PauseOverlay onResume={togglePause} /> : null}
      {roundResult ? <RoundResultOverlay result={roundResult} /> : null}
      {phase === 'expansion-capture' && match ? <section className="panel"><p className="kicker">Завоевание · правильный ответ</p><h2>{isExpansionBreakthrough(match.arena, 'you') ? 'Прорыв блокады: выбери любую свободную соту' : 'Выбери свободную соседнюю соту'}</h2><p className="hint">{isExpansionBreakthrough(match.arena, 'you') ? 'Твоя территория окружена. Десант можно высадить в любой свободной точке карты.' : 'Только соседняя свободная сота доступна для расширения.'}</p></section> : null}
      {phase === 'battle-select' && match && match.attacker === 'you' ? <p className="map-instruction">Выбери подсвеченную вражескую соту на карте</p> : null}
      {phase === 'results' && match ? <ResultsScreen scores={match.scores} arena={match.arena} onAgain={startMatch} /> : null}
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
  return <motion.section className="round-announcement" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
    <p className="kicker">Новый раунд</p>
    <h2>{battle ? `Раунд ${Math.min((match?.battleRound ?? 0) + 1, MAX_BATTLE_ROUNDS)} из ${MAX_BATTLE_ROUNDS}` : `Раунд ${match?.expansionRound ?? 1}`}</h2>
    <p>{numeric ? 'Числовая дуэль' : 'Викторина'}</p>
    <span className="announcement-mark">✦</span>
  </motion.section>
}

function PauseOverlay({ onResume }: { onResume: () => void }) {
  return <motion.div className="pause-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><section className="pause-card"><p className="kicker">Игра приостановлена</p><h2>Пауза</h2><p>Таймер и ответы остановлены.</p><button type="button" className="primary" onClick={onResume}>Продолжить</button></section></motion.div>
}

function RoundResultOverlay({ result }: { result: RoundResult }) {
  if (result.kind === 'quiz') {
    return <motion.div className="round-result-overlay" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}><section className="round-result-card"><p className="kicker">Результаты викторины</p><h2>Правильный ответ: {['А', 'Б', 'В', 'Г'][result.question.correctIndex]}</h2><div className="result-options">{result.question.options.map((option, index) => <div key={option} className={`result-option ${index === result.question.correctIndex ? 'is-correct' : ''}`}><strong>{['А', 'Б', 'В', 'Г'][index]}</strong><span>{option}</span><div className="answer-players">{PLAYER_IDS.filter((id) => result.answers[id] === index).map((id) => <i key={id} style={{ background: PLAYER_BY_ID[id].accent }} title={PLAYER_BY_ID[id].name}>{PLAYER_BY_ID[id].name.slice(0, 1)}</i>)}</div></div>)}</div></section></motion.div>
  }
  const rows = PLAYER_IDS.map((id) => ({ id, value: result.answers[id], distance: result.answers[id] === null ? null : Math.abs(result.answers[id] - result.question.answer) })).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
  return <motion.div className="round-result-overlay" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}><section className="round-result-card"><p className="kicker">Результаты числовой дуэли</p><h2>Правильный ответ: {result.question.answer}</h2><div className="numeric-result-cards">{rows.map((row, index) => <article key={row.id} className={`numeric-result-card ${index === 0 ? 'is-winner' : ''}`} style={{ ['--accent' as string]: PLAYER_BY_ID[row.id].accent }}><strong>{PLAYER_BY_ID[row.id].name}</strong><span>{row.value === null ? 'нет ответа' : row.value}</span><small>{row.distance === null ? '—' : `Отклонение: ${row.value! - result.question.answer > 0 ? '+' : ''}${row.value! - result.question.answer}`}</small></article>)}</div></section></motion.div>
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

function QuestionPanel({ question, remainingMs, locked, onChoose }: { question: QuizQuestion; remainingMs: number; locked: boolean; onChoose: (pick: number) => void }) {
  return <section className="panel"><p className="kicker">Общий вопрос · отвечают все одновременно</p><h2>{question.prompt}</h2><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><div className="options">{question.options.map((option, index) => <button key={option} type="button" className="option" disabled={locked} onClick={() => onChoose(index)}><span className="opt-key">{['А', 'Б', 'В', 'Г'][index]}</span>{option}</button>)}</div><p className="hint">{locked ? 'Ответ принят. Ждём остальных игроков.' : 'На ответ есть 15 секунд.'}</p></section>
}

function NumberDuel({ match, remainingMs, paused, onAnswer }: { match: Match; remainingMs: number; paused: boolean; onAnswer: (value: number | null) => void }) {
  const [value, setValue] = useState('')
  const [locked, setLocked] = useState(false)
  return <section className="panel"><p className="kicker">Одновременный ответ</p><p className="hint">{match.numericQuestion.prompt}</p><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><form className="guess-form" onSubmit={(event) => { event.preventDefault(); const parsed = Number(value.replace(',', '.')); if (!Number.isFinite(parsed)) return; setLocked(true); onAnswer(parsed) }}><input value={value} onChange={(event) => setValue(event.target.value)} disabled={locked || paused} inputMode="decimal" placeholder="Твоё число" aria-label="Числовой ответ" /><button type="submit" disabled={locked || paused}>{locked ? 'Принято' : 'Ответить'}</button></form><p className="hint">Сравнивается только абсолютное отклонение, без бонуса за скорость.</p></section>
}

function FinalRoundPanel({ match, remainingMs, locked, onAnswer }: { match: Match; remainingMs: number; locked: boolean; onAnswer: (value: number | null) => void }) {
  const [value, setValue] = useState('')
  return <section className="panel final-round-panel"><p className="kicker">РЕШАЮЩИЙ РАУНД · ФИНАЛЬНАЯ СОТА</p><h2>{match.finalQuestion.prompt}</h2><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><form className="guess-form" onSubmit={(event) => { event.preventDefault(); const parsed = Number(value.replace(',', '.')); if (!Number.isFinite(parsed)) return; onAnswer(parsed) }}><input value={value} onChange={(event) => setValue(event.target.value)} disabled={locked} inputMode="decimal" placeholder="Твоё число" aria-label="Ответ финального раунда" /><button type="submit" disabled={locked}>{locked ? 'Принято' : 'Ответить'}</button></form><p className="hint">Осталась одна сота. Побеждает ближайший ответ; при равенстве решает время отправки.</p></section>
}

function BotWaiting({ remainingMs }: { remainingMs: number }) { return <section className="panel"><p className="kicker">Одновременный ответ</p><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><p className="hint">Боты отвечают…</p></section> }

function ResultsScreen({ scores, arena, onAgain }: { scores: Record<PlayerId, number>; arena: ArenaCell[]; onAgain: () => void }) {
  const territory = PLAYER_IDS.map((id) => ({ id, count: arena.filter((cell) => cell.owner === id).length })).sort((a, b) => b.count - a.count)
  return <section className="panel"><p className="kicker">Матч завершён</p><h2>Победитель: {PLAYER_BY_ID[territory[0].id].name}</h2><ol className="rank-list">{territory.map((row) => <li key={row.id} style={{ ['--accent' as string]: PLAYER_BY_ID[row.id].accent }}><span className="rank-place">{row.count}</span><span>{PLAYER_BY_ID[row.id].name}</span><span>{scores[row.id]} очков</span></li>)}</ol><button type="button" className="primary" onClick={onAgain}>Новая игра</button></section>
}

function StatsScreen({ stats, onBack }: { stats: PveStats; onBack: () => void }) {
  const mcAccuracy = stats.mcAnswered ? Math.round((stats.mcCorrect / stats.mcAnswered) * 100) : null
  const numericAccuracy = stats.numericAnswered ? Math.max(0, Math.round(100 - (stats.numericDeviationTotal / stats.numericAnswered))) : null
  return <section className="stats-screen">
    <button type="button" className="stats-back" onClick={onBack}>← Главное меню</button>
    <header className="stats-title"><p className="menu-eyebrow">Летопись сражений</p><h2>СТАТИСТИКА</h2><div className="title-rule" aria-hidden="true"><i /><b /><i /></div></header>
    <div className="stats-dashboard">
      <section className="stats-block stats-pvp"><p className="stats-block-kicker">Блок A · Рейтинговые игры (PvP)</p><div className="stats-columns"><StatsColumn title="Дуэль · 1v1" rows={[['Побед', '0'], ['Поражений', '0'], ['% правильных MC', '0%']]} /><StatsColumn title="Троица · 1v1v1" rows={[['1-е места', '0 🥇'], ['2-е места', '0 🥈'], ['3-е места', '0 🥉'], ['% правильных MC', '0%']]} /></div><p className="stats-empty-note">Рейтинговый режим пока не подключён</p></section>
      <section className="stats-block stats-pve"><p className="stats-block-kicker">Блок B · Игра с ботами (PvE)</p><div className="pve-grid"><StatMetric label="Всего игр" value={stats.games} /><StatMetric label="Побед над ботами" value={stats.wins} /><StatMetric label="% правильных MC" value={mcAccuracy === null ? '0%' : `${mcAccuracy}%`} progress={mcAccuracy ?? 0} /><StatMetric label="Точность числовых ответов" value={numericAccuracy === null ? '—' : `${numericAccuracy}%`} progress={numericAccuracy ?? 0} /></div></section>
    </div>
    <p className="menu-version">Данные хранятся на этом устройстве · v1.0</p>
  </section>
}

function StatsColumn({ title, rows }: { title: string; rows: string[][] }) {
  return <div className="stats-column"><h3>{title}</h3>{rows.map(([label, value]) => <div className="stats-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
}

function StatMetric({ label, value, progress }: { label: string; value: number | string; progress?: number }) {
  return <div className="stat-metric"><span>{label}</span><strong>{value}</strong>{progress !== undefined ? <i><b style={{ width: `${progress}%` }} /></i> : null}</div>
}

function MenuScreen({ notice, onStart, onStats, onStub }: { notice: string; onStart: () => void; onStats: () => void; onStub: (label: string) => void }) {
  return <section className="menu-map-screen">
    <div className="map-ornament map-ornament-top" aria-hidden="true" />
    <button type="button" className="menu-settings" aria-label="Настройки" title="Настройки" onClick={() => onStub('Настройки')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm8.2 3.6c0-.5-.1-1-.2-1.5l2-1.5-2-3.4-2.4 1a9 9 0 0 0-2.6-1.5L14.7 2H9.3L9 5.1a9 9 0 0 0-2.6 1.5L4 5.6 2 9l2 1.5a8 8 0 0 0 0 3L2 15l2 3.4 2.4-1A9 9 0 0 0 9 18.9l.3 3.1h5.4l.3-3.1a9 9 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5c.1-.5.2-1 .2-1.5Z" /></svg>
    </button>
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
      <button type="button" className="wood-plaque plaque-red" onClick={() => onStub('Рейтинговая игра')}><span>РЕЙТИНГОВАЯ ИГРА</span><small>СКОРО</small></button>
      <button type="button" className="wood-plaque plaque-light" onClick={onStart}><span>ИГРА С БОТАМИ</span><small>НАЧАТЬ</small></button>
      <button type="button" className="wood-plaque plaque-light" onClick={() => onStub('Игра с друзьями')}><span>ИГРА С ДРУЗЬЯМИ</span><small>СКОРО</small></button>
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
