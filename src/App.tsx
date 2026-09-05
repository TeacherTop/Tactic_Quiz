import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import heroArena from './assets/hero.png'
import { ArenaGrid } from './components/ArenaGrid'
import { PlayerDock } from './components/PlayerDock'
import { TimerRing } from './components/TimerRing'
import { NUMERIC_QUESTIONS, QUIZ_QUESTIONS } from './data/questions'
import { captureCell, cellKey, createArena, getAvailableCells } from './game/arena'
import { botAnswerDelayMs, botNumericGuess, botQuizChoice } from './game/bots'
import {
  addScores,
  emptyGuesses,
  emptyScores,
  formatNumber,
  NUMERIC_TIME_MS,
  numericAward,
  pickRandom,
  QUIZ_PER_MATCH,
  QUIZ_TIME_MS,
  quizAward,
  rankNumericGuesses,
} from './game/engine'
import { PLAYER_BY_ID, PLAYERS } from './game/players'
import type { ArenaCell, Guess, NumericQuestion, PlayerId, QuizQuestion } from './game/types'
import { useCountdown } from './hooks/useCountdown'
import './styles.css'

type Phase = 'home' | 'numeric' | 'numeric-reveal' | 'quiz' | 'quiz-reveal' | 'results'

type Match = {
  scores: Record<PlayerId, number>
  arena: ArenaCell[]
  pendingCapture: PlayerId | null
  lastCapturedKey: string | null
  numericStartedAt: number
  numeric: NumericQuestion
  guesses: Record<PlayerId, Guess>
  ranking: PlayerId[]
  quiz: QuizQuestion[]
  quizIndex: number
  turnOrder: PlayerId[]
  turnIndex: number
  quizPicks: Record<PlayerId, number | null>
  quizRemain: Record<PlayerId, number>
  answered: Record<PlayerId, boolean>
}

type State = {
  phase: Phase
  match: Match | null
}

type Action =
  | { type: 'start'; startedAt: number }
  | { type: 'exit' }
  | { type: 'lock-numeric'; value: number; timeMs: number }
  | { type: 'finish-numeric' }
  | { type: 'capture-cell'; row: number; col: number }
  | { type: 'begin-quiz' }
  | { type: 'lock-quiz'; id: PlayerId; pick: number | null; remain: number }
  | { type: 'timeout-quiz' }
  | { type: 'next-after-quiz' }

function blankAnswers(): Record<PlayerId, boolean> {
  return { you: false, alex: false, marina: false }
}

function createMatch(startedAt: number): Match {
  const numeric = pickRandom(NUMERIC_QUESTIONS, 1)[0]
  const guesses = emptyGuesses()
  for (const p of PLAYERS) {
    if (p.kind !== 'bot') continue
    guesses[p.id] = {
      value: botNumericGuess(numeric.answer, p.skill),
      timeMs: botAnswerDelayMs(p.skill, NUMERIC_TIME_MS),
    }
  }
  return {
    scores: emptyScores(),
    arena: createArena(),
    pendingCapture: null,
    lastCapturedKey: null,
    numericStartedAt: startedAt,
    numeric,
    guesses,
    ranking: [],
    quiz: pickRandom(QUIZ_QUESTIONS, QUIZ_PER_MATCH),
    quizIndex: 0,
    turnOrder: ['you', 'alex', 'marina'],
    turnIndex: 0,
    quizPicks: { you: null, alex: null, marina: null },
    quizRemain: { you: 0, alex: 0, marina: 0 },
    answered: blankAnswers(),
  }
}

function applyQuizLock(match: Match, id: PlayerId, pick: number | null, remain: number): Match {
  if (match.answered[id]) return match
  const next: Match = {
    ...match,
    answered: { ...match.answered, [id]: true },
    quizPicks: { ...match.quizPicks, [id]: pick },
    quizRemain: { ...match.quizRemain, [id]: remain },
    turnIndex: match.turnIndex + 1,
  }
  return next
}

