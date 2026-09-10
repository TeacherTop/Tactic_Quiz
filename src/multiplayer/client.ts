import { io, type Socket } from 'socket.io-client'
import type { ClientToServerEvents, CreateRoomResponse, JoinRoomResponse, MultiplayerGameState, ServerToClientEvents, SocketAck } from '../../shared/multiplayer'
import { getTelegramInitData } from '../telegram'

const API_URL = import.meta.env.VITE_MULTIPLAYER_API_URL ?? 'http://127.0.0.1:4000'
export type MultiplayerSocket = Socket<ServerToClientEvents, ClientToServerEvents>

function devUserQuery(): string {
  const value = new URLSearchParams(window.location.search).get('devUser')
  return value ? `?devUser=${encodeURIComponent(value)}` : ''
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}${devUserQuery()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? 'Ошибка мультиплеера')
  return data as T
}

export function createMultiplayerRoom(): Promise<CreateRoomResponse> {
  return postJson<CreateRoomResponse>('/api/create-room', { initData: getTelegramInitData() })
}

export function joinMultiplayerRoom(roomCode: string): Promise<JoinRoomResponse> {
  return postJson<JoinRoomResponse>('/api/join-room', { roomCode, initData: getTelegramInitData() })
}

export function connectMultiplayerSocket(roomCode: string, onState: (state: MultiplayerGameState) => void, onError?: (message: string) => void, onJoined?: (playerId: string) => void): MultiplayerSocket {
  const socket: MultiplayerSocket = io(API_URL, { transports: ['websocket'], query: Object.fromEntries(new URLSearchParams(devUserQuery())) })
  socket.on('state_update', onState)
  socket.on('connect', () => {
    socket.emit('join_room', { roomCode, initData: getTelegramInitData() }, ((response) => {
      if (response.ok) {
        onJoined?.(response.data.playerId)
        onState(response.data.state)
      } else onError?.(response.error)
    }) as SocketAck<JoinRoomResponse>)
  })
  return socket
}
