import { useEffect, useRef, useState } from 'react'
import { getTelegramInitData } from '../telegram'
import type { JeopardyQuestion, JeopardyVerdict } from '../../shared/jeopardy'

const STORAGE = 'jeopardy-solo-v1'
const API = import.meta.env.VITE_MULTIPLAYER_API_URL ?? 'http://127.0.0.1:4000'
type Progress = { seen: string[]; correct: number; streak: number; best: number }
const fresh = (): Progress => ({ seen: [], correct: 0, streak: 0, best: 0 })
function readProgress(): Progress {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE) ?? 'null')
    if (!value || !Array.isArray(value.seen) || !value.seen.every((id: unknown) => typeof id === 'string')) return fresh()
    if (![value.correct, value.streak, value.best].every(n => Number.isInteger(n) && n >= 0)) return fresh()
    return { seen: [...new Set<string>(value.seen)].slice(0, 40000), correct: value.correct, streak: value.streak, best: value.best }
  } catch { return fresh() }
}
function TextPages({ text, limit = 200 }: { text: string; limit?: number }) {
  const [page, setPage] = useState(0)
  const pages = text.match(new RegExp(`.{1,${limit}}(?:\\s|$)|\\S{1,${limit}}`, 'gs')) ?? [text]
  return <div className="jeopardy-text-pages"><p>{pages[Math.min(page, pages.length - 1)]}</p>{pages.length > 1 && <nav aria-label="Части текста"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Предыдущая часть">←</button><span>{page + 1} / {pages.length}</span><button type="button" disabled={page === pages.length - 1} onClick={() => setPage(page + 1)} aria-label="Следующая часть">→</button></nav>}</div>
}
export function JeopardySolo({ onExit }: { onExit: () => void }) {
  const [progress, setProgress] = useState(readProgress)
  const [question, setQuestion] = useState<JeopardyQuestion | null>(null)
  const [total, setTotal] = useState(0)
  const [answer, setAnswer] = useState('')
  const [result, setResult] = useState<JeopardyVerdict | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [compact, setCompact] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const inFlight = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const done = result !== null && result.verdict !== 'clarify'

  async function request<T>(path: string, body: object): Promise<T> {
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    const timer = window.setTimeout(() => abort.abort(), 25000)
    try {
      const response = await fetch(`${API}/api/solo/${path}`, { method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, initData: getTelegramInitData() }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'Не удалось выполнить запрос.')
      return data as T
    } finally { window.clearTimeout(timer) }
  }
  async function next(current = progress) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setError('')
    try {
      const data = await request<{ question: JeopardyQuestion | null; total: number; judgeReady: boolean }>('question', { seen: current.seen })
      setQuestion(data.question); setTotal(data.total); setReady(data.judgeReady); setLoaded(true)
      setAnswer(''); setResult(null)
    } catch (e) { setError(e instanceof Error && e.name !== 'AbortError' ? e.message : 'Нет связи с сервером. Попробуй ещё раз.') }
    finally { inFlight.current = false; setBusy(false) }
  }
  useEffect(() => {
    const initialLoad = window.setTimeout(() => void next(readProgress()), 0)
    const resize = () => { const height = window.visualViewport?.height ?? window.innerHeight; document.documentElement.style.setProperty('--solo-viewport', `${height}px`); setCompact(height < 600) }
    resize()
    window.visualViewport?.addEventListener('resize', resize)
    return () => { window.clearTimeout(initialLoad); controller.current?.abort(); window.visualViewport?.removeEventListener('resize', resize); document.documentElement.style.removeProperty('--solo-viewport') }
    // The first question is loaded once. Further loads use explicit, current progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit(skip = false) {
    if (!question || inFlight.current || done || (!skip && !answer.trim())) return
    inFlight.current = true; setBusy(true); setError(''); input.current?.blur()
    try {
      const verdict = await request<JeopardyVerdict>('answer', { questionId: question.id, answer, skip })
      setResult(verdict)
      if (verdict.verdict !== 'clarify' && !progress.seen.includes(question.id)) {
        const streak = verdict.verdict === 'correct' ? progress.streak + 1 : 0
        const updated = { seen: [...progress.seen, question.id], correct: progress.correct + Number(verdict.verdict === 'correct'), streak, best: Math.max(streak, progress.best) }
        setProgress(updated)
        try { localStorage.setItem(STORAGE, JSON.stringify(updated)) } catch { /* Play remains available without local storage. */ }
      }
    } catch (e) { setError(e instanceof Error && e.name !== 'AbortError' ? e.message : 'Проверка не завершилась. Ответ сохранён, можно повторить.') }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <section className="solo-screen jeopardy-screen">
    <div className="jeopardy-top"><button type="button" className="solo-exit" onClick={onExit}>← Главное меню</button><span>Своя игра · соло</span></div>
    <header className="solo-hud"><div className="solo-progress"><span>Верно {progress.correct} из {progress.seen.length}</span><i><b style={{ width: `${progress.seen.length ? progress.correct / progress.seen.length * 100 : 0}%` }} /></i></div><div className="solo-streak">Серия {progress.streak} · рекорд {progress.best}</div></header>
    <section className="panel jeopardy-card" aria-busy={busy}>
      {question ? <>
        <div className="jeopardy-meta"><p className="kicker">Вопрос {progress.seen.length + (done ? 0 : 1)} / {total.toLocaleString('ru')}</p><p className="solo-category">{question.topic}</p></div>
        <div className="jeopardy-question"><TextPages key={`${question.id}-${Boolean(result)}-${compact}`} limit={compact ? result ? 90 : 150 : result ? 140 : 240} text={question.question} /></div>
        {result && <div className={`jeopardy-verdict verdict-${result.verdict}`} role="status"><strong>{({ correct: 'Верно!', incorrect: 'Не в этот раз', clarify: 'Уточни ответ', skipped: 'Ответ на вопрос' })[result.verdict]}</strong><TextPages key={`${question.id}-${result.verdict}-${compact}`} limit={compact ? 100 : 180} text={result.answer ? `${result.answer}\n${result.explanation}` : result.explanation} /></div>}
        {!done ? <form className="jeopardy-form" onSubmit={event => { event.preventDefault(); void submit() }}><label htmlFor="jeopardy-answer">Твой ответ</label><input ref={input} id="jeopardy-answer" autoComplete="off" maxLength={300} value={answer} disabled={busy} onChange={event => setAnswer(event.target.value)} placeholder="Вспомни и напиши…" /><div className="jeopardy-actions"><button type="button" disabled={busy} onClick={() => void submit(true)}>Не знаю</button><button className="primary" type="submit" disabled={busy || !answer.trim()}>{busy ? 'Проверяем…' : result?.verdict === 'clarify' ? 'Уточнить' : 'Ответить'}</button></div></form> : <button type="button" className="primary solo-next" disabled={busy} onClick={() => void next()}>{busy ? 'Загружаем…' : 'Следующий вопрос →'}</button>}
        {!ready && !done && <p className="hint">Проверка по смыслу пока не подключена. Доступны точный ответ и «Не знаю».</p>}
      </> : <div className="jeopardy-empty"><p className="kicker">Своя игра</p><h2>{busy ? 'Готовим вопрос…' : loaded ? 'Весь банк пройден!' : 'Начнём игру'}</h2>{loaded && !busy && <p>Верных ответов: {progress.correct}. Лучшая серия: {progress.best}.</p>}{!busy && <button className="primary" onClick={() => { if (loaded) { const reset = fresh(); setProgress(reset); try { localStorage.setItem(STORAGE, JSON.stringify(reset)) } catch { /* optional */ } void next(reset) } else void next() }}>{loaded ? 'Пройти заново' : 'Загрузить вопрос'}</button>}</div>}
      {error && <p className="jeopardy-error" role="alert">{error}</p>}
    </section>
  </section>
}
