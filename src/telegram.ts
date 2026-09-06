import WebApp from '@twa-dev/sdk'

export function initializeTelegramWebApp(): void {
  try {
    WebApp.ready()
    WebApp.expand()
    const root = document.documentElement
    root.classList.add('is-telegram-webapp')

    const syncViewport = () => {
      const viewportHeight = WebApp.viewportStableHeight || WebApp.viewportHeight || window.innerHeight
      root.style.setProperty('--tg-viewport-height', `${Math.max(1, viewportHeight)}px`)
    }

    syncViewport()
    WebApp.onEvent('viewportChanged', syncViewport)
    const theme = WebApp.themeParams
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
    return WebApp.initData || ''
  } catch {
    return ''
  }
}

export function getTelegramStartParam(): string {
  try {
    return WebApp.initDataUnsafe.start_param || ''
  } catch {
    return ''
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
    WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${text}`)
  } catch {
    navigator.clipboard?.writeText(inviteUrl).catch(() => undefined)
  }
}
