import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { MultiplayerGameState, MultiplayerHex, PublicQuestion, TelegramUser } from '../shared/multiplayer'

type StoredQuestion = {
  category: string
  type: 'multiple' | 'boolean'
  question: string
  correct_answer: string
  answers: string[]
}

const PLAYER_COLORS = ['#b55239', '#2f7d7a', '#4969a8']
const ROOM_SIZE = 3
const PREPARE_MS = 5000
const ANSWER_MS = 25000
const MAX_BATTLE_ROUNDS = 9
const SCORE_VALUES = {
  mcCorrect: 10,
  numericWin: 15,
  numericExactBonus: 5,
  capture: 20,
  lostTerritory: -20,
  hold: 5,
} as const
const QUESTION_BANK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../question_bank')
const QUESTIONS = fs.readdirSync(QUESTION_BANK_DIR)
  .filter((file) => /^my_game_question\d+\.json$/.test(file))
  .sort((left, right) => questionBankFileNumber(left) - questionBankFileNumber(right))
  .flatMap((file) => JSON.parse(fs.readFileSync(path.join(QUESTION_BANK_DIR, file), 'utf8')) as StoredQuestion[])
const NUMERIC_QUESTIONS = [
  { id: 'numeric-cube', prompt: 'Сколько граней у куба?', answer: 6, unit: '' },
  { id: 'numeric-piano', prompt: 'Сколько клавиш у стандартного фортепиано?', answer: 88, unit: '' },
  { id: 'numeric-chess-board', prompt: 'Сколько клеток на стандартной шахматной доске?', answer: 64, unit: '' },
  { id: 'numeric-leap-year', prompt: 'Сколько дней в високосном году?', answer: 366, unit: '' },
  { id: 'numeric-olympic-rings', prompt: 'Сколько колец изображено на олимпийском символе?', answer: 5, unit: '' },
  { id: 'numeric-gagarin', prompt: 'В каком году Юрий Гагарин полетел в космос?', answer: 1961, unit: 'год' },
  { id: 'numeric-spb', prompt: 'В каком году основан Санкт-Петербург?', answer: 1703, unit: 'год' },
  { id: 'numeric-football', prompt: 'Сколько футболистов одной команды одновременно на поле?', answer: 11, unit: '' },
  { id: 'numeric-periodic-table', prompt: 'Сколько химических элементов официально входит в современную периодическую таблицу?', answer: 118, unit: '' },
  { id: 'numeric-bones', prompt: 'Сколько костей в скелете взрослого человека?', answer: 206, unit: '' },
] as const
const DIRECTIONS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]

function createArena(): MultiplayerHex[] {
  const cells: MultiplayerHex[] = []
  const radius = 2
  for (let row = -radius; row <= radius; row += 1) {
    for (let col = -radius; col <= radius; col += 1) {
      if (Math.abs(row + col) > radius) continue
      cells.push({ row, col, ownerId: null })
    }
  }
  return cells
}

function cellKey(row: number, col: number): string {
  return `${row}:${col}`
}

function getNeighbors(row: number, col: number): [number, number][] {
  const radius = 2
  return DIRECTIONS
    .map(([rowOffset, colOffset]) => [row + rowOffset, col + colOffset] as [number, number])
    .filter(([neighborRow, neighborCol]) => Math.abs(neighborRow) <= radius
      && Math.abs(neighborCol) <= radius
      && Math.abs(neighborRow + neighborCol) <= radius)
}

function playerIds(room: MultiplayerGameState): string[] {
  return room.players.filter((player) => !player.botReplacementFor).map((player) => player.id)
}

function blankScores(room: MultiplayerGameState): Record<string, number> {
  return Object.fromEntries(playerIds(room).map((id) => [id, 0]))
}

function blankMcStats(room: MultiplayerGameState): Record<string, { correct: number; total: number }> {
  return Object.fromEntries(playerIds(room).map((id) => [id, { correct: 0, total: 0 }]))
}

