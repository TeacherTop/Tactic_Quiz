import { useEffect, useReducer, useState } from 'react'
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

type Phase = 'home' | 'expansion' | 'expansion-capture' | 'battle-select' | 'battle-warmup' | 'battle-number' | 'results'
const MAX_BATTLE_ROUNDS = 12
const PLAYER_IDS: PlayerId[] = ['you', 'alex', 'marina']
type Answers = Record<PlayerId, number | null>

type Match = {
  scores: Record<PlayerId, number>
  arena: ArenaCell[]
  lastCapturedKey: string | null
  expansionQuestion: QuizQuestion
  expansionAnswers: Answers
  expansionRound: number
  pendingCapture: PlayerId | null
  battleRound: number
  attacker: PlayerId
  defender: PlayerId | null
  target: ArenaCell | null
  warmupQuestion: QuizQuestion
  warmupAnswers: Answers
  numericQuestion: NumericQuestion
  numericAnswers: Record<PlayerId, number | null>
}

type State = { phase: Phase; match: Match | null }

type Action =
  | { type: 'start' }
  | { type: 'exit' }
  | { type: 'answer-expansion'; id: PlayerId; pick: number | null }
  | { type: 'finish-expansion' }
  | { type: 'capture-expansion'; row: number; col: number }
  | { type: 'select-attack'; row: number; col: number }
  | { type: 'answer-warmup'; id: PlayerId; pick: number | null }
  | { type: 'finish-warmup' }
  | { type: 'answer-number'; id: PlayerId; value: number | null }
  | { type: 'finish-number' }

function blankAnswers(): Answers {
  return { you: null, alex: null, marina: null }
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
    expansionRound: 1,
    pendingCapture: null,
    battleRound: 0,
    attacker: 'you',
    defender: null,
    target: null,
    warmupQuestion: pickRandom(QUIZ_QUESTIONS, 1)[0],
    warmupAnswers: blankAnswers(),
    numericQuestion: pickRandom(NUMERIC_QUESTIONS, 1)[0],
    numericAnswers: blankAnswers(),
  }
}

function beginBattle(match: Match): State {
  const attacker = nextAttacker(match.arena)
  if (!attacker) return { phase: 'results', match }
  return { phase: 'battle-select', match: { ...match, attacker, battleRound: 0 } }
}

