import 'dotenv/config'
import http from 'node:http'
import cors from 'cors'
import express from 'express'
import { Server } from 'socket.io'
import { z } from 'zod'
import { GameRoomStore } from './gameRoomStore'
import { verifyTelegramInitData } from './telegramAuth'
import type { ClientToServerEvents, MultiplayerGameState, ServerToClientEvents, TelegramUser } from '../shared/multiplayer'

const PORT = Number(process.env.PORT ?? 4000)
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ?? 'http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
const DEV_AUTH = process.env.NODE_ENV === 'test' || process.env.ALLOW_DEV_AUTH === 'true'
const RATE_LIMIT_PER_SECOND = 10

const initDataSchema = z.object({ initData: z.string().default('') })
const joinRoomSchema = initDataSchema.extend({ roomCode: z.string().regex(/^\d{6}$/) })
type SocketData = {
  roomId?: string
  playerId?: string
}

const app = express()
const server = http.createServer(app)
const store = new GameRoomStore()
const actionBuckets = new Map<string, { startedAt: number; count: number }>()
const scheduledBotTurns = new Set<string>()
const corsOrigin: cors.CorsOptions['origin'] = (origin, callback) => {
  if (!origin || CLIENT_ORIGINS.includes(origin) || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
    callback(null, true)
    return
  }
  callback(new Error('Origin is not allowed by CORS'))
}

export const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(server, {
  cors: { origin: corsOrigin, credentials: true },
})

app.use(cors({ origin: corsOrigin, credentials: true }))
app.use(express.json({ limit: '512kb' }))

function log(roomId: string, message: string): void {
  const entry = { roomId, message, at: Date.now() }
  console.info(`[room:${roomId}] ${message}`)
  io.to(roomId).emit('room_log', entry)
}