function availableCells(arena: MultiplayerHex[], playerId: string): string[] {
  const occupied = new Set(arena.filter((cell) => cell.ownerId).map((cell) => cellKey(cell.row, cell.col)))
  const owned = arena.filter((cell) => cell.ownerId === playerId)
  const available = new Set<string>()
  for (const cell of owned) {
    for (const [row, col] of getNeighbors(cell.row, cell.col)) {
      const key = cellKey(row, col)
      if (!occupied.has(key)) available.add(key)
    }
  }
  if (available.size > 0) return [...available]
  return arena.filter((cell) => !cell.ownerId).map((cell) => cellKey(cell.row, cell.col))
}

function attackTargets(arena: MultiplayerHex[], playerId: string): MultiplayerHex[] {
  const targets = new Set<string>()
  for (const cell of arena.filter((candidate) => candidate.ownerId === playerId)) {
    for (const [row, col] of getNeighbors(cell.row, cell.col)) {
      const target = arena.find((candidate) => candidate.row === row && candidate.col === col)
      if (target?.ownerId && target.ownerId !== playerId) targets.add(cellKey(target.row, target.col))
    }
  }
  return arena.filter((cell) => targets.has(cellKey(cell.row, cell.col)))
}

function firstAttacker(room: MultiplayerGameState): string | null {
  return playerIds(room).find((id) => attackTargets(room.arena, id).length > 0) ?? null
}

function finishRoom(room: MultiplayerGameState): void {
  room.status = 'finished'
  room.phase = 'results'
  room.activePlayerId = null
  room.availableHexes = []
  room.timerEndsAt = null
}

function expectedAnswerers(room: MultiplayerGameState): string[] {
  if (room.phase !== 'battle-number') return playerIds(room)
  return [room.activePlayerId, room.selectedAttack?.ownerId].filter((id): id is string => Boolean(id))
}

function roomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function questionBankFileNumber(file: string): number {
  return Number(file.match(/^my_game_question(\d+)\.json$/)?.[1] ?? Number.MAX_SAFE_INTEGER)
}

function pickQuestionIndex(usedIds: string[]): number {
  const available = QUESTIONS
    .map((_, index) => index)
    .filter((index) => !usedIds.includes(String(index)))
  return available[crypto.randomInt(available.length)]
}

function pickNumericQuestion(usedIds: string[]): typeof NUMERIC_QUESTIONS[number] {
  const available = NUMERIC_QUESTIONS.filter((question) => !usedIds.includes(question.id))
  return available[crypto.randomInt(available.length)]
}

function shuffleOptions(question: StoredQuestion): { options: string[]; correctOption: number } {
  const options = question.answers.map((option) => ({ option, isCorrect: option === question.correct_answer }))
  for (let i = options.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1)
    ;[options[i], options[j]] = [options[j], options[i]]
  }
  return {
    options: options.map(({ option }) => option),
    correctOption: options.findIndex(({ isCorrect }) => isCorrect),
  }
}

function publicQuestion(question: StoredQuestion, index: number): { publicQuestion: PublicQuestion; correctOption: number } {
  const shuffled = shuffleOptions(question)
  return {
    publicQuestion: {
      id: String(index),
      category: question.category,
      type: question.type,
      prompt: question.question,
      options: shuffled.options,
    },
    correctOption: shuffled.correctOption,
  }
}

export class GameRoomStore {
  private rooms = new Map<string, MultiplayerGameState>()
  private questionAnswers = new Map<string, number>()
  private supabase: SupabaseClient | null

  constructor() {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    this.supabase = url && key ? createClient(url, key) : null
  }

  createRoom(host: TelegramUser): MultiplayerGameState {
    let code = roomCode()
    while (this.rooms.has(code)) code = roomCode()
    const state: MultiplayerGameState = {
      roomId: crypto.randomUUID(),
      roomCode: code,
      status: 'waiting',
      phase: 'lobby',
      players: [],
      arena: createArena(),
      currentQuestion: null,
      usedQuestionIds: [],
      answers: {},
      answerTimes: {},
      scores: {},
      mcStats: {},
      activePlayerId: null,
      turnQueue: [],
      availableHexes: [],
      selectedAttack: null,
      roundResult: null,
      round: 0,
      battleRound: 0,
      timerEndsAt: null,
      updatedAt: Date.now(),
    }
    this.rooms.set(code, this.addPlayer(state, host, null))
    void this.persist(this.rooms.get(code)!)
    return this.rooms.get(code)!
  }

