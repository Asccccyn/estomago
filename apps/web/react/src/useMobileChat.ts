import { useLayoutEffect, useRef } from 'react'

/** Follow the visible viewport, including Safari's pan when the keyboard opens. */
export function useMobileViewport() {
  const appRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const app = appRef.current
    if (!app) return
    const viewport = window.visualViewport
    let frame = 0
    const update = () => {
      // Keep native pinch zoom: a zoomed viewport is not a keyboard resize.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return
      const height = viewport?.height ?? window.innerHeight
      const top = viewport?.offsetTop ?? 0
      const keyboardOpen = document.documentElement.clientHeight - height > 120
      app.style.setProperty('--app-height', `${height}px`)
      app.style.setProperty('--app-offset-top', `${top}px`)
      app.dataset.keyboard = String(keyboardOpen)
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    update()
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('pageshow', schedule)
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('pageshow', schedule)
    }
  }, [])

  return appRef
}

/** Follow new content only while the reader is at the end of the conversation. */
export function useChatScroll(messages: unknown) {
  const scrollRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  useLayoutEffect(() => {
    const box = scrollRef.current
    const content = contentRef.current
    if (!box || !content) return
    let previousHeight = box.clientHeight
    let previousContentHeight = box.scrollHeight
    const follow = () => {
      if (following.current) box.scrollTop = box.scrollHeight
      previousHeight = box.clientHeight
      previousContentHeight = box.scrollHeight
    }
    const onScroll = () => {
      // Resizing the viewport/content is not a request to stop following.
      if (previousHeight !== box.clientHeight || previousContentHeight !== box.scrollHeight) {
        follow()
        return
      }
      following.current = box.scrollHeight - box.clientHeight - box.scrollTop <= 48
    }
    const observer = new ResizeObserver(follow)
    observer.observe(box)
    observer.observe(content)
    box.addEventListener('scroll', onScroll, { passive: true })
    follow()
    return () => {
      observer.disconnect()
      box.removeEventListener('scroll', onScroll)
    }
  }, [])

  useLayoutEffect(() => {
    const box = scrollRef.current
    if (box && following.current) box.scrollTop = box.scrollHeight
  }, [messages])

  return { scrollRef, contentRef, followLatest: () => { following.current = true } }
}