function devUser(seed = 'Игрок'): TelegramUser {
  const safeSeed = seed.trim() || 'Игрок'
  let hash = 0
  for (const char of safeSeed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return {
    id: Number(process.env.DEV_TELEGRAM_ID ?? 100000) + hash,
    first_name: safeSeed.slice(0, 24),
  }
}

function authenticate(initData: string, devSeed?: unknown): TelegramUser {
  if (DEV_AUTH && !initData) return devUser(typeof devSeed === 'string' ? devSeed : process.env.DEV_TELEGRAM_NAME)
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured')
  return verifyTelegramInitData(initData, token).user
}

function publicState(state: MultiplayerGameState): MultiplayerGameState {
  return { ...state, answers: {} }
}

function emitState(state: MultiplayerGameState): void {
  io.to(state.roomId).emit('state_update', publicState(state))
  schedulePhaseTimer(state)
  scheduleBotTurn(state)
}

function schedulePhaseTimer(state: MultiplayerGameState): void {
  if (!state.timerEndsAt) return
  const delay = Math.max(0, state.timerEndsAt - Date.now())
  setTimeout(() => {
    const current = store.getRoomById(state.roomId)
    if (!current || current.timerEndsAt !== state.timerEndsAt || current.phase !== state.phase) return
    if (current.phase === 'expansion') {
      const reviewed = store.finishAnswering(current.roomId)
      log(reviewed.roomId, `Раунд ${reviewed.round}: ответы закрыты`)
      emitState(reviewed)
      return
    }
    if (current.phase === 'expansion-review') {
      const capture = store.beginCapture(current.roomId)
      log(capture.roomId, capture.activePlayerId ? `Ход захвата: ${capture.activePlayerId}` : 'Захват завершен')
      emitState(capture)
      return
    }
    if (current.phase === 'battle-number') {
      const next = store.finishAnswering(current.roomId)
      log(next.roomId, `Битва ${next.battleRound}: числовые ответы закрыты`)
      emitState(next)
    }
  }, delay)
}

function scheduleBotTurn(state: MultiplayerGameState): void {
  if (!state.activePlayerId) return
  const active = state.players.find((player) => player.id === state.activePlayerId)
  if (active?.status !== 'bot') return
  const key = `${state.roomId}:${state.phase}:${state.activePlayerId}:${state.updatedAt}`
  if (scheduledBotTurns.has(key)) return
  scheduledBotTurns.add(key)
  setTimeout(() => {
    const current = store.getRoomById(state.roomId)
    if (!current || current.activePlayerId !== state.activePlayerId || current.phase !== state.phase) return
    const activePlayerId = current.activePlayerId
    if (!activePlayerId) return
    const targetKey = current.availableHexes[0]
    if (!targetKey) return
    const [row, col] = targetKey.split(':').map(Number)
    const next = current.phase === 'battle-select'
      ? store.chooseAttack(current.roomId, activePlayerId, row, col)
      : store.selectHex(current.roomId, activePlayerId, row, col)
    log(next.roomId, `Бот ${active.name} сделал ход ${row}:${col}`)
    emitState(next)
  }, 700)
}

function rateLimit(socketId: string): void {
  const now = Date.now()
  const bucket = actionBuckets.get(socketId)
  if (!bucket || now - bucket.startedAt >= 1000) {
    actionBuckets.set(socketId, { startedAt: now, count: 1 })
    return
  }
  bucket.count += 1
  if (bucket.count > RATE_LIMIT_PER_SECOND) throw new Error('Слишком много действий в секунду')
}

function acknowledge<T>(ack: ((response: { ok: true; data: T } | { ok: false; error: string }) => void) | undefined, work: () => T): void {
  try {
    ack?.({ ok: true, data: work() })
  } catch (error) {
    ack?.({ ok: false, error: error instanceof Error ? error.message : 'Неизвестная ошибка' })
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/create-room', (req, res) => {
  try {
    if (!store.hasQuestions()) throw new Error('Банк вопросов для игры с друзьями ещё не подключён.')
    const { initData } = initDataSchema.parse(req.body)
    const created = store.createRoom(authenticate(initData, req.query.devUser))
    log(created.state.roomId, `Создана комната ${created.state.roomCode}`)
    res.json({ roomCode: created.state.roomCode, playerId: created.playerId, state: publicState(created.state) })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось создать комнату' })
  }
})

app.post('/api/join-room', (req, res) => {
  try {
    const { roomCode, initData } = joinRoomSchema.parse(req.body)
    const joined = store.joinRoom(roomCode, authenticate(initData, req.query.devUser), null)
    log(joined.state.roomId, `Игрок вошел по коду ${roomCode}`)
    res.json({ playerId: joined.playerId, state: publicState(joined.state) })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось войти в комнату' })
  }
})

io.on('connection', (socket) => {
  console.info(`[socket:${socket.id}] connected`)

  socket.on('join_room', (payload, ack) => {
    acknowledge(ack, () => {
      rateLimit(socket.id)
      const { roomCode, initData } = joinRoomSchema.parse(payload)
      const user = authenticate(initData, socket.handshake.query.devUser)
      const joined = store.joinRoom(roomCode, user, socket.id)
      socket.data.roomId = joined.state.roomId
      socket.data.playerId = joined.playerId
      socket.join(joined.state.roomId)
      log(joined.state.roomId, `${user.first_name} подключился`)
      emitState(joined.state)
      return { playerId: joined.playerId, state: publicState(joined.state) }
    })
  })

  socket.on('room_settings_updated', (payload, ack) => {
    acknowledge(ack, () => {
      rateLimit(socket.id)
      if (!socket.data.playerId) throw new Error('Игрок не привязан к комнате')
      const state = store.updateSettings(payload.roomId, socket.data.playerId, payload.settings)
      log(payload.roomId, `${socket.data.playerId} обновил настройки комнаты`)
      emitState(state)
    })
  })

  socket.on('game_started', (payload, ack) => {
    acknowledge(ack, () => {
      rateLimit(socket.id)
      if (!socket.data.playerId) throw new Error('Игрок не привязан к комнате')
      const state = store.startGame(payload.roomId, socket.data.playerId)
      log(payload.roomId, `Матч стартовал, раунд ${state.round}`)
      emitState(state)
    })
  })

  socket.on('answer_submitted', (payload, ack) => {
    acknowledge(ack, () => {
      rateLimit(socket.id)
      if (!socket.data.playerId) throw new Error('Игрок не привязан к комнате')
      const answer = Array.isArray(payload.answer) ? payload.answer[0] : payload.answer
      const state = store.submitAnswer(payload.roomId, socket.data.playerId, answer)
      log(payload.roomId, `${socket.data.playerId} отправил ответ`)
      emitState(state)
    })
  })

  socket.on('hex_selected', (payload, ack) => {
    acknowledge(ack, () => {
      rateLimit(socket.id)
      if (!socket.data.playerId) throw new Error('Игрок не привязан к комнате')
      const state = store.selectHex(payload.roomId, socket.data.playerId, payload.row, payload.col)
      log(payload.roomId, `${socket.data.playerId} выбрал соту ${payload.row}:${payload.col}`)
      emitState(state)
    })
  })

  socket.on('attack_chosen', (payload, ack) => {
    acknowledge(ack, () => {
      rateLimit(socket.id)
      if (!socket.data.playerId) throw new Error('Игрок не привязан к комнате')
      const state = store.chooseAttack(payload.roomId, socket.data.playerId, payload.row, payload.col)
      log(payload.roomId, `${socket.data.playerId} выбрал атаку ${payload.row}:${payload.col}`)
      emitState(state)
    })
  })

  socket.on('disconnect', () => {
    actionBuckets.delete(socket.id)
    const state = store.markDisconnected(socket.id)
    if (!state) return
    log(state.roomId, `${socket.id} отключился, место временно занял бот`)
    emitState(state)
  })
})

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.info(`Strategi Quiz multiplayer server listening on :${PORT}`)
  })
}

export { app, server, store }
