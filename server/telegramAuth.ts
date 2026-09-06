import crypto from 'node:crypto'
import type { TelegramUser } from '../shared/multiplayer'

export type VerifiedTelegramInitData = {
  user: TelegramUser
  authDate: number
}

export function verifyTelegramInitData(initData: string, botToken: string, nowSeconds = Math.floor(Date.now() / 1000)): VerifiedTelegramInitData {
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not configured')
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) throw new Error('Telegram initData hash is missing')
  params.delete('hash')

  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest()
  const calculated = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex')
  if (!crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash))) {
    throw new Error('Telegram initData signature is invalid')
  }

  const authDate = Number(params.get('auth_date') ?? 0)
  if (!Number.isFinite(authDate) || nowSeconds - authDate > 86_400) {
    throw new Error('Telegram initData is expired')
  }

  const rawUser = params.get('user')
  if (!rawUser) throw new Error('Telegram user payload is missing')
  return { user: JSON.parse(rawUser) as TelegramUser, authDate }
}