  joinRoom(code: string, user: TelegramUser, socketId: string | null): MultiplayerGameState {
    const room = this.rooms.get(code)
    if (!room) throw new Error('Комната не найдена')
    const existing = room.players.find((player) => player.telegramId === user.id)
    if (existing) {
      existing.status = 'connected'
      existing.socketId = socketId
      existing.disconnectedAt = null
      room.players = room.players.filter((player) => player.botReplacementFor !== existing.id)
      room.updatedAt = Date.now()
      void this.persist(room)
      return room
    }
    if (room.players.filter((player) => !player.botReplacementFor).length >= ROOM_SIZE) {
      throw new Error('В комнате уже 3 игрока')
    }
    const next = this.addPlayer(room, user, socketId)
    if (next.players.filter((player) => !player.botReplacementFor).length === ROOM_SIZE && next.status === 'waiting') {
      next.status = 'preparing'
      next.timerEndsAt = Date.now() + PREPARE_MS
    }
    next.updatedAt = Date.now()
    void this.persist(next)
    return next
  }

  getRoomById(roomId: string): MultiplayerGameState | undefined {
    return [...this.rooms.values()].find((room) => room.roomId === roomId)
  }

  startGame(roomId: string): MultiplayerGameState {
    const room = this.requireRoom(roomId)
    const questionIndex = pickQuestionIndex(room.usedQuestionIds ?? [])
    const question = QUESTIONS[questionIndex]
    const nextQuestion = publicQuestion(question, questionIndex)
    room.status = 'playing'
    room.phase = 'expansion'
    room.round += 1
    room.currentQuestion = nextQuestion.publicQuestion
    room.usedQuestionIds = [...(room.usedQuestionIds ?? []), room.currentQuestion.id]
    room.answers = {}
    room.answerTimes = {}
    if (Object.keys(room.scores).length === 0) room.scores = blankScores(room)
    if (Object.keys(room.mcStats).length === 0) room.mcStats = blankMcStats(room)
    room.turnQueue = []
    room.availableHexes = []
    room.selectedAttack = null
    room.roundResult = null
    room.timerEndsAt = Date.now() + ANSWER_MS
    this.questionAnswers.set(room.roomId, nextQuestion.correctOption)
    room.updatedAt = Date.now()
    void this.persist(room)
    return room
  }

  submitAnswer(roomId: string, playerId: string, answer: number): MultiplayerGameState {
    const room = this.requireRoom(roomId)
    if (room.status !== 'playing' || !room.timerEndsAt || Date.now() > room.timerEndsAt) {
      throw new Error('Время ответа истекло')
    }
    if (room.answers[playerId] !== undefined) return room
    room.answers[playerId] = answer
    room.answerTimes[playerId] = Date.now()
    if (expectedAnswerers(room).every((id) => room.answers[id] !== undefined)) {
      this.finishAnswering(room.roomId)
      return room
    }
    room.updatedAt = Date.now()
    void this.persist(room)
    return room
  }

  finishAnswering(roomId: string): MultiplayerGameState {
    const room = this.requireRoom(roomId)
    if (room.phase === 'expansion') return this.finishExpansionQuestion(room)
    if (room.phase === 'battle-number') return this.finishBattleNumber(room)
    return room
  }

  selectHex(roomId: string, playerId: string, row: number, col: number): MultiplayerGameState {
    const room = this.requireRoom(roomId)
    const cell = room.arena.find((candidate) => candidate.row === row && candidate.col === col)
    if (!cell) throw new Error('Сота не найдена')
    if (room.phase !== 'expansion-capture') throw new Error('Сейчас нельзя выбирать соту')
    const targetKey = cellKey(row, col)
    if (!room.availableHexes.includes(targetKey)) throw new Error('Эта сота недоступна')
    if (room.turnQueue[0] !== playerId) throw new Error('Сейчас ход другого игрока')
    if (cell.ownerId) throw new Error('Сота уже занята')
    cell.ownerId = playerId
    room.scores[playerId] = (room.scores[playerId] ?? 0) + SCORE_VALUES.capture
    room.turnQueue.shift()
    this.advanceExpansionCapture(room)
    room.updatedAt = Date.now()
    void this.persist(room)
    return room
  }

