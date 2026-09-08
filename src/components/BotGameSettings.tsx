import { useEffect, useState } from 'react'
import type { BotSettings } from '../game/botSettings'

export type TopicOption = { name: string; count: number }
function topicBadge(name: string) {
  if (/знаменит/i.test(name)) return 'Персоны'
  if (/математ/i.test(name)) return 'Числа'
  if (/технолог/i.test(name)) return 'Изобретения'
  if (/истор/i.test(name)) return 'Летопись'
  if (/географ|стран|мир/i.test(name)) return 'Атлас'
  if (/наук|физик|хими/i.test(name)) return 'Открытия'
  if (/литерат|книг/i.test(name)) return 'Книги'
  if (/кино|фильм/i.test(name)) return 'Экран'
  if (/музык/i.test(name)) return 'Мелодии'
  if (/спорт/i.test(name)) return 'Рекорды'
  if (/природ|живот|биолог/i.test(name)) return 'Природа'
  if (/искусств|культур/i.test(name)) return 'Шедевры'
  return 'Знания'
}
export function BotGameSettings({ settings, topics, onChange, onStart, onBack }: {
  settings: BotSettings; topics: TopicOption[]; onChange: (settings: BotSettings) => void; onStart: () => void; onBack: () => void
}) {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(() => window.innerWidth <= 700 && window.innerHeight < 620 ? 2 : 4)
  useEffect(() => {
    const resize = () => { setPageSize(window.innerWidth <= 700 && window.innerHeight < 620 ? 2 : 4); setPage(0) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const total = topics.filter(t => settings.categories.includes(t.name)).reduce((sum, t) => sum + t.count, 0)
  const pageCount = Math.ceil(topics.length / pageSize)
  return <section className="bot-settings-screen">
    <header className="bot-settings-header"><button type="button" className="stats-back" onClick={onBack}>← Главное меню</button><p className="kicker">Твоя партия · твои правила</p><h2>Настройки игры с ботами</h2></header>
    <div className="bot-settings-groups">
      <section className="bot-settings-group"><h3 className="wood-heading"><span aria-hidden="true">01</span> СОПЕРНИКИ</h3>
        <fieldset><legend>Уровень ботов</legend><div className="setting-segments">{([['easy', 'Легкий'], ['medium', 'Средний'], ['hard', 'Хардкор']] as const).map(([value, label]) => <label key={value}><input type="radio" name="bot-difficulty" checked={settings.difficulty === value} onChange={() => onChange({ ...settings, difficulty: value })} /><span>{label}</span></label>)}</div></fieldset>
        <fieldset><legend>Количество</legend><div className="setting-segments">{([1, 2] as const).map(value => <label key={value}><input type="radio" name="bot-opponents" checked={settings.opponents === value} onChange={() => onChange({ ...settings, opponents: value })} /><span>{value} {value === 1 ? 'соперник' : 'соперника'}</span></label>)}</div></fieldset>
      </section>
      <section className="bot-settings-group"><h3 className="wood-heading"><span aria-hidden="true">02</span> КАРТА</h3><fieldset><legend>Размер арены</legend><div className="setting-segments arena-size-segments">{([7, 19, 37] as const).map(value => <label key={value}><input type="radio" name="bot-arena" checked={settings.arenaSize === value} onChange={() => onChange({ ...settings, arenaSize: value })} /><span><b aria-hidden="true">⬡</b>{value} сот</span></label>)}</div></fieldset></section>
      <section className="bot-settings-group bot-topics-group"><h3 className="wood-heading"><span aria-hidden="true">03</span> ТЕМЫ ВОПРОСОВ</h3><div className="topic-selection-actions"><button type="button" onClick={() => onChange({ ...settings, categories: topics.map(t => t.name) })}>Выбрать все</button><button type="button" onClick={() => onChange({ ...settings, categories: [] })}>Сбросить</button></div>
        <div className="bot-topic-list">{topics.slice(page * pageSize, (page + 1) * pageSize).map(topic => <label className="bot-topic" key={topic.name}><input type="checkbox" checked={settings.categories.includes(topic.name)} onChange={event => onChange({ ...settings, categories: event.target.checked ? [...settings.categories, topic.name] : settings.categories.filter(c => c !== topic.name) })} /><span className="bot-topic-name">{topic.name}<small>{topic.count} вопросов</small></span><span className="topic-badge">{topicBadge(topic.name)}</span></label>)}</div>
        {!topics.length && <p className="hint">Банк вопросов пока пуст.</p>}
        {pageCount > 1 && <nav className="topic-pagination" aria-label="Страницы тем"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>←</button><span>{page + 1} / {pageCount}</span><button type="button" disabled={page + 1 === pageCount} onClick={() => setPage(page + 1)}>→</button></nav>}
      </section>
    </div>
    <footer className="bot-settings-footer"><p aria-live="polite">{total ? `${total} вопросов · ${settings.arenaSize} сот · ${settings.opponents === 1 ? 'один соперник' : 'два соперника'}` : 'Выбери хотя бы одну тему для игры'}</p><button type="button" className="primary" disabled={!total} onClick={onStart}>НАЧАТЬ ИГРУ</button></footer>
  </section>
}
