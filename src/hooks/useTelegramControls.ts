import { useEffect } from 'react'
import WebApp from '@twa-dev/sdk'
import { shareTelegramInvite } from '../telegram'

export function useTelegramControls(onMainMenu: () => void, roomCode: string | null): void {
  useEffect(() => {
    try {
      WebApp.MainButton.setParams({ text: 'Главное меню', is_visible: true })
      WebApp.MainButton.onClick(onMainMenu)

      if (roomCode) {
        WebApp.SecondaryButton.setParams({ text: 'Поделиться приглашением', position: 'bottom', is_visible: true })
        WebApp.SecondaryButton.onClick(() => shareTelegramInvite(roomCode))
      } else {
        WebApp.SecondaryButton.hide()
      }

      return () => {
        WebApp.MainButton.offClick(onMainMenu)
        WebApp.MainButton.hide()
        WebApp.SecondaryButton.hide()
      }
    } catch {
      return undefined
    }
  }, [onMainMenu, roomCode])
}