  chooseAttack(roomId: string, playerId: string, row: number, col: number): MultiplayerGameState {
    const room = this.requireRoom(roomId)
    if (room.phase !== 'battle-select') throw new Error('Сейчас нельзя выбирать атаку')
    if (room.activePlayerId !== playerId) throw new Error('Сейчас ход другого игрока')
    const target = attackTargets(room.arena, playerId).find((cell) => cell.row === row && cell.col === col)
    if (!target) throw new Error('Эту соту нельзя атаковать')
    const question = pickNumericQuestion(room.usedQuestionIds ?? [])
    room.selectedAttack = target
    room.phase = 'battle-number'
    room.currentQuestion = { id: question.id, category: 'Числовая дуэль', type: 'numeric', prompt: question.prompt, options: [], unit: question.unit }
    room.usedQuestionIds = [...(room.usedQuestionIds ?? []), question.id]
    this.questionAnswers.set(room.roomId, question.answer)
    room.answers = {}
    room.answerTimes = {}
    room.roundResult = null
    room.timerEndsAt = Date.now() + ANSWER_MS
    room.updatedAt = Date.now()
    void this.persist(room)
    return room
  }

  markDisconnected(socketId: string): MultiplayerGameState | null {
    const room = [...this.rooms.values()].find((candidate) => candidate.players.some((player) => player.socketId === socketId))
    if (!room) return null
    const player = room.players.find((candidate) => candidate.socketId === socketId)
    if (!player) return null
    player.status = 'disconnected'
    player.socketId = null
    player.disconnectedAt = Date.now()
    room.players.push({
      ...player,
      id: crypto.randomUUID(),
      telegramId: null,
      name: `${player.name} Bot`,
      status: 'bot',
      socketId: null,
      botReplacementFor: player.id,
    })
    room.updatedAt = Date.now()
    void this.persist(room)
    return room
  }

  private addPlayer(room: MultiplayerGameState, user: TelegramUser, socketId: string | null): MultiplayerGameState {
    const index = room.players.filter((player) => !player.botReplacementFor).length
    room.players.push({
      id: crypto.randomUUID(),
      telegramId: user.id,
      name: user.first_name,
      color: PLAYER_COLORS[index] ?? '#765f4e',
      status: 'connected',
      socketId,
      joinedAt: Date.now(),
      disconnectedAt: null,
    })
    room.updatedAt = Date.now()
    room.scores = blankScores(room)
    room.mcStats = blankMcStats(room)
    const starters = [
      [0, -2],
      [-2, 2],
      [2, 0],
    ]
    const starter = starters[index]
    if (starter) {
      const cell = room.arena.find((candidate) => candidate.row === starter[0] && candidate.col === starter[1])
      if (cell) cell.ownerId = room.players[index].id
    }
    return room
  }

  private finishExpansionQuestion(room: MultiplayerGameState): MultiplayerGameState {
    const correct = this.questionAnswers.get(room.roomId)
    const correctPlayerIds = playerIds(room).filter((id) => room.answers[id] === correct)
    for (const id of playerIds(room)) {
      const stat = room.mcStats[id] ?? { correct: 0, total: 0 }
      room.mcStats[id] = { correct: stat.correct + (correctPlayerIds.includes(id) ? 1 : 0), total: stat.total + 1 }
      if (correctPlayerIds.includes(id)) room.scores[id] = (room.scores[id] ?? 0) + SCORE_VALUES.mcCorrect
    }
    room.turnQueue = correctPlayerIds.sort((left, right) => (room.answerTimes[left] ?? 0) - (room.answerTimes[right] ?? 0))
    room.roundResult = { correctOption: correct, correctPlayerIds, exactBonusPlayerIds: [] }
    room.phase = 'expansion-review'
    room.timerEndsAt = Date.now() + 600
    room.activePlayerId = null
    room.updatedAt = Date.now()
    void this.persist(room)
    return room
  }

  beginCapture(roomId: string): MultiplayerGameState {
    const room = this.requireRoom(roomId)
    this.advanceExpansionCapture(room)
    room.updatedAt = Date.now()
    void this.persist(room)
    return room
  }

