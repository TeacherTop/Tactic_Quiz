import 'dotenv/config'
import http from 'node:http'
import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { Server } from 'socket.io'
import { z } from 'zod'
import { GameRoomStore } from './gameRoomStore'
import { verifyTelegramInitData } from './telegramAuth'
import type { ClientToServerEvents, MultiplayerGameState, ServerToClientEvents, TelegramUser } from '../shared/multiplayer'

const PORT = Number(process.env.PORT ?? 4000)
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://127.0.0.1:5173'
const DEV_AUTH = process.env.NODE_ENV === 'test' || process.env.ALLOW_DEV_AUTH === 'true'
const RATE_LIMIT_PER_SECOND = 10

const initDataSchema = z.object({ initData: z.string().default('') })
const joinRoomSchema = initDataSchema.extend({ roomCode: z.string().regex(/^\d{6}$/) })
const flaggedQuestionSchema = z.object({
  id: z.string(),
  category: z.string().optional(),
  type: z.string(),
  question: z.string(),
  correct_answer: z.string(),
  incorrect_answers: z.array(z.string()),
  answers: z.array(z.string()),
})

type SocketData = {
  roomId?: string
  playerId?: string
}

const app = express()
const server = http.createServer(app)
const store = new GameRoomStore()
const actionBuckets = new Map<string, { startedAt: number; count: number }>()
const scheduledBotTurns = new Set<string>()
const FLAGGED_QUESTIONS_PATH = path.resolve(process.cwd(), 'solo_flagged_questions.json')
const corsOrigin: cors.CorsOptions['origin'] = (origin, callback) => {
  if (!origin || origin === CLIENT_ORIGIN || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
    callback(null, true)
    return
  }
  callback(new Error('Origin is not allowed by CORS'))
}

export const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(server, {
  cors: { origin: corsOrigin, credentials: true },
})

app.use(cors({ origin: corsOrigin, credentials: true }))
app.use(express.json())

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

function schedulePreparation(state: MultiplayerGameState): void {
  if (state.status !== 'preparing' || !state.timerEndsAt) return
  const scheduledTimerEndsAt = state.timerEndsAt
  const delay = Math.max(0, state.timerEndsAt - Date.now())
  setTimeout(() => {
    const current = store.getRoomById(state.roomId)
    if (!current || current.status !== 'preparing' || current.timerEndsAt !== scheduledTimerEndsAt) return
    const next = store.startGame(current.roomId)
    log(next.roomId, `Матч стартовал, раунд ${next.round}`)
    emitState(next)
  }, delay)
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
    const { initData } = initDataSchema.parse(req.body)
    const state = store.createRoom(authenticate(initData, req.query.devUser))
    log(state.roomId, `Создана комната ${state.roomCode}`)
    res.json({ roomCode: state.roomCode, state: publicState(state) })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось создать комнату' })
  }
})

app.post('/api/join-room', (req, res) => {
  try {
    const { roomCode, initData } = joinRoomSchema.parse(req.body)
    const state = store.joinRoom(roomCode, authenticate(initData, req.query.devUser), null)
    schedulePreparation(state)
    log(state.roomId, `Игрок вошел по коду ${roomCode}`)
    res.json({ state: publicState(state) })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось войти в комнату' })
  }
})

app.post('/api/solo-flag-question', (req, res) => {
  try {
    const question = flaggedQuestionSchema.parse(req.body)
    let flagged: z.infer<typeof flaggedQuestionSchema>[] = []
    if (fs.existsSync(FLAGGED_QUESTIONS_PATH)) {
      const raw = fs.readFileSync(FLAGGED_QUESTIONS_PATH, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) flagged = parsed
    }
    const next = [
      ...flagged.filter((item) => item.id !== question.id),
      question,
    ]
    fs.writeFileSync(FLAGGED_QUESTIONS_PATH, `${JSON.stringify(next, null, 2)}\n`)
    res.json({ ok: true, path: FLAGGED_QUESTIONS_PATH, count: next.length })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось сохранить вопрос' })
  }
})

io.on('connection', (socket) => {
  console.info(`[socket:${socket.id}] connected`)

  socket.on('join_room', (payload, ack) => {
    acknowledge(ack, () => {
      rateLimit(socket.id)
      const { roomCode, initData } = joinRoomSchema.parse(payload)
      const user = authenticate(initData, socket.handshake.query.devUser)
      const state = store.joinRoom(roomCode, user, socket.id)
      const player = state.players.find((candidate) => candidate.telegramId === user.id)
      socket.data.roomId = state.roomId
      socket.data.playerId = player?.id
      socket.join(state.roomId)
      schedulePreparation(state)
      log(state.roomId, `${user.first_name} подключился`)
      emitState(state)
      return publicState(state)
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
