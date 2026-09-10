import { io, type Socket } from 'socket.io-client'
import type { ClientToServerEvents, CreateRoomResponse, JoinRoomResponse, MultiplayerGameState, ServerToClientEvents, SocketAck } from '../../shared/multiplayer'
import { getMultiplayerAuthPayload, getTelegramAuthDebug } from '../telegram'

const API_URL = import.meta.env.VITE_MULTIPLAYER_API_URL ?? 'http://127.0.0.1:4000'

function multiplayerFetchError(error: unknown): Error {
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return new Error(`Не удалось подключиться к серверу комнат (${API_URL}). Проверь, что multiplayer API запущен и доступен с этого устройства.`)
  }
  if (error instanceof Error && error.message === 'Telegram initData hash is missing') {
    return new Error(`Telegram не передал подпись для входа в комнату. ${getTelegramAuthDebug()}. Открой игру именно через кнопку Mini App у бота, а не через обычную ссылку внутри Telegram.`)
  }
  return error instanceof Error ? error : new Error('Ошибка мультиплеера')
}
export type MultiplayerSocket = Socket<ServerToClientEvents, ClientToServerEvents>

function devUserQuery(): string {
  const value = new URLSearchParams(window.location.search).get('devUser')
  return value ? `?devUser=${encodeURIComponent(value)}` : ''
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  try {
    const response = await fetch(`${API_URL}${path}${devUserQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? 'Ошибка мультиплеера')
    return data as T
  } catch (error) {
    throw multiplayerFetchError(error)
  }
}

export function createMultiplayerRoom(): Promise<CreateRoomResponse> {
  return postJson<CreateRoomResponse>('/api/create-room', getMultiplayerAuthPayload())
}

export function joinMultiplayerRoom(roomCode: string): Promise<JoinRoomResponse> {
  return postJson<JoinRoomResponse>('/api/join-room', { roomCode, ...getMultiplayerAuthPayload() })
}

export function connectMultiplayerSocket(roomCode: string, onState: (state: MultiplayerGameState) => void, onError?: (message: string) => void, onJoined?: (playerId: string) => void): MultiplayerSocket {
  const socket: MultiplayerSocket = io(API_URL, { transports: ['websocket'], query: Object.fromEntries(new URLSearchParams(devUserQuery())) })
  socket.on('state_update', onState)
  socket.on('connect', () => {
    socket.emit('join_room', { roomCode, ...getMultiplayerAuthPayload() }, ((response) => {
      if (response.ok) {
        onJoined?.(response.data.playerId)
        onState(response.data.state)
      } else onError?.(response.error)
    }) as SocketAck<JoinRoomResponse>)
  })
  return socket
}