  private advanceExpansionCapture(room: MultiplayerGameState): void {
    while (room.turnQueue.length > 0) {
      const active = room.turnQueue[0]
      const available = availableCells(room.arena, active)
      if (available.length > 0) {
        room.phase = 'expansion-capture'
        room.activePlayerId = active
        room.availableHexes = available
        room.timerEndsAt = null
        return
      }
      room.turnQueue.shift()
    }
    room.activePlayerId = null
    room.availableHexes = []
    if (room.arena.every((cell) => cell.ownerId)) {
      const attacker = firstAttacker(room)
      if (!attacker) {
        finishRoom(room)
        return
      }
      room.phase = 'battle-select'
      room.activePlayerId = attacker
      room.availableHexes = attackTargets(room.arena, attacker).map((cell) => cellKey(cell.row, cell.col))
      room.battleRound = 0
      return
    }
    this.startGame(room.roomId)
  }

  private finishBattleNumber(room: MultiplayerGameState): MultiplayerGameState {
    if (!room.selectedAttack?.ownerId || !room.activePlayerId) return room
    const attacker = room.activePlayerId
    const defender = room.selectedAttack.ownerId
    const correct = this.questionAnswers.get(room.roomId)
    const ranked = [attacker, defender]
      .map((id) => ({ id, answer: Number(room.answers[id]), distance: Math.abs(Number(room.answers[id]) - Number(correct)), at: room.answerTimes[id] ?? Number.POSITIVE_INFINITY }))
      .filter((row) => Number.isFinite(row.answer))
      .sort((left, right) => left.distance - right.distance || left.at - right.at)
    const winner = ranked[0]?.id
    const exactBonusPlayerIds = ranked.filter((row) => row.distance === 0).map((row) => row.id)
    if (winner) {
      room.scores[winner] = (room.scores[winner] ?? 0) + SCORE_VALUES.numericWin
      for (const id of exactBonusPlayerIds) room.scores[id] = (room.scores[id] ?? 0) + SCORE_VALUES.numericExactBonus
      if (winner === attacker) {
        const cell = room.arena.find((candidate) => candidate.row === room.selectedAttack?.row && candidate.col === room.selectedAttack?.col)
        if (cell) {
          room.scores[defender] = (room.scores[defender] ?? 0) + SCORE_VALUES.lostTerritory
          room.scores[attacker] = (room.scores[attacker] ?? 0) + SCORE_VALUES.capture
          cell.ownerId = attacker
        }
      } else {
        room.scores[defender] = (room.scores[defender] ?? 0) + SCORE_VALUES.hold
      }
    }
    room.roundResult = { correctPlayerIds: [], numericWinnerId: winner, exactBonusPlayerIds }
    room.battleRound += 1
    if (room.battleRound >= MAX_BATTLE_ROUNDS) {
      finishRoom(room)
    } else {
      const attackerNext = firstAttacker(room)
      if (!attackerNext) {
        finishRoom(room)
        room.selectedAttack = null
        room.currentQuestion = null
        room.updatedAt = Date.now()
        void this.persist(room)
        return room
      }
      room.phase = 'battle-select'
      room.activePlayerId = attackerNext
      room.availableHexes = attackTargets(room.arena, attackerNext).map((cell) => cellKey(cell.row, cell.col))
    }
    room.selectedAttack = null
    room.currentQuestion = null
    room.timerEndsAt = null
    room.updatedAt = Date.now()
    void this.persist(room)
    return room
  }

  private requireRoom(roomId: string): MultiplayerGameState {
    const room = this.getRoomById(roomId)
    if (!room) throw new Error('Комната не найдена')
    return room
  }

  private async persist(room: MultiplayerGameState): Promise<void> {
    if (!this.supabase) return
    await this.supabase.from('rooms').upsert({ id: room.roomId, code: room.roomCode, status: room.status, updated_at: new Date(room.updatedAt).toISOString() })
    await this.supabase.from('game_states').upsert({ room_id: room.roomId, state: room, updated_at: new Date(room.updatedAt).toISOString() })
  }
}
