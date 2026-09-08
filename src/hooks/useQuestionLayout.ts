import { useEffect } from 'react'

/** Fit unusually long questions to the available card, without clipping or scrollbars. */
export function useQuestionLayout() {
  useEffect(() => {
    let frame = 0
    const fit = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        document.querySelectorAll<HTMLElement>('.question-card, .online-question-panel, .round-result-card').forEach((card) => {
          const text = Array.from(card.querySelectorAll<HTMLElement>('h2, .question-text, .option, .result-option'))
          text.forEach((element) => element.style.removeProperty('font-size'))
          const sizes = text.map((element) => parseFloat(getComputedStyle(element).fontSize))
          // Preserve the full text and the answer controls; only reduce type when needed.
          for (let step = 1; step <= 12 && card.scrollHeight > card.clientHeight + 1; step++) {
            text.forEach((element, index) => {
              element.style.fontSize = `${Math.max(11, sizes[index]! - step)}px`
            })
          }
        })
      })
    }
    const observer = new MutationObserver(fit)
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true })
    window.addEventListener('resize', fit)
    window.visualViewport?.addEventListener('resize', fit)
    fit()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', fit)
      window.visualViewport?.removeEventListener('resize', fit)
    }
  }, [])
}
