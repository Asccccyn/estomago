import type { ChatMessage } from './chat-client'

export type ChatRow = { key: string; parts: ChatMessage[] }

// A turn keeps its React identity when the waiting row is replaced by real
// publications. Message IDs stay on the individual parts for selection and scroll.
export function chatRows(messages: ChatMessage[]): ChatRow[] {
  const rows: ChatRow[] = []
  const replies = new Map<string, ChatRow>()
  for (const message of messages) {
    if (message.role === 'ai' && !message.system && message.turnId) {
      let row = replies.get(message.turnId)
      if (!row) {
        row = { key: 'reply:' + message.turnId, parts: [] }
        replies.set(message.turnId, row)
        rows.push(row)
      }
      row.parts.push(message)
    } else {
      rows.push({ key: message.id, parts: [message] })
    }
  }
  return rows
}

// Text keeps one canonical message ID even when more text was published after a
// media message. Cuts address code points in the current revision, including emoji.
export function replyContent(parts: ChatMessage[]) {
  const positions = new Map(parts.map((part, index) => [part.id, index]))
  const content: Array<{ key: string; order: number; part: ChatMessage; anchor?: string }> = []
  for (const [index, part] of parts.entries()) {
    const cuts = part.publicationBreaks?.filter(cut => positions.has(cut.before_message_id))
    if (!cuts?.length) {
      content.push({ key: part.id, order: index * 2, part, anchor: part.id })
      continue
    }
    const chars = [...part.text]
    let start = 0, order = index * 2
    for (const cut of cuts) {
      if (cut.end_char > start) content.push({ key: part.id + ':' + start, order,
        part: { ...part, text: chars.slice(start === 0 ? 0 : start + 2, cut.end_char).join('') }, anchor: start === 0 ? part.id : undefined })
      order = positions.get(cut.before_message_id)! * 2 + 1
      start = cut.end_char
    }
    if (start < chars.length) content.push({ key: part.id + ':' + start, order,
      part: { ...part, text: chars.slice(start === 0 ? 0 : start + 2).join('') }, anchor: start === 0 ? part.id : undefined })
  }
  return content.sort((a, b) => a.order - b.order)
}
