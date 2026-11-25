export type ContentEntry = {
  id: string
  revision: number
  title: string | null
  body: string | null
  author: string | null
  created_at: string
  published_at?: string
  updated_at: string
  asset_ids: string[]
  kind?: 'reference'
  /** A Moments entry from a heartbeat run, or from a card drawn while chatting. */
  origin?: 'heartbeat' | 'chat'
  deleted?: boolean
  blocks?: SourceBlock[]
  delivery_state?: DeliveryState
  frozen_card?: { number: number; revision: number; available: boolean }
}

export type NoteView = 'pending' | 'used'

export type DeliveryState = 'pending' | 'dispatching' | 'delivered' | 'unknown'

export type SourceBlock = {
  id: string
  /** main = the card face and what was actually said to her; detail = how the turn ran. */
  layer?: 'main' | 'detail'
  source_label: string
  author?: string | null
  status: 'available' | 'deleted' | 'forbidden' | 'revision_unavailable' | 'unavailable'
  text?: string | null
  asset_ids?: string[]
  observed_revision?: number
  display_revision?: number
  current_revision?: number
  editor?: string
  management_href?: string
  editable: boolean
  outcome?: 'committed' | 'partial' | 'failed' | 'cancelled' | 'unknown'
}

export type HeartbeatState = {
  date: string
  mode: 'unprepared' | 'draw' | 'source_unavailable' | 'exhausted_keepwarm'
  available_numbers: number[]
  delivered_numbers: number[]
  source_unavailable_numbers: number[]
  daily_memory?: { state: string; selected_at?: string; reason?: string | null }
}

export type ContentPage = {
  items: ContentEntry[]
  has_more: boolean
  next_cursor?: string | null
  /** Reserved notes only: which view this page is and how many notes each view holds. */
  view?: NoteView
  counts?: { pending: number; used: number; uncertain: number }
}

export type AssetInfo = {
  asset_id?: string
  state: string
  mime_type: string
  /** staged = kept on estómago only until the post that uses it is saved. */
  m_sync_state?: 'staged' | 'pending' | 'synced' | 'out_of_scope'
}

export class ContentRequestError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(status: number, code: string | undefined, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const operationKey = (purpose: string) => `ui-${purpose}-${crypto.randomUUID()}`
export const assetPath = (id: string) => `/api/v1/assets/${encodeURIComponent(id)}`
export const referencePath = (id: string) => `/api/v1/content/moment-references/${encodeURIComponent(id)}`
/** Abandon the draft upload only while the server still regards it as staged. */
export const discardStagedUpload = (id: string) => readContent<unknown>(`${assetPath(id)}?staged=1`, { method: 'DELETE' }).catch(() => undefined)

export async function readContent<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload === null) {
    throw new ContentRequestError(response.status, payload?.error?.code, payload?.error?.message ?? `请求未完成（HTTP ${response.status}）`)
  }
  return payload as T
}

export function writeContent<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', key: string, revision?: number, body?: string): Promise<T> {
  const headers: Record<string, string> = { 'Idempotency-Key': key }
  if (revision !== undefined) headers['If-Match'] = `"${revision}"`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return readContent<T>(path, { method, headers, body })
}