function resolveExpansion(match: Match): State {
  let arena = match.arena
  const scores = { ...match.scores }
  let pendingCapture: PlayerId | null = null
  for (const id of PLAYER_IDS) {
    if (match.expansionAnswers[id] !== match.expansionQuestion.correctIndex) continue
    scores[id] += 100
    if (id === 'you') {
      pendingCapture = id
      continue
    }
    const key = [...getAvailableCells(arena, id)][0]
    if (key) {
      const [row, col] = key.split(':').map(Number)
      arena = captureCell(arena, id, row, col)
    }
  }
  const nextMatch = { ...match, arena, scores, pendingCapture, lastCapturedKey: null }
  if (pendingCapture) return { phase: 'expansion-capture', match: nextMatch }
  if (arena.every((cell) => cell.owner)) return beginBattle(nextMatch)
  return {
    phase: 'expansion',
    match: {
      ...nextMatch,
      expansionQuestion: pickRandom(QUIZ_QUESTIONS, 1)[0],
      expansionAnswers: blankAnswers(),
      expansionRound: match.expansionRound + 1,
    },
  }
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
      const next = { ...match, expansionAnswers: { ...match.expansionAnswers, [action.id]: action.pick } }
      return allAnswered(next.expansionAnswers) ? resolveExpansion(next) : { ...state, match: next }
    }
    case 'finish-expansion':
      return match && state.phase === 'expansion' ? resolveExpansion(match) : state
    case 'capture-expansion': {
      if (!match || state.phase !== 'expansion-capture' || match.pendingCapture !== 'you') return state
      const arena = captureCell(match.arena, 'you', action.row, action.col)
      if (arena === match.arena) return state
      const next = { ...match, arena, pendingCapture: null, lastCapturedKey: cellKey(action.row, action.col) }
      return arena.every((cell) => cell.owner) ? beginBattle(next) : {
        phase: 'expansion',
        match: { ...next, expansionQuestion: pickRandom(QUIZ_QUESTIONS, 1)[0], expansionAnswers: blankAnswers(), expansionRound: match.expansionRound + 1 },
      }
    }
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
  const { phase, match } = state
  const startMatch = () => { setSettingsOpen(false); dispatch({ type: 'start' }) }
  const exitGame = () => { setSettingsOpen(false); dispatch({ type: 'exit' }) }
  const timedPhase = phase === 'expansion' || phase === 'battle-warmup' || phase === 'battle-number'
  const timerKey = match ? `${phase}-${match.expansionRound}-${match.battleRound}-${match.target?.row ?? ''}-${match.target?.col ?? ''}` : 'none'
  const remainingMs = useCountdown(timedPhase, QUIZ_TIME_MS, () => {
    dispatch({ type: phase === 'expansion' ? 'finish-expansion' : phase === 'battle-warmup' ? 'finish-warmup' : 'finish-number' })
  }, timerKey)

  useEffect(() => {
    if (!match) return
    if (phase === 'expansion') {
      const player = PLAYERS.find((candidate) => candidate.kind === 'bot' && match.expansionAnswers[candidate.id] === null)
      if (player) {
        const id = window.setTimeout(() => dispatch({ type: 'answer-expansion', id: player.id, pick: botQuizChoice(match.expansionQuestion.correctIndex, player.skill) }), botAnswerDelayMs(player.skill, QUIZ_TIME_MS))
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
  }, [phase, match])

  const humanQuestion = (question: QuizQuestion, answers: Answers, type: 'expansion' | 'warmup') => (
    <QuestionPanel question={question} remainingMs={remainingMs} locked={answers.you !== null} onChoose={(pick) => dispatch({ type: type === 'expansion' ? 'answer-expansion' : 'answer-warmup', id: 'you', pick })} />
  )

  return <div className="arena">
    <header className="topbar">
      <div><p className="kicker">Арена</p><h1>Ближе всех</h1></div>
      {match && phase !== 'home' ? <div className="topbar-tools"><PhaseBadge phase={phase} match={match} /><PlayerDock scores={match.scores} badges={{ [match.attacker]: phase.startsWith('battle') ? 'атакует' : undefined }} /><div className={`settings-menu${settingsOpen ? ' is-open' : ''}`}><button type="button" className="settings-button" aria-label="Настройки" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><span aria-hidden="true">⚙</span></button>{settingsOpen ? <div className="settings-popover"><button type="button" className="exit-button" onClick={exitGame}>Выйти из игры</button></div> : null}</div></div> : null}
    </header>
    <main className="stage">
      {phase === 'home' ? <MenuScreen notice={menuNotice} onStart={startMatch} onStub={(label) => setMenuNotice(`${label} появится в следующем этапе.`)} /> : null}
      {match && phase !== 'home' ? <ArenaGrid cells={match.arena} activePlayer={phase === 'expansion-capture' ? 'you' : null} lastCapturedKey={match.lastCapturedKey} onCapture={(row, col) => dispatch({ type: 'capture-expansion', row, col })} /> : null}
      {phase === 'expansion' && match ? humanQuestion(match.expansionQuestion, match.expansionAnswers, 'expansion') : null}
      {phase === 'expansion-capture' && match ? <section className="panel"><p className="kicker">Завоевание · правильный ответ</p><h2>{isExpansionBreakthrough(match.arena, 'you') ? 'Прорыв блокады: выбери любую свободную соту' : 'Выбери свободную соседнюю соту'}</h2><p className="hint">{isExpansionBreakthrough(match.arena, 'you') ? 'Твоя территория окружена. Десант можно высадить в любой свободной точке карты.' : 'Только соседняя свободная сота доступна для расширения.'}</p></section> : null}
      {phase === 'battle-select' && match ? <BattleSelect match={match} onSelect={(row, col) => dispatch({ type: 'select-attack', row, col })} /> : null}
      {phase === 'battle-warmup' && match && match.defender ? <><section className="panel battle-step"><p className="kicker">Битва · шаг 1 из 2 · Разминка</p><p className="hint">{PLAYER_BY_ID[match.attacker].name} атакует {PLAYER_BY_ID[match.defender].name}.</p></section>{match.attacker === 'you' || match.defender === 'you' ? humanQuestion(match.warmupQuestion, match.warmupAnswers, 'warmup') : <BotWaiting remainingMs={remainingMs} />}</> : null}
      {phase === 'battle-number' && match && match.defender ? <><section className="panel battle-step"><p className="kicker">Битва · шаг 2 из 2 · Числовая дуэль</p><h2>Ближе к правильному числу побеждает</h2><p className="hint">Скорость не влияет на результат.</p></section>{match.attacker === 'you' || match.defender === 'you' ? <NumberDuel match={match} remainingMs={remainingMs} onAnswer={(value) => dispatch({ type: 'answer-number', id: 'you', value })} /> : <BotWaiting remainingMs={remainingMs} />}</> : null}
      {phase === 'results' && match ? <ResultsScreen scores={match.scores} arena={match.arena} onAgain={startMatch} /> : null}
    </main>
  </div>
}

function PhaseBadge({ phase, match }: { phase: Phase; match: Match }) {
  const battle = phase.startsWith('battle') || phase === 'results'
  return <div className="phase-badge"><strong>{battle ? 'Битва' : 'Завоевание'}</strong><small>{battle ? `Раунд ${Math.min(match.battleRound + 1, MAX_BATTLE_ROUNDS)} / ${MAX_BATTLE_ROUNDS}` : `Раунд ${match.expansionRound}`}</small></div>
}

function QuestionPanel({ question, remainingMs, locked, onChoose }: { question: QuizQuestion; remainingMs: number; locked: boolean; onChoose: (pick: number) => void }) {
  return <section className="panel"><p className="kicker">Общий вопрос · отвечают все одновременно</p><h2>{question.prompt}</h2><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><div className="options">{question.options.map((option, index) => <button key={option} type="button" className="option" disabled={locked} onClick={() => onChoose(index)}><span className="opt-key">{['А', 'Б', 'В', 'Г'][index]}</span>{option}</button>)}</div><p className="hint">{locked ? 'Ответ принят. Ждём остальных игроков.' : 'На ответ есть 15 секунд.'}</p></section>
}

function BattleSelect({ match, onSelect }: { match: Match; onSelect: (row: number, col: number) => void }) {
  const targets = getAttackTargets(match.arena, match.attacker)
  return <section className="panel"><p className="kicker">Битва · выбор цели</p><h2>{PLAYER_BY_ID[match.attacker].name}, выбери соседнюю вражескую соту</h2><div className="target-list">{targets.map((target) => <button key={cellKey(target.row, target.col)} type="button" className="target-button" onClick={() => onSelect(target.row, target.col)}>Сота {target.row}:{target.col} · {PLAYER_BY_ID[target.owner as PlayerId].name}</button>)}</div></section>
}

function NumberDuel({ match, remainingMs, onAnswer }: { match: Match; remainingMs: number; onAnswer: (value: number | null) => void }) {
  const [value, setValue] = useState('')
  const [locked, setLocked] = useState(false)
  return <section className="panel"><p className="kicker">Одновременный ответ</p><p className="hint">{match.numericQuestion.prompt}</p><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><form className="guess-form" onSubmit={(event) => { event.preventDefault(); const parsed = Number(value.replace(',', '.')); if (!Number.isFinite(parsed)) return; setLocked(true); onAnswer(parsed) }}><input value={value} onChange={(event) => setValue(event.target.value)} disabled={locked} inputMode="decimal" placeholder="Твоё число" aria-label="Числовой ответ" /><button type="submit" disabled={locked}>{locked ? 'Принято' : 'Ответить'}</button></form><p className="hint">Сравнивается только абсолютное отклонение, без бонуса за скорость.</p></section>
}

function BotWaiting({ remainingMs }: { remainingMs: number }) { return <section className="panel"><p className="kicker">Одновременный ответ</p><TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} /><p className="hint">Боты отвечают…</p></section> }

