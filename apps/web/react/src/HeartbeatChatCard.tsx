import { useEffect, useState } from 'react'

type Card = { status: string; text?: string; asset_ids?: string[] }
const SOURCE_STATUS: Record<string, string> = {
  deleted: '这张牌的来源已删除。',
  forbidden: '这张牌的来源当前不可访问。',
  revision_unavailable: '这张牌当时的来源修订已不可读。',
  unavailable: '这张牌的来源暂不可用。',
}

export default function HeartbeatChatCard({ runId, label }: { runId: string; label: string }) {
  const [card, setCard] = useState<Card | null>(null)
  const [media, setMedia] = useState<Array<{ id: string; mime: string }>>([])
  useEffect(() => {
    const controller = new AbortController()
    setCard(null)
    setMedia([])
    async function load() {
      try {
        const response = await fetch('/api/v1/background/heartbeat/cards/' + encodeURIComponent(runId), { signal: controller.signal })
        const data = await response.json() as Card
        if (controller.signal.aborted) return
        setCard(data)
        if (data.status !== 'available') return
        const assets = await Promise.all((data.asset_ids ?? []).map(async id => {
          try {
            const assetResponse = await fetch('/api/v1/assets/' + encodeURIComponent(id), { signal: controller.signal })
            const info = await assetResponse.json() as { mime_type?: string }
            return { id, mime: assetResponse.ok ? info.mime_type ?? '' : '' }
          } catch { return { id, mime: '' } }
        }))
        if (!controller.signal.aborted) setMedia(assets)
      } catch {
        if (!controller.signal.aborted) setCard({ status: 'unavailable' })
      }
    }
    void load()
    return () => controller.abort()
  }, [runId])
  return <section className="mx-auto mb-5 w-[min(88%,32rem)] rounded-2xl border border-[#ddd9cc] bg-white px-4 py-3">
    <p className="text-[12px] text-[#716d62]">{label}</p>
    {!card && <p role="status" className="mt-2 text-[13px] text-[#716d62]">正在读取牌面…</p>}
    {card && card.status !== 'available' && <p className="mt-2 text-[13px] text-[#716d62]">{SOURCE_STATUS[card.status] ?? SOURCE_STATUS.unavailable}</p>}
    {card?.text && <p className="mt-2 whitespace-pre-wrap break-words">{card.text}</p>}
    {media.map(({ id, mime }) => {
      const url = '/api/v1/assets/' + encodeURIComponent(id) + '/content'
      if (mime.startsWith('audio/')) return <audio key={id} className="mt-2 w-full" controls preload="none" src={url} />
      if (mime.startsWith('image/')) return <img key={id} className="mt-2 max-h-72 max-w-full rounded-xl" alt="牌面图片" loading="lazy" src={url} />
      return <p key={id} className="mt-2 text-[13px] text-[#716d62]">附件暂不可预览。</p>
    })}
  </section>
}
