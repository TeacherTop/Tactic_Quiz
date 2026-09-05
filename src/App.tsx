import { useEffect, useReducer, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import heroArena from './assets/hero.png'
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
const ANNOUNCEMENT_MS = 2200
const PLAYER_IDS: PlayerId[] = ['you', 'alex', 'marina']
type Answers = Record<PlayerId, number | null>
type RoundResult =
  | { kind: 'quiz'; question: QuizQuestion; answers: Answers }
  | { kind: 'numeric'; question: NumericQuestion; answers: Record<PlayerId, number | null> }

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
  }
}

function beginBattle(match: Match): State {
  const attacker = nextAttacker(match.arena)
  if (!attacker) return { phase: 'results', match }
  return { phase: 'battle-select', match: { ...match, attacker, battleRound: 0 } }
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
  }
  const progressed = { ...match, arena, captureIndex, pendingCapture: null, lastCapturedKey }
  if (freeCellCount(arena) === 1) {
    return {
      phase: 'expansion-final',
      match: {
        ...progressed,
        finalQuestion: pickRandom(NUMERIC_QUESTIONS, 1)[0],
        finalAnswers: blankAnswers(),
        finalAnsweredAt: blankAnswerTimes(),
      },
    }
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
      const next = { ...match, warmupAnswers: { ...match.warmupAnswers, [action.id]: action.pick } }
      return match.defender && next.warmupAnswers[match.attacker] !== null && next.warmupAnswers[match.defender] !== null
        ? resolveWarmup(next)
        : { ...state, match: next }
    }
    case 'finish-warmup': return match && state.phase === 'battle-warmup' ? resolveWarmup(match) : state
    case 'answer-number': {
      if (!match || state.phase !== 'battle-number' || match.numericAnswers[action.id] !== null) return state
      const next = { ...match, numericAnswers: { ...match.numericAnswers, [action.id]: action.value } }
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
  const previousRef = useRef<{ phase: Phase; match: Match | null }>({ phase: 'home', match: null })
  const { phase, match } = state
  const startMatch = () => { setSettingsOpen(false); setPaused(false); setAnnouncement(true); dispatch({ type: 'start' }) }
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
      if (previous.phase === 'expansion' && previous.match.expansionAnswers.you !== null) {
        setRoundResult({ kind: 'quiz', question: previous.match.expansionQuestion, answers: previous.match.expansionAnswers })
      } else if (previous.phase === 'battle-warmup' && previous.match.warmupAnswers.you !== null) {
        setRoundResult({ kind: 'quiz', question: previous.match.warmupQuestion, answers: previous.match.warmupAnswers })
      } else if (previous.phase === 'battle-number' && previous.match.numericAnswers.you !== null) {
        setRoundResult({ kind: 'numeric', question: previous.match.numericQuestion, answers: previous.match.numericAnswers })
      }
      const id = window.setTimeout(() => setRoundResult(null), 1900)
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
      const player = PLAYERS.find((candidate) => match.finalAnswers[candidate.id] === null)
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

  return <div className="arena">
    <header className="topbar">
      <div><p className="kicker">Арена</p><h1>Ближе всех</h1></div>
      {match && phase !== 'home' ? <div className="topbar-tools"><TurnIndicator activePlayer={activeTurn} /><PhaseBadge phase={phase} match={match} /><PlayerDock scores={match.scores} badges={{ [match.attacker]: phase.startsWith('battle') ? 'атакует' : undefined }} /><div className={`settings-menu${settingsOpen ? ' is-open' : ''}`}><button type="button" className="settings-button" aria-label="Настройки" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><span aria-hidden="true">⚙</span></button>{settingsOpen ? <div className="settings-popover"><button type="button" className="pause-button" onClick={togglePause}>{paused ? 'Продолжить' : 'Приостановить игру'}</button><button type="button" className="exit-button" onClick={exitGame}>Выйти из игры</button></div> : null}</div></div> : null}
    </header>
    <main className="stage">
      {phase === 'home' ? <MenuScreen notice={menuNotice} onStart={startMatch} onStub={(label) => setMenuNotice(`${label} появится в следующем этапе.`)} /> : null}
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

function MenuScreen({ notice, onStart, onStub }: { notice: string; onStart: () => void; onStub: (label: string) => void }) {
  return <section className="panel hero menu-panel"><div className="hero-copy"><p className="kicker">Главное меню</p><h2>Завоевание и битва</h2><p className="lede">Сначала расширь территорию правильными ответами, затем сражайся за границы.</p><div className="menu-actions"><button type="button" className="mode-button is-locked" onClick={() => onStub('Рейтинговая игра')}><span>Рейтинговая игра</span><small>Скоро</small></button><button type="button" className="mode-button is-primary" onClick={onStart}><span>Игра с ботами</span><small>Играть</small></button><button type="button" className="mode-button is-locked" onClick={() => onStub('Игра с друзьями')}><span>Игра с друзьями</span><small>Скоро</small></button></div>{notice ? <p className="menu-notice">{notice}</p> : null}</div><img className="hero-art" src={heroArena} alt="" aria-hidden="true" /></section>
}
