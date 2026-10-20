import { useLayoutEffect, useRef, useState } from 'react'
import { captureMessageAnchor, restoreMessageAnchor } from '../../src/history-scroll-logic.js'

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

type ChatScrollOptions = {
  suspended: boolean
  historyMode: 'latest' | 'date'
  historyVersion: number
  historyLoading: boolean
  loadingEarlier: boolean
  hasEarlier: boolean
  ready: boolean
  onLoadEarlier: () => Promise<boolean>
}

/** Follow the latest only at the bottom; prepend pages without moving what is being read. */
export function useChatScroll(messages: Array<{ id: string }>, options: ChatScrollOptions) {
  const scrollRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [awayFromLatest, setAwayFromLatest] = useState(false)
  const anchor = useRef<ReturnType<typeof captureMessageAnchor> | null>(null)
  const prependPending = useRef(false)
  const earlierInFlight = useRef(false)
  const priorFirstId = useRef<string | undefined>(undefined)
  const priorVersion = useRef(options.historyVersion)
  const ignoreScroll = useRef(false)
  const scrollFrame = useRef(0)
  if (options.suspended || options.historyMode === 'date') following.current = false

  const markProgrammatic = () => {
    ignoreScroll.current = true
    cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = requestAnimationFrame(() => { ignoreScroll.current = false })
  }
  const capture = () => { if (scrollRef.current) anchor.current = captureMessageAnchor(scrollRef.current) }
  const preserveScroll = () => {
    following.current = false
    setAwayFromLatest(true)
    capture()
    prependPending.current = true
  }

  useLayoutEffect(() => {
    const box = scrollRef.current
    const content = contentRef.current
    if (!box || !content) return
    let lastTouchY: number | null = null
    const loadNearTop = () => {
      const current = optionsRef.current
      if (box.scrollTop > 72 || !current.ready || !current.hasEarlier || current.loadingEarlier || current.historyLoading || current.suspended || earlierInFlight.current) return
      earlierInFlight.current = true
      preserveScroll()
      void current.onLoadEarlier().catch(() => {}).finally(() => { earlierInFlight.current = false })
    }
    const resize = () => {
      const current = optionsRef.current
      if (following.current && !current.suspended && current.historyMode === 'latest' && !current.historyLoading) {
        markProgrammatic(); box.scrollTop = box.scrollHeight
      } else if (anchor.current && !current.historyLoading) {
        markProgrammatic(); restoreMessageAnchor(box, anchor.current)
      }
      capture()
    }
    let previousTop = box.scrollTop
    const onScroll = () => {
      const current = optionsRef.current
      const upward = box.scrollTop < previousTop
      previousTop = box.scrollTop
      if (!ignoreScroll.current) {
        const atBottom = box.scrollHeight - box.clientHeight - box.scrollTop <= 48
        following.current = atBottom && !current.suspended && current.historyMode === 'latest' && !current.historyLoading
        setAwayFromLatest(!atBottom || current.historyMode === 'date')
        capture()
        if (upward) loadNearTop()
      }
    }
    // A wheel/swipe at scrollTop=0 need not emit a scroll event. Treat that
    // explicit upward gesture as a load request too, never the initial layout.
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) loadNearTop() }
    const onTouchStart = (event: TouchEvent) => { lastTouchY = event.touches[0]?.clientY ?? null }
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY
      if (y != null && lastTouchY != null && y - lastTouchY > 12) { loadNearTop(); lastTouchY = y }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(box)
    observer.observe(content)
    box.addEventListener('scroll', onScroll, { passive: true })
    box.addEventListener('wheel', onWheel, { passive: true })
    box.addEventListener('touchstart', onTouchStart, { passive: true })
    box.addEventListener('touchmove', onTouchMove, { passive: true })
    resize()
    return () => {
      observer.disconnect()
      box.removeEventListener('scroll', onScroll)
      box.removeEventListener('wheel', onWheel)
      box.removeEventListener('touchstart', onTouchStart)
      box.removeEventListener('touchmove', onTouchMove)
      cancelAnimationFrame(scrollFrame.current)
    }
  }, [])

  useLayoutEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const replaced = priorVersion.current !== options.historyVersion
    const prepended = priorFirstId.current !== undefined && priorFirstId.current !== messages[0]?.id && messages.some((m) => m.id === priorFirstId.current)
    if (replaced) {
      prependPending.current = false
      following.current = options.historyMode === 'latest' && !options.suspended
      setAwayFromLatest(options.historyMode === 'date')
      markProgrammatic(); box.scrollTop = options.historyMode === 'latest' ? box.scrollHeight : 0
    } else if (prepended && prependPending.current) {
      markProgrammatic(); restoreMessageAnchor(box, anchor.current)
      prependPending.current = false
    } else if (following.current && !options.suspended && !options.historyLoading) {
      markProgrammatic(); box.scrollTop = box.scrollHeight
    }
    priorVersion.current = options.historyVersion
    priorFirstId.current = messages[0]?.id
    capture()
  }, [messages, options.historyVersion, options.historyMode, options.historyLoading, options.suspended])

  return { scrollRef, contentRef, awayFromLatest, preserveScroll, followLatest: () => {
    following.current = true; setAwayFromLatest(false); prependPending.current = false
    if (scrollRef.current) { markProgrammatic(); scrollRef.current.scrollTop = scrollRef.current.scrollHeight; capture() }
  } }
}