function ResultsScreen({ scores, arena, onAgain }: { scores: Record<PlayerId, number>; arena: ArenaCell[]; onAgain: () => void }) {
  const territory = PLAYER_IDS.map((id) => ({ id, count: arena.filter((cell) => cell.owner === id).length })).sort((a, b) => b.count - a.count)
  return <section className="panel"><p className="kicker">Матч завершён</p><h2>Победитель: {PLAYER_BY_ID[territory[0].id].name}</h2><ol className="rank-list">{territory.map((row) => <li key={row.id} style={{ ['--accent' as string]: PLAYER_BY_ID[row.id].accent }}><span className="rank-place">{row.count}</span><span>{PLAYER_BY_ID[row.id].name}</span><span>{scores[row.id]} очков</span></li>)}</ol><button type="button" className="primary" onClick={onAgain}>Новая игра</button></section>
}

function MenuScreen({ notice, onStart, onStub }: { notice: string; onStart: () => void; onStub: (label: string) => void }) {
  return <section className="panel hero menu-panel"><div className="hero-copy"><p className="kicker">Главное меню</p><h2>Завоевание и битва</h2><p className="lede">Сначала расширь территорию правильными ответами, затем сражайся за границы.</p><div className="menu-actions"><button type="button" className="mode-button is-locked" onClick={() => onStub('Рейтинговая игра')}><span>Рейтинговая игра</span><small>Скоро</small></button><button type="button" className="mode-button is-primary" onClick={onStart}><span>Игра с ботами</span><small>Играть</small></button><button type="button" className="mode-button is-locked" onClick={() => onStub('Игра с друзьями')}><span>Игра с друзьями</span><small>Скоро</small></button></div>{notice ? <p className="menu-notice">{notice}</p> : null}</div><img className="hero-art" src={heroArena} alt="" aria-hidden="true" /></section>
}
