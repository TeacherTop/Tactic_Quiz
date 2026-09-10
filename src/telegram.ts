import WebApp from '@twa-dev/sdk'

type TelegramWindow = Window & {
  Telegram?: {
    WebApp?: {
      initData?: string
      initDataUnsafe?: { start_param?: string }
      ready?: () => void
      expand?: () => void
      viewportStableHeight?: number
      viewportHeight?: number
      themeParams?: Record<string, string | undefined>
      onEvent?: (event: 'viewportChanged', callback: () => void) => void
      openTelegramLink?: (url: string) => void
    }
  }
}

function nativeWebApp() {
  return (window as TelegramWindow).Telegram?.WebApp
}

export function initializeTelegramWebApp(): void {
  try {
    const native = nativeWebApp()
    ;(native?.ready ?? WebApp.ready)?.()
    ;(native?.expand ?? WebApp.expand)?.()
    const root = document.documentElement
    root.classList.add('is-telegram-webapp')

    const syncViewport = () => {
      const viewportHeight = native?.viewportStableHeight || WebApp.viewportStableHeight || native?.viewportHeight || WebApp.viewportHeight || window.innerHeight
      root.style.setProperty('--tg-viewport-height', `${Math.max(1, viewportHeight)}px`)
    }

    syncViewport()
    ;(native?.onEvent ?? WebApp.onEvent)?.('viewportChanged', syncViewport)
    const theme = native?.themeParams ?? WebApp.themeParams
    if (theme.bg_color && theme.bg_color.toLowerCase() !== '#ffffff') {
      root.style.setProperty('--bg', theme.bg_color)
      root.style.setProperty('--paper', theme.secondary_bg_color ?? '#2b251f')
      root.style.setProperty('--paper-deep', theme.bg_color)
      root.style.setProperty('--ink', theme.text_color ?? '#f4ead8')
      root.style.setProperty('--muted', theme.hint_color ?? '#d9c6a4')
      root.style.setProperty('--line', theme.section_separator_color ?? 'rgba(255, 215, 128, 0.25)')
    }
    if (theme.button_color) root.style.setProperty('--gold', theme.button_color)
  } catch {
    // Telegram SDK is optional in local browser development.
  }
}

export function getTelegramInitData(): string {
  try {
    return nativeWebApp()?.initData || WebApp.initData || ''
  } catch {
    return nativeWebApp()?.initData || ''
  }
}

export function getTelegramAuthDebug(): string {
  const native = nativeWebApp()
  const initData = getTelegramInitData()
  return `Telegram WebApp: ${native ? 'yes' : 'no'}, initData: ${initData.length} chars, hash: ${new URLSearchParams(initData).has('hash') ? 'yes' : 'no'}`
}


const BROWSER_GUEST_STORAGE_KEY = 'strategi-quiz-browser-guest-v1'

export type BrowserGuestIdentity = {
  id: string
  name: string
}

export function getBrowserGuestIdentity(): BrowserGuestIdentity {
  try {
    const existing = localStorage.getItem(BROWSER_GUEST_STORAGE_KEY)
    if (existing) {
      const parsed = JSON.parse(existing) as BrowserGuestIdentity
      if (parsed.id && parsed.name) return parsed
    }
  } catch {
    // Local storage may be unavailable in restricted webviews.
  }
  const random = Math.floor(1000 + Math.random() * 9000)
  const identity = { id: crypto.randomUUID(), name: `Гость ${random}` }
  try {
    localStorage.setItem(BROWSER_GUEST_STORAGE_KEY, JSON.stringify(identity))
  } catch {
    // Keep the in-memory identity for this request.
  }
  return identity
}

export function getMultiplayerAuthPayload() {
  const initData = getTelegramInitData()
  return initData ? { initData } : { initData: '', browserGuest: getBrowserGuestIdentity() }
}

export function getTelegramStartParam(): string {
  try {
    return nativeWebApp()?.initDataUnsafe?.start_param || WebApp.initDataUnsafe.start_param || ''
  } catch {
    return nativeWebApp()?.initDataUnsafe?.start_param || ''
  }
}

export function getInviteRoomCode(): string {
  const params = new URLSearchParams(window.location.search)
  const directCode = params.get('room') ?? params.get('startapp') ?? getTelegramStartParam()
  const match = directCode?.match(/\d{6}/)
  return match?.[0] ?? ''
}

export function getTelegramInviteUrl(roomCode: string): string {
  const botUsername = import.meta.env.VITE_TELEGRAM_BOT_USERNAME
  if (botUsername) return `https://t.me/${botUsername}?startapp=${roomCode}`
  const url = new URL(window.location.href)
  url.searchParams.set('room', roomCode)
  return url.toString()
}

export function shareTelegramInvite(roomCode: string): void {
  const inviteUrl = getTelegramInviteUrl(roomCode)
  const text = encodeURIComponent(`Присоединяйся к комнате Strategi Quiz: ${roomCode}`)
  try {
    const native = nativeWebApp()
    if (native?.openTelegramLink) native.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${text}`)
    else WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${text}`)
  } catch {
    navigator.clipboard?.writeText(inviteUrl).catch(() => undefined)
  }
}