function scoreQuizIfComplete(match: Match): { match: Match; phase: Phase } {
  if (match.turnIndex < match.turnOrder.length) return { match, phase: 'quiz' }
  const q = match.quiz[match.quizIndex]
  const delta: Partial<Record<PlayerId, number>> = {}
  for (const p of PLAYERS) {
    delta[p.id] = quizAward(match.quizPicks[p.id] === q.correctIndex, match.quizRemain[p.id])
  }
  return { match: { ...match, scores: addScores(match.scores, delta) }, phase: 'quiz-reveal' }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'start':
      return { phase: 'numeric', match: createMatch(action.startedAt) }
    case 'exit':
      return { phase: 'home', match: null }
    case 'lock-numeric': {
      if (!state.match || state.phase !== 'numeric') return state
      if (state.match.guesses.you.timeMs !== null) return state
      return {
        ...state,
        match: {
          ...state.match,
          guesses: {
            ...state.match.guesses,
            you: { value: action.value, timeMs: action.timeMs },
          },
        },
      }
    }
    case 'finish-numeric': {
      if (!state.match || state.phase !== 'numeric') return state
      const ranking = rankNumericGuesses(state.match.numeric.answer, state.match.guesses)
      const captureOwner = ranking[0]?.id
      const delta: Partial<Record<PlayerId, number>> = {}
      ranking.forEach((row, index) => {
        delta[row.id] = numericAward(index, row.distance === null)
      })

      let arena = state.match.arena
      let pendingCapture: PlayerId | null = null
      let lastCapturedKey: string | null = null
      if (captureOwner === 'you') {
        pendingCapture = captureOwner
      } else if (captureOwner) {
        const botTarget = [...getAvailableCells(arena, captureOwner)][0]
        if (botTarget) {
          const [row, col] = botTarget.split(':').map(Number)
          arena = captureCell(arena, captureOwner, row, col)
          lastCapturedKey = botTarget
        }
      }

      return {
        phase: 'numeric-reveal',
        match: {
          ...state.match,
          arena,
          ranking: ranking.map((r) => r.id),
          scores: addScores(state.match.scores, delta),
          turnOrder: ranking.map((r) => r.id),
          pendingCapture,
          lastCapturedKey,
        },
      }
    }
    case 'capture-cell': {
      if (!state.match || state.phase !== 'numeric-reveal' || !state.match.pendingCapture) return state
      const arena = captureCell(
        state.match.arena,
        state.match.pendingCapture,
        action.row,
        action.col,
      )
      if (arena === state.match.arena) return state
      return {
        ...state,
        match: {
          ...state.match,
          arena,
          pendingCapture: null,
          lastCapturedKey: cellKey(action.row, action.col),
        },
      }
    }
    case 'begin-quiz': {
      if (!state.match || state.match.pendingCapture) return state
      return {
        phase: 'quiz',
        match: {
          ...state.match,
          quizIndex: 0,
          turnIndex: 0,
          quizPicks: { you: null, alex: null, marina: null },
          quizRemain: { you: 0, alex: 0, marina: 0 },
          answered: blankAnswers(),
        },
      }
    }
    case 'lock-quiz': {
      if (!state.match || state.phase !== 'quiz') return state
      const actor = state.match.turnOrder[state.match.turnIndex]
      if (action.id !== actor) return state
      const locked = applyQuizLock(state.match, action.id, action.pick, action.remain)
      const next = scoreQuizIfComplete(locked)
      return { phase: next.phase, match: next.match }
    }
    case 'timeout-quiz': {
      if (!state.match || state.phase !== 'quiz') return state
      const id = state.match.turnOrder[state.match.turnIndex]
      const locked = applyQuizLock(state.match, id, null, 0)
      const next = scoreQuizIfComplete(locked)
      return { phase: next.phase, match: next.match }
    }
    case 'next-after-quiz': {
      if (!state.match) return state
      const nextIndex = state.match.quizIndex + 1
      if (nextIndex >= state.match.quiz.length) {
        return { phase: 'results', match: state.match }
      }
      return {
        phase: 'quiz',
        match: {
          ...state.match,
          quizIndex: nextIndex,
          turnIndex: 0,
          quizPicks: { you: null, alex: null, marina: null },
          quizRemain: { you: 0, alex: 0, marina: 0 },
          answered: blankAnswers(),
        },
      }
    }
    default:
      return state
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, { phase: 'home', match: null })
  const [menuNotice, setMenuNotice] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { phase, match } = state
  const startMatch = () => {
    setSettingsOpen(false)
    dispatch({ type: 'start', startedAt: performance.now() })
  }
  const exitGame = () => {
    setSettingsOpen(false)
    dispatch({ type: 'exit' })
  }
  const nowMs = useElapsedMs(phase === 'numeric', match?.numericStartedAt ?? 0)

  const numericLeft = useCountdown(
    phase === 'numeric',
    NUMERIC_TIME_MS,
    () => dispatch({ type: 'finish-numeric' }),
  )

  const quizTurnKey = match ? `${match.quizIndex}-${match.turnIndex}` : 'none'
  const quizLeft = useCountdown(
    phase === 'quiz',
    QUIZ_TIME_MS,
    () => dispatch({ type: 'timeout-quiz' }),
    quizTurnKey,
  )

  const currentTurn = match?.turnOrder[match.turnIndex] ?? null
  const humanTurn = phase === 'quiz' && currentTurn === 'you'

  useEffect(() => {
    if (phase !== 'quiz' || !match) return
    const actor = match.turnOrder[match.turnIndex]
    const player = PLAYER_BY_ID[actor]
    if (player.kind !== 'bot') return
    const q = match.quiz[match.quizIndex]
    const delay = botAnswerDelayMs(player.skill, QUIZ_TIME_MS)
    const id = window.setTimeout(() => {
      dispatch({
        type: 'lock-quiz',
        id: actor,
        pick: botQuizChoice(q.correctIndex, player.skill),
        remain: Math.max(0, QUIZ_TIME_MS - delay),
      })
    }, delay)
    return () => window.clearTimeout(id)
  }, [phase, match?.quizIndex, match?.turnIndex, match])

  const rankingRows = useMemo(() => {
    if (!match || phase === 'home') return []
    return rankNumericGuesses(match.numeric.answer, match.guesses)
  }, [match, phase])

  const lockedNumeric = match?.guesses.you.timeMs !== null

  const badges = useMemo(() => {
    const map: Partial<Record<PlayerId, string>> = {}
    if (!match) return map
    if (phase === 'numeric') {
      map.you = lockedNumeric ? 'ставка' : 'думает'
      for (const p of PLAYERS.filter((x) => x.kind === 'bot')) {
        map[p.id] = (match.guesses[p.id].timeMs ?? 9e9) <= nowMs ? 'ставка' : 'думает'
      }
    }
    if (phase === 'quiz' && currentTurn) map[currentTurn] = 'ходит'
    if (phase === 'numeric-reveal' && match.ranking[0]) map[match.ranking[0]] = 'ближе всех'
    return map
  }, [match, phase, lockedNumeric, nowMs, currentTurn])

  return (
    <div className="arena">
      <header className="topbar">
        <div>
          <p className="kicker">Арена</p>
          <h1>Ближе всех</h1>
        </div>
        {match && phase !== 'home' ? (
          <div className="topbar-tools">
            <PlayerDock
              scores={match.scores}
              highlight={phase === 'quiz' ? currentTurn : null}
              badges={badges}
            />
            <div className={`settings-menu${settingsOpen ? ' is-open' : ''}`}>
              <button
                type="button"
                className="settings-button"
                aria-label="Настройки"
                aria-expanded={settingsOpen}
                title="Настройки"
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm8.2 3.6c0-.5-.1-1-.2-1.5l2-1.5-2-3.4-2.4 1a9 9 0 0 0-2.6-1.5L14.7 2h-5.4L9 5.1a9 9 0 0 0-2.6 1.5l-2.4-1-2 3.4 2 1.5a8 8 0 0 0 0 3l-2 1.5 2 3.4 2.4-1A9 9 0 0 0 9 18.9l.3 3.1h5.4l.3-3.1a9 9 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5c.1-.5.2-1 .2-1.5Z" />
                </svg>
              </button>
              {settingsOpen ? (
                <div className="settings-popover">
                  <button type="button" className="exit-button" onClick={exitGame}>
                    Выйти из игры
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </header>

      <main className="stage">
        {phase === 'home' ? (
          <MenuScreen
            notice={menuNotice}
            onStartBots={startMatch}
            onStub={(label) => setMenuNotice(`${label} появится в следующем этапе.`)}
          />
        ) : null}

        {phase === 'numeric' && match ? (
          <NumericScreen
            prompt={match.numeric.prompt}
            remainingMs={numericLeft}
            locked={lockedNumeric}
            onSubmit={(value) =>
              dispatch({
                type: 'lock-numeric',
                value,
                timeMs: performance.now() - match.numericStartedAt,
              })
            }
          />
        ) : null}

        {phase !== 'home' && match ? (
          <ArenaGrid
            cells={match.arena}
            activePlayer={phase === 'numeric-reveal' ? match.pendingCapture : null}
            lastCapturedKey={match.lastCapturedKey}
            onCapture={(row, col) => dispatch({ type: 'capture-cell', row, col })}
          />
        ) : null}

        {phase === 'numeric-reveal' && match ? (
          <section className="panel">
            <p className="kicker">Раскрытие</p>
            <h2>Правильный ответ: {formatNumber(match.numeric.answer)}</h2>
            {match.numeric.unit ? <p className="hint">Единица ответа: {match.numeric.unit}</p> : null}
            <ol className="rank-list">
              {rankingRows.map((row, i) => {
                const player = PLAYER_BY_ID[row.id]
                return (
                  <li key={row.id} style={{ ['--accent' as string]: player.accent }}>
                    <span className="rank-place">{i + 1}</span>
                    <span>{player.name}</span>
                    <span className="rank-guess">
                      {row.distance === null
                        ? 'нет ставки'
                        : formatNumber(match.guesses[row.id].value ?? 0)}
                    </span>
                    <span className="rank-delta">
                      {row.distance === null ? '—' : `Δ ${formatNumber(row.distance)}`}
                    </span>
                    <span className="rank-pts">+{numericAward(i, row.distance === null)}</span>
                  </li>
                )
              })}
            </ol>
            <p className="hint">
              {match.pendingCapture
                ? `${PLAYER_BY_ID[match.pendingCapture].name} захватывает соседнюю клетку на арене.`
                : 'Клетка захвачена. Можно переходить к вопросам.'}
            </p>
            <button
              type="button"
              className="primary"
              disabled={Boolean(match.pendingCapture)}
              onClick={() => dispatch({ type: 'begin-quiz' })}
            >
              К вопросам · первым ходит {PLAYER_BY_ID[match.ranking[0]]?.name}
            </button>
          </section>
        ) : null}

        {phase === 'quiz' && match ? (
          <QuizBoard
            match={match}
            remainingMs={quizLeft}
            currentTurn={currentTurn}
            humanTurn={humanTurn}
            onChoose={(index) =>
              dispatch({ type: 'lock-quiz', id: 'you', pick: index, remain: quizLeft })
            }
          />
        ) : null}

        {phase === 'quiz-reveal' && match ? (
          <QuizReveal match={match} onNext={() => dispatch({ type: 'next-after-quiz' })} />
        ) : null}

        {phase === 'results' && match ? (
          <ResultsScreen scores={match.scores} onAgain={startMatch} />
        ) : null}
      </main>
    </div>
  )
}

function useElapsedMs(active: boolean, startedAt: number) {
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    if (!active) return
    let frame = 0
    const tick = () => {
      setElapsedMs(Math.max(0, performance.now() - startedAt))
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [active, startedAt])
  if (!active) return 0
  return elapsedMs
}

function parseGuess(raw: string): number | null {
  const normalized = raw.replace(/\s/g, '').replace(',', '.')
  if (!normalized) return null
  const n = Number(normalized)
  if (!Number.isFinite(n)) return null
  return n
}

function MenuScreen({
  notice,
  onStartBots,
  onStub,
}: {
  notice: string
  onStartBots: () => void
  onStub: (label: string) => void
}) {
  return (
    <section className="panel hero menu-panel">
      <button
        type="button"
        className="settings-button"
        aria-label="Настройки"
        title="Настройки"
        onClick={() => onStub('Настройки')}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm8.2 3.6c0-.5-.1-1-.2-1.5l2-1.5-2-3.4-2.4 1a9 9 0 0 0-2.6-1.5L14.7 2h-5.4L9 5.1a9 9 0 0 0-2.6 1.5l-2.4-1-2 3.4 2 1.5a8 8 0 0 0 0 3l-2 1.5 2 3.4 2.4-1A9 9 0 0 0 9 18.9l.3 3.1h5.4l.3-3.1a9 9 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5c.1-.5.2-1 .2-1.5Z" />
        </svg>
      </button>
      <div className="hero-copy">
        <p className="kicker">Главное меню</p>
        <h2>Выбери режим викторины</h2>
        <p className="lede">
          Числовой раунд решает, кто ближе к правде, а затем открывает очередь в квизе.
        </p>
        <div className="menu-actions" aria-label="Режимы игры">
          <button type="button" className="mode-button is-locked" onClick={() => onStub('Рейтинговая игра')}>
            <span>Рейтинговая игра</span>
            <small>Скоро</small>
          </button>
          <button type="button" className="mode-button is-primary" onClick={onStartBots}>
            <span>Игра с ботами</span>
            <small>Играть</small>
          </button>
          <button type="button" className="mode-button is-locked" onClick={() => onStub('Игра с друзьями')}>
            <span>Игра с друзьями</span>
            <small>Скоро</small>
          </button>
        </div>
        {notice ? <p className="menu-notice">{notice}</p> : null}
      </div>
      <img className="hero-art" src={heroArena} alt="" aria-hidden="true" />
    </section>
  )
}

function NumericScreen({
  prompt,
  remainingMs,
  locked,
  onSubmit,
}: {
  prompt: string
  remainingMs: number
  locked: boolean
  onSubmit: (value: number) => void
}) {
  const draft = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  return (
    <section className="panel">
      <p className="kicker">Числовой раунд · кто ближе, тот лучше</p>
      <h2>{prompt}</h2>
      <TimerRing remainingMs={remainingMs} totalMs={NUMERIC_TIME_MS} />
      <form
        className="guess-form"
        onSubmit={(e) => {
          e.preventDefault()
          const parsed = parseGuess(draft.current?.value ?? '')
          if (parsed === null) {
            setError('Введи числовую ставку. Пустой ответ не засчитывается.')
            return
          }
          setError('')
          onSubmit(parsed)
        }}
      >
        <input
          ref={draft}
          inputMode="decimal"
          autoFocus
          disabled={locked}
          placeholder="Твоё число"
          aria-label="Числовой ответ"
          aria-invalid={error ? 'true' : 'false'}
          onChange={() => setError('')}
        />
        <button type="submit" disabled={locked}>
          {locked ? 'Принято' : 'Поставить'}
        </button>
      </form>
      <p className="hint">
        {error ||
          (locked
          ? 'Ждём остальных. Победит тот, чья ставка ближе к правде.'
          : 'Боты уже думают. Чем меньше ошибка — тем выше место.')}
      </p>
    </section>
  )
}

function QuizBoard({
  match,
  remainingMs,
  currentTurn,
  humanTurn,
  onChoose,
}: {
  match: Match
  remainingMs: number
  currentTurn: PlayerId | null
  humanTurn: boolean
  onChoose: (index: number) => void
}) {
  const q = match.quiz[match.quizIndex]
  const actor = currentTurn ? PLAYER_BY_ID[currentTurn] : null
  return (
    <section className="panel">
      <p className="kicker">
        Вопрос {match.quizIndex + 1} из {match.quiz.length}
        {actor ? ` · ход: ${actor.name}` : ''}
      </p>
      <h2>{q.prompt}</h2>
      <TimerRing remainingMs={remainingMs} totalMs={QUIZ_TIME_MS} />
      <div className="options">
        {q.options.map((opt, i) => (
          <button
            key={opt}
            type="button"
            className="option"
            disabled={!humanTurn}
            onClick={() => onChoose(i)}
          >
            <span className="opt-key">{['А', 'Б', 'В', 'Г'][i]}</span>
            {opt}
          </button>
        ))}
      </div>
      {!humanTurn ? (
        <p className="hint">{actor?.name} выбирает вариант…</p>
      ) : (
        <p className="hint">Выбери ответ. Быстрее — больше очков.</p>
      )}
    </section>
  )
}

function QuizReveal({ match, onNext }: { match: Match; onNext: () => void }) {
  const q = match.quiz[match.quizIndex]
  const last = match.quizIndex + 1 >= match.quiz.length
  return (
    <section className="panel">
      <p className="kicker">Ответ</p>
      <h2>{q.options[q.correctIndex]}</h2>
      <ul className="reveal-list">
        {PLAYERS.map((p) => {
          const pick = match.quizPicks[p.id]
          const ok = pick === q.correctIndex
          const points = quizAward(ok, match.quizRemain[p.id])
          return (
            <li key={p.id} style={{ ['--accent' as string]: p.accent }}>
              <span>{p.name}</span>
              <span>{pick === null ? 'время вышло' : q.options[pick]}</span>
              <span className={ok ? 'ok' : 'miss'}>{ok ? 'верно' : 'мимо'}</span>
              <span className="reveal-points">+{points}</span>
            </li>
          )
        })}
      </ul>
      <button type="button" className="primary" onClick={onNext}>
        {last ? 'Итоги' : 'Дальше'}
      </button>
    </section>
  )
}

function ResultsScreen({
  scores,
  onAgain,
}: {
  scores: Record<PlayerId, number>
  onAgain: () => void
}) {
  const order = [...PLAYERS].sort((a, b) => scores[b.id] - scores[a.id])
  const winner = order[0]
  return (
    <section className="panel">
      <p className="kicker">Финиш</p>
      <h2>{winner.id === 'you' ? 'Ты выиграл арену' : `${winner.name} сильнее в этот раз`}</h2>
      <ol className="rank-list">
        {order.map((p, i) => (
          <li key={p.id} style={{ ['--accent' as string]: p.accent }}>
            <span className="rank-place">{i + 1}</span>
            <span>{p.name}</span>
            <span className="rank-pts">{scores[p.id]}</span>
          </li>
        ))}
      </ol>
      <button type="button" className="primary" onClick={onAgain}>
        Ещё партия
      </button>
    </section>
  )
}
