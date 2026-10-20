import { canSend, buildOutgoingDraft } from '../../src/composer-logic.js'
import type { SystemAlert } from './SystemAlerts'
export type Step = { kind: 'think' | 'tool'; text: string }
export type Media = { kind: 'voice' | 'image'; src: string; text?: string }
export type ChatMessage = { id: string; role: 'user' | 'ai'; text: string; time: string; dateKey?: string; dateLabel?: string; tokens?: number; thinkSecs?: number; steps?: Step[]; pending?: boolean; streaming?: boolean; system?: boolean; kind?: 'voice' | 'image'; src?: string; dur?: number; media?: Media[]; turnId?: string; replyState?: string; canRetry?: boolean; retryReason?: string; editPending?: boolean; editUnconfirmed?: boolean }
export type Attachment = { id: string; file: Blob; name: string; kind: 'image' | 'voice'; assetId?: string; status: 'uploading' | 'transcribing' | 'ready' | 'failed' | 'uncertain'; error?: string; operationId: string; transcriptionId?: string; busy?: boolean }
export type WorkItem = { id: string; t: string; d: string; at: string; icon?: string; href?: string }
export type ActivityItem = { id: string; at: string; t: string; d: string }
type Json = Record<string, any>
type Dependencies = { fetch?: typeof fetch; eventSource?: (url: string) => EventSource; redirect?: () => void }
export type Snapshot = {
  messages: ChatMessage[]; draft: string; composing: boolean; sending: boolean; attachments: Attachment[];
  models: string[]; modelIds: string[]; model: number; efforts: string[]; effort: number; canConfigure: boolean;
  context: { used: number | null; limit: number | null; lastActual: number | null; cacheRead: number | null; soft: number | null; reference: number | null };
  workbench: WorkItem[]; activity: ActivityItem[]; panelNote: string;
  notice: string; ready: boolean; hasEarlier: boolean; selected: Set<string>; selectionMode: boolean; draftEstimate: Json | null;
  hasLater: boolean; loadingEarlier: boolean; loadingLater: boolean; historyLoading: boolean; historyError: string;
  historyMode: 'latest' | 'date'; historyDate: string | null; historyTimezone: string; historyVersion: number; newMessages: boolean;
  route: Json | null; alerts: SystemAlert[]; unreadAlerts: number; openAlerts: number;
  alertsError: string; alertsHasMore: boolean; usage: Record<string, Json>;
}
const number = (x: unknown): number | null => typeof x === 'number' && Number.isFinite(x) ? x : null
const time = (x: string,timezone?:string) => new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false,...(timezone?{timeZone:timezone}:{}) })
const HISTORY_PAGE_SIZE = 50
const historyFormatters = new Map<string,Intl.DateTimeFormat>()
const historyDay = (x:string,timezone:string):string => {
  const value=new Date(x);if(!Number.isFinite(value.getTime()))return ''
  let formatter=historyFormatters.get(timezone)
  if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});historyFormatters.set(timezone,formatter)}
  return formatter.format(value)
}
const retryReasons: Record<string,string> = {
  RETRY_NOT_LATEST:'这条之后已有新消息，仅保存修改，不重新生成后续对话。',
  RETRY_CONVERSATION_BUSY:'当前正在回复，请等本轮结束。',
  RETRY_ROUTE_PENDING:'请先处理当前待确认的操作。',
  RETRY_HAS_REPLY:'本轮已有回复内容，不能直接重放整轮。',
  RETRY_HAS_TOOL_ACTIVITY:'本轮已调用工具，不能直接重复执行。',
  RETRY_CONTEXT_CHANGED:'聊天窗口已变化，不能在原窗口重试。',
  RETRY_CONTEXT_UNAVAILABLE:'原窗口状态暂不可核实。',
  RETRY_INPUT_IN_HISTORY:'这条已进入后续对话历史，仅保存修改。',
  RETRY_DRIVER_UNSUPPORTED:'当前通道暂不支持原位重试。',
  RETRY_RESPONSE_STARTED:'服务端已开始处理过本轮，暂不直接重放，以免重复回复或工具操作。',
}
type EditOperation = { key:string; content:string; revision:number; resend:boolean }
const operationId = () => {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
export const shortModel = (x: string) => x.split('/').pop()!.replace(/^claude-/, '').replace(/(opus|sonnet|haiku|fable)-(?=\d)/g, '$1')
export class EstomagoClient {
  private transport: typeof fetch
  private sourceFactory: (url: string) => EventSource
  private redirect: () => void
  private listeners = new Set<() => void>()
  private raw = new Map<string, Json>()
  private blocks = new Map<string, Json[]>()
  private toolSteps = new Map<string, Step[]>()
  private running = new Set<string>()
  private turnFailures = new Map<string, ActivityItem>()
  private refreshes = new Map<string, { dirty: boolean; busy: boolean; attempt?: string }>()
  private source: EventSource | null = null
  private started = false
  private redirecting = false
  private generation = 0
  private cursor = 0
  private draftRevision = 0
  private pending: { id: string; draft: string; revision: number; entries: Attachment[]; body: Json } | null = null
  private edits = new Map<string,EditOperation>()
  private editBusy = new Set<string>()
  private replyRefreshes = new Map<string,{dirty:boolean;busy:boolean}>()
  private historyEpoch = 0
  private viewSnapshotFloor = 0
  private historyEvents: Json[] = []
  private detailsLoaded = new Set<string>()
  private estimateTimer: ReturnType<typeof setTimeout> | undefined
  private estimateGeneration = 0
  private runtime: Json = {}
  private selectionKey: string | null = null
  private routeEdit: string | null = null
  private panelRequest = 0
  private alertsOpen = false
  private alertsRefresh: Promise<void> | null = null
  private alertsDirty = false
  private alertsListRequested = false
  private alertsCursor: string | null = null
  snapshot: Snapshot = {
    messages: [], draft: '', composing: false, sending: false, attachments: [],
    models: ['未配置'], modelIds: [], model: 0, efforts: ['未知'], effort: 0, canConfigure: false,
    context: {used:null,limit:null,lastActual:null,cacheRead:null,soft:null,reference:null},
    workbench: [], activity: [], panelNote: '', notice: '', ready: false, hasEarlier: false,
    selected: new Set(), selectionMode: false, draftEstimate:null, route: null,
    hasLater:false,loadingEarlier:false,loadingLater:false,historyLoading:false,historyError:'',
    historyMode:'latest',historyDate:null,historyTimezone:'Asia/Shanghai',historyVersion:0,newMessages:false,
    alerts: [], unreadAlerts: 0, openAlerts: 0, alertsError: '', alertsHasMore: false, usage: {},
  }
  constructor(deps: Dependencies = {}) {
    this.transport = deps.fetch ?? globalThis.fetch.bind(globalThis)
    this.sourceFactory = deps.eventSource ?? (url => new EventSource(url))
    this.redirect = deps.redirect ?? (() => location.replace('/login'))
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.snapshot
  private patch(change: Partial<Snapshot>) { this.snapshot = {...this.snapshot,...change}; this.listeners.forEach(fn=>fn()) }
  notify = (message: string) => this.patch({notice:message})
  private async request(url: string, init: RequestInit = {}): Promise<Json> {
    const response = await this.transport('/api/v1'+url,{credentials:'same-origin',cache:'no-store',...init})
    if (response.status===401) { if(!this.redirecting){this.redirecting=true;this.patch({ready:false});this.stop();this.redirect()} throw new Error('需要重新登录') }
    const data = await response.json().catch(()=>({}))
    if (!response.ok) { const error = new Error(data.error?.message || '请求未完成，请重试') as Error & {code?:string;status?:number}; error.code=data.error?.code;error.status=response.status; throw error }
    return data
  }
  private json(method: string, body: unknown, headers: Record<string,string> = {}): RequestInit {
    return {method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}
  }
  start = async () => {
    if(this.started||this.redirecting)return
    this.started=true; const generation=++this.generation
    try {
      await this.request('/auth/session')
      if(!this.started||generation!==this.generation)return
      const data=await this.request('/conversations/primary/messages?limit='+HISTORY_PAGE_SIZE+'&order=latest&snapshot=1')
      if(!this.started||generation!==this.generation)return
      if(!Array.isArray(data.messages))throw new Error('聊天记录暂不可用')
      this.replacePage(data,'latest',null)
      this.patch({ready:true})
      this.connect()
      await this.loadRuntime()
      if(!this.started||generation!==this.generation)return
      for(const id of this.running)this.refreshReasoning(id)
      void this.loadContext();void this.loadAlerts(false)
    } catch(error) { if(this.started&&generation===this.generation){this.started=false;this.notify((error as Error).message)} }
  }
  stop = () => { this.started=false;this.generation++;this.historyEpoch++;this.source?.close();this.source=null;this.historyEvents=[];clearTimeout(this.estimateTimer) }
  private replacePage(data:Json,mode:'latest'|'date',date:string|null) {
    this.raw.clear();this.blocks.clear();this.toolSteps.clear();this.detailsLoaded.clear();this.running.clear()
    for(const message of data.messages??[])this.absorb(message,false)
    for(const turn of data.active_turns??[]){if(['pending','running'].includes(turn.state))this.running.add(turn.turn_id)}
    const floor=number(data.event_cursor)
    if(floor!==null&&Number.isSafeInteger(floor)&&floor>=0){
      this.viewSnapshotFloor=floor
      if(mode==='latest')this.cursor=floor
    }
    // Publish page metadata and its message projection together, so scroll
    // anchoring never observes a new page version with the previous page rows.
    this.snapshot={...this.snapshot,historyMode:mode,historyDate:date,historyTimezone:data.timezone??'Asia/Shanghai',
      hasEarlier:data.has_earlier??(data.messages??[]).length>=HISTORY_PAGE_SIZE,hasLater:data.has_later??false,
      route:data.pending_route??null,usage:{},newMessages:false,historyError:'',historyVersion:this.snapshot.historyVersion+1}
    this.render()
  }
  private historyFetching() {return this.snapshot.historyLoading||this.snapshot.loadingEarlier||this.snapshot.loadingLater}
  private representedBySnapshot(data:Json) {return typeof data.sequence==='number'&&data.sequence<=this.viewSnapshotFloor&&(['message.persisted','message.published','message.edited','turn.started','turn.status','turn.completed','turn.interrupted','route.pending','route.resolved'].includes(data.kind))}
  private drainHistoryEvents() {const buffered=this.historyEvents.splice(0);for(const event of buffered){if(!this.representedBySnapshot(event))this.applyEvent(event)}}
  private async changeHistory(mode:'latest'|'date',date:string|null):Promise<boolean> {
    if(this.editBusy.size||this.edits.size||this.snapshot.selectionMode){this.notify('请先完成编辑或退出多选，再切换历史');return false}
    const epoch=++this.historyEpoch,generation=this.generation
    const reconnect=mode==='latest'
    // Keep events already consumed from SSE until a successful snapshot covers
    // them. If this read fails they must still be applied before reconnecting.
    if(reconnect){this.source?.close();this.source=null}
    this.patch({historyLoading:true,loadingEarlier:false,loadingLater:false,historyError:''})
    try{
      const locator=mode==='latest'?'order=latest':'date='+encodeURIComponent(date!)
      const data=await this.request('/conversations/primary/messages?limit='+HISTORY_PAGE_SIZE+'&'+locator+'&snapshot=1')
      if(epoch!==this.historyEpoch||generation!==this.generation||!this.started)return false
      if(!Array.isArray(data.messages))throw new Error('历史记录暂不可用，请重试')
      this.replacePage(data,mode,date)
      for(const id of this.running){if(this.visibleTurn(id))this.refreshReasoning(id)}
      return true
    }catch(error){if(epoch===this.historyEpoch&&generation===this.generation)this.patch({historyError:(error as Error).message});return false}
    finally{
      if(epoch===this.historyEpoch&&generation===this.generation&&this.started){
        this.patch({historyLoading:false});this.drainHistoryEvents()
        if(!this.source)this.connect()
      }
    }
  }
  jumpToDate = (date:string):Promise<boolean> => this.changeHistory('date',date)
  returnToLatest = ():Promise<boolean> => this.changeHistory('latest',null)
  private connect() {
    this.source?.close()
    const source=this.sourceFactory('/api/v1/events?conversation_id=primary&cursor='+this.cursor)
    this.source=source
    // 全局告警可能在断线期间产生；每次 SSE 建立/重连都重查持久快照。
    source.onopen=()=>{if(this.source===source&&this.started){void this.loadAlerts(this.alertsOpen);this.refreshLatestReply()}}
    source.onmessage=event=>{
      if(this.source!==source||!this.started)return
      try {this.handleEvent(JSON.parse(event.data))}catch{/* Invalid events do not become messages. */}
    }
    let checking=false
    source.onerror=()=>{
      if(checking||this.source!==source)return
      checking=true
      void this.request('/auth/session').catch(()=>{}).finally(()=>{checking=false})
    }
  }
  private absorb(dto: Json, update=true):boolean {
    if(typeof dto.id!=='string'||!dto.revision||typeof dto.revision.content!=='string')return false
    const old=this.raw.get(dto.id)
    if(old&&(old.revision.revision>dto.revision.revision||(!update&&old.revision.revision===dto.revision.revision)))return false
    if(old&&old.revision.revision===dto.revision.revision){
      // A delayed POST snapshot must not regress an attempt already completed by SSE.
      const previous=old.reply_status,next=dto.reply_status
      const regresses=previous?.attempt_id&&previous.attempt_id===next?.attempt_id
        &&['completed','failed','blocked','interrupted'].includes(previous.state)&&['pending','running'].includes(next.state)
      if(next&&!regresses&&JSON.stringify(previous)!==JSON.stringify(next)){this.raw.set(dto.id,{...old,reply_status:next});return true}
      return false
    }
    this.raw.set(dto.id,dto)
    return true
  }
  private latestOwner() {return [...this.raw.values()].filter(m=>m.speaker==='owner').sort((a,b)=>b.sequence-a.sequence)[0]}
  private refreshLatestReply(turnId?:string) {
    const owner=this.latestOwner()
    if(owner&&(!turnId||owner.turn_id===turnId))void this.refreshReply(owner.id)
  }
  private async refreshReply(id:string):Promise<void> {
    let entry=this.replyRefreshes.get(id)
    if(!entry){entry={dirty:false,busy:false};this.replyRefreshes.set(id,entry)}
    entry.dirty=true
    if(entry.busy)return
    entry.busy=true
    const generation=this.generation,epoch=this.historyEpoch
    try{
      do{
        entry.dirty=false
        const data=await this.request('/conversations/primary/messages/'+encodeURIComponent(id))
        if(this.started&&generation===this.generation&&epoch===this.historyEpoch&&!entry.dirty&&data.message&&this.raw.has(id)){if(this.absorb(data.message))this.render()}
      }while(entry.dirty&&this.started&&generation===this.generation)
    }catch{/* Unknown retry eligibility stays disabled; never discard message text. */}
    finally{entry.busy=false}
  }
  private render() {
    const messages: ChatMessage[]=[]
    const latestOwner=this.latestOwner()?.id
    const latestSequence=Math.max(0,...[...this.raw.values()].map(m=>m.sequence))
    for(const m of [...this.raw.values()].sort((a,b)=>a.sequence-b.sequence)){
      if(!['owner','assistant','system'].includes(m.speaker))continue
      const media:Media[]=(m.revision.attachments??[]).map((a:Json)=>({
        kind:a.presentation==='voice'?'voice':'image',src:'/api/v1/assets/'+encodeURIComponent(a.asset_id)+'/content',text:a.derived_text??'',
      }))
      const blocks=this.blocks.get(m.turn_id)??[]
      const thinkMs=blocks.length?Math.max(0,new Date(blocks[blocks.length-1]!.updated_at).getTime()-new Date(blocks[0]!.created_at??blocks[0]!.updated_at).getTime()):0
      const steps:Step[]=[
        ...blocks.map(b=>({kind:'think' as const,text:b.text||({redacted:'已删隐',omitted:'未返回可读摘要',no_block:'本轮未返回可读摘要'} as Json)[b.visibility]||''})).filter(b=>b.text),
        ...(this.toolSteps.get(m.turn_id)??[]),
      ]
      messages.push({id:m.id,role:m.speaker==='owner'?'user':'ai',text:m.revision.content||media.find(a=>a.kind==='voice')?.text||'',
        time:time(m.created_at??m.revision.occurred_at,this.snapshot.historyTimezone),dateKey:historyDay(m.created_at??m.revision.occurred_at,this.snapshot.historyTimezone),dateLabel:historyDay(m.created_at??m.revision.occurred_at,this.snapshot.historyTimezone),tokens:m.speaker==='assistant'&&m.revision.content?Math.ceil([...m.revision.content].length/2.5):undefined,
        steps,turnId:m.turn_id,system:m.speaker==='system',kind:media[0]?.kind,src:media[0]?.src,media,
        replyState:m.reply_status?.state,
        canRetry:m.speaker==='owner'&&Boolean(this.edits.has(m.id)?this.edits.get(m.id)!.resend:(m.id===latestOwner&&m.sequence===latestSequence&&m.reply_status?.can_retry&&!this.running.size)),
        retryReason:retryReasons[m.reply_status?.reason]??undefined,editPending:this.editBusy.has(m.id),editUnconfirmed:this.edits.has(m.id)&&!this.editBusy.has(m.id),
        thinkSecs:thinkMs>0?Math.max(1,Math.round(thinkMs/1000)):undefined})
    }
    for(const id of this.running){
      if(this.snapshot.historyMode==='date'&&!messages.some(m=>m.turnId===id))continue
      const last=messages.filter(m=>m.turnId===id&&m.role==='ai'&&!m.system).at(-1)
      if(last){last.streaming=true;continue}
      messages.push({id:'pending:'+id,turnId:id,role:'ai',text:'',time:'',pending:true,steps:[
        ...(this.blocks.get(id)??[]).filter(b=>b.text).map(b=>({kind:'think' as const,text:b.text})),
        ...(this.toolSteps.get(id)??[]),
      ]})
    }
    this.patch({messages})
  }
  handleEvent(data: Json) {
    if(typeof data.sequence==='number'){if(data.sequence<=this.cursor)return;this.cursor=data.sequence}
    if(this.historyFetching()){this.historyEvents.push(data);return}
    if(this.representedBySnapshot(data))return
    this.applyEvent(data)
  }
  private applyEvent(data:Json) {
    const id=data.turn_id as string|undefined
    if(['message.persisted','message.published','message.edited'].includes(data.kind)&&data.message){
      const message=data.message
      const visible=this.raw.has(message.id)
      const min=Math.min(...[...this.raw.values()].map(m=>m.sequence))
      const max=Math.max(0,...[...this.raw.values()].map(m=>m.sequence))
      if(visible||(this.snapshot.historyMode==='latest'&&(!Number.isFinite(min)||message.sequence>=min))){
        if(this.absorb(message))this.render()
      }else if(data.kind!=='message.edited'&&message.sequence>max)this.patch({newMessages:true,hasLater:this.raw.size>0})
    }
    if(id&&data.kind==='turn.started'){this.running.add(id);this.markReplyState(id,'running',data.attempt_id);this.render()}
    if(id&&data.kind==='turn.status'){
      this.markReplyState(id,data.state,data.attempt_id)
      if(data.state==='running')this.running.add(id)
      else {
        this.running.delete(id)
        if(data.state==='blocked'||data.state==='failed'){
          const reason=typeof data.reason==='string'?data.reason:''
          this.notify(reason.split(':')[0]==='MODEL_VISION_UNAVAILABLE'
            ?'暂时无法核实模型的图片能力，本轮未发送；消息已保存，请稍后重试。'
            :'本轮暂未完成，可在活动日志查看状态')
          // The context event endpoint omits turn.status; retain failures from live
          // events and SSE replay so opening the activity panel does not hide them.
          const failure:ActivityItem={id:'turn-status:'+id+':'+(data.sequence??data.attempt_id??data.state),at:typeof data.occurred_at==='string'?time(data.occurred_at):'',t:'本轮未完成',d:[data.state,reason].filter(Boolean).join(' · ')}
          this.turnFailures.set(failure.id,failure)
          this.patch({activity:[failure,...this.snapshot.activity.filter(item=>item.id!==failure.id)]})
        }
      }
      this.render()
      this.refreshLatestReply(id)
    }
    if(id&&['turn.completed','turn.interrupted'].includes(data.kind)){this.running.delete(id);this.markReplyState(id,data.kind==='turn.completed'?'completed':'interrupted',data.attempt_id);this.render();this.refreshLatestReply(id);if(this.visibleTurn(id))this.refreshReasoning(id,data.attempt_id);void this.loadContext()}
    if(id&&data.kind?.startsWith('reasoning.')&&this.visibleTurn(id))this.refreshReasoning(id,data.attempt_id)
    if(id&&data.kind==='turn.tool'){
      const label=String(data.label??data.tool??'')
      if(label&&this.visibleTurn(id)){const arr=this.toolSteps.get(id)??[];arr.push({kind:'tool',text:label+(data.ok===false?'（失败）':'')});this.toolSteps.set(id,arr);this.render()}
    }
    if(id&&data.kind==='usage.updated'&&this.visibleTurn(id))void this.loadUsage(id)
    if(data.kind==='route.pending')this.patch({route:data})
    if(data.kind==='route.resolved'){this.patch({route:null});if(data.message){this.absorb(data.message);this.render()}}
    if(data.kind==='system.alert.changed')void this.loadAlerts(this.alertsOpen)
    if(data.kind==='context.warning')void this.loadContext()
    if(data.kind==='window.rotated'){void this.loadRuntime();void this.loadContext()}
  }
  private visibleTurn(id:string) {return [...this.raw.values()].some(message=>message.turn_id===id)}
  private markReplyState(turnId:string,state:string,attemptId?:string) {
    for(const [id,m] of this.raw){if(m.speaker==='owner'&&m.turn_id===turnId){
      this.raw.set(id,{...m,reply_status:{...m.reply_status,state,attempt_id:attemptId??m.reply_status?.attempt_id,can_retry:false}})
      const refresh=this.replyRefreshes.get(id);if(refresh)refresh.dirty=true
    }}
  }
  private refreshReasoning(id:string,attempt?:string) {
    let entry=this.refreshes.get(id)
    if(!entry){entry={dirty:false,busy:false};this.refreshes.set(id,entry)}
    entry.dirty=true;entry.attempt=attempt??entry.attempt
    if(entry.busy)return
    entry.busy=true
    void (async()=>{
      try {while(entry!.dirty&&this.started){entry!.dirty=false;const epoch=this.historyEpoch;const result=await this.request('/turns/'+encodeURIComponent(id)+'/reasoning'+(entry!.attempt?'?attempt_id='+encodeURIComponent(entry!.attempt):''));if(epoch===this.historyEpoch&&this.visibleTurn(id)&&JSON.stringify(this.blocks.get(id)??[])!==JSON.stringify(result.blocks??[])){this.blocks.set(id,result.blocks??[]);this.render()}}}
      catch {/* A failed projection does not discard saved messages. */}
      finally{entry!.busy=false;if(entry!.dirty&&this.started)this.refreshReasoning(id,entry!.attempt)}
    })()
  }
  private async loadUsage(id:string) {const epoch=this.historyEpoch;try{const data=await this.request('/turns/'+encodeURIComponent(id)+'/usage');if(epoch===this.historyEpoch&&this.visibleTurn(id))this.patch({usage:{...this.snapshot.usage,[id]:data}})}catch{}}
  loadTurnDetails = async (id:string):Promise<void> => {
    if(this.detailsLoaded.has(id)||!this.visibleTurn(id))return
    const epoch=this.historyEpoch
    const data=await this.request('/turns/'+encodeURIComponent(id)+'/reasoning')
    if(epoch!==this.historyEpoch||!this.visibleTurn(id))return
    this.blocks.set(id,data.blocks??[]);this.detailsLoaded.add(id);this.render()
    await this.loadUsage(id)
  }
  private async extendHistory(direction:'before'|'after'):Promise<boolean> {
    if(this.historyFetching()||!this.started||(direction==='before'?!this.snapshot.hasEarlier:!this.snapshot.hasLater))return false
    const values=[...this.raw.values()].map(m=>m.sequence)
    const boundary=direction==='before'?Math.min(...values):Math.max(...values)
    if(!Number.isFinite(boundary))return false
    const epoch=this.historyEpoch,generation=this.generation
    this.patch({loadingEarlier:direction==='before',loadingLater:direction==='after',historyError:''})
    try{
      const data=await this.request('/conversations/primary/messages?limit='+HISTORY_PAGE_SIZE+'&'+direction+'='+boundary)
      if(epoch!==this.historyEpoch||generation!==this.generation||!this.started)return false
      if(!Array.isArray(data.messages))throw new Error('历史记录暂不可用，请重试')
      for(const message of data.messages)this.absorb(message,false)
      this.patch(direction==='before'?{hasEarlier:data.has_earlier??data.messages.length>=HISTORY_PAGE_SIZE}:{hasLater:data.has_later??data.messages.length>=HISTORY_PAGE_SIZE})
      this.render();return true
    }catch(error){if(epoch===this.historyEpoch&&generation===this.generation)this.patch({historyError:(error as Error).message});return false}
    finally{if(epoch===this.historyEpoch&&generation===this.generation&&this.started){this.patch({loadingEarlier:false,loadingLater:false});this.drainHistoryEvents()}}
  }
  loadEarlier = ():Promise<boolean> => this.extendHistory('before')
  loadLater = ():Promise<boolean> => this.extendHistory('after')
  private scheduleEstimate() {this.estimateGeneration++;this.patch({draftEstimate:null});clearTimeout(this.estimateTimer);this.estimateTimer=setTimeout(()=>void this.estimate(),250)}
  setDraft = (draft:string) => {this.draftRevision++;this.patch({draft});this.scheduleEstimate()}
  setComposing = (composing:boolean) => this.patch({composing})
  private async estimate() {
    const generation=this.estimateGeneration, revision=this.draftRevision
    if(!this.snapshot.draft.trim())return
    const attachments=this.snapshot.attachments.filter(a=>a.status==='ready').map(a=>({asset_id:a.assetId}))
    const signature=JSON.stringify(attachments),modelSignature=JSON.stringify(this.runtime)
    try {
      const data=await this.request('/token-estimates',this.json('POST',{conversation_id:'primary',client_draft_revision:revision,content:this.snapshot.draft,attachments,include_request_estimate:true}))
      if(generation!==this.estimateGeneration||revision!==this.draftRevision||data.client_draft_revision!==revision)return
      if(signature!==JSON.stringify(this.snapshot.attachments.filter(a=>a.status==='ready').map(a=>({asset_id:a.assetId})))||modelSignature!==JSON.stringify(this.runtime))return
      this.patch({draftEstimate:data.estimate??null})
    } catch {/* Estimates must not gate sending. */}
  }
  get canSend() {return this.snapshot.ready&&!this.redirecting&&!this.snapshot.composing&&!this.snapshot.sending&&!this.historyFetching()&&(Boolean(this.pending)||canSend(this.snapshot.draft,{composing:false,hasAttachment:this.snapshot.attachments.some(a=>a.status==='ready')}))}
  send = async () => {
    if(!this.canSend)return
    const draft=this.snapshot.draft
    if(this.routeEdit){
      const revision=this.draftRevision;this.patch({sending:true})
      try{const result=await this.request('/route-decisions/'+encodeURIComponent(this.routeEdit),this.json('POST',{choice:'edit',content:draft}));this.absorb(result.message);this.routeEdit=null;if(revision===this.draftRevision)this.setDraft('');this.patch({route:null});this.render()}catch(e){this.notify((e as Error).message)}finally{this.patch({sending:false})}
      return
    }
    if(!this.pending||(draft!==''&&draft!==this.pending.draft)){
      const id=operationId(),entries=this.snapshot.attachments.filter(a=>a.status==='ready')
      const body:Json=buildOutgoingDraft(draft,id)
      if(entries.length){delete body.kind;body.attachments=entries.map(a=>({asset_id:a.assetId,presentation:a.kind}))}
      this.pending={id,draft,revision:this.draftRevision,entries,body}
    }
    const pending=this.pending;this.patch({sending:true,notice:''})
    try{
      const data=await this.request('/conversations/primary/messages',this.json('POST',pending.body,{'Idempotency-Key':pending.id}))
      this.absorb(data.message);this.render()
      if(this.pending===pending)this.pending=null
      if(this.draftRevision===pending.revision&&this.snapshot.draft===pending.draft)this.setDraft('')
      this.patch({attachments:this.snapshot.attachments.filter(a=>!pending.entries.includes(a))})
    }catch(e){this.notify((e as Error).message+'；草稿已保留，可以重试')}
    finally{this.patch({sending:false})}
  }
  editMessage = async (id:string,content:string,resend=false,expectedRevision?:number):Promise<boolean> => {
    const raw=this.raw.get(id);if(!raw||raw.speaker!=='owner'||this.editBusy.has(id)||this.redirecting||!this.snapshot.ready)return false
    let operation=this.edits.get(id)
    if(operation&&(operation.content!==content||operation.resend!==resend)){
      this.notify('上次提交结果尚未确认，请先按原提交内容重试，确认后再修改。');return false
    }
    if(!operation){
      if(!resend&&content===raw.revision.content)return true
      operation={key:operationId(),content,revision:expectedRevision??raw.current_revision,resend}
      this.edits.set(id,operation)
    }
    this.editBusy.add(id);const refresh=this.replyRefreshes.get(id);if(refresh)refresh.dirty=true
    this.patch({notice:''});this.render()
    try{
      const result=await this.request('/conversations/primary/messages/'+encodeURIComponent(id)+(operation.resend?'/retry':''),
        this.json(operation.resend?'POST':'PUT',{content:operation.content},{'If-Match':'"'+operation.revision+'"','Idempotency-Key':operation.key}))
      if(!result.message)throw new Error('提交结果尚未确认，请重试')
      this.absorb(result.message);this.edits.delete(id)
      void this.refreshReply(id)
      this.notify(operation.resend?'已重新发起回复':'修改已保存')
      return true
    }catch(error){
      const e=error as Error&{status?:number;code?:string}
      if(e.status&&e.status<500){this.edits.delete(id);void this.refreshReply(id)}
      this.notify(e.message+'；编辑内容已保留')
      return false
    }finally{this.editBusy.delete(id);this.render()}
  }
  retryMessage = async (id:string):Promise<boolean> => {
    const pending=this.edits.get(id)
    return this.editMessage(id,pending?.content??this.originalText(id),pending?.resend??true,pending?.revision)
  }
  messageRevision = (id:string):number => this.edits.get(id)?.revision??this.raw.get(id)?.current_revision??0
  editText = (id:string):string => this.edits.get(id)?.content??this.originalText(id)
  originalText = (id:string) => this.raw.get(id)?.revision.content??''
  stopTurn = async (id:string) => {try{await this.request('/turns/'+encodeURIComponent(id)+'/stop',{method:'POST'})}catch(e){this.notify((e as Error).message)}}
  queue = async (file:Blob,name:string,kind:'image'|'voice'='image') => {
    if(this.snapshot.attachments.some(a=>a.kind==='voice')||(kind==='voice'&&this.snapshot.attachments.length)){this.notify('请先发送或移除当前附件');return}
    const attachment:Attachment={id:operationId(),file,name,kind,status:'uploading',operationId:operationId()}
    this.patch({attachments:[...this.snapshot.attachments,attachment]});await this.upload(attachment)
  }
  removeAttachment = (id:string) => {this.patch({attachments:this.snapshot.attachments.filter(a=>a.id!==id)});this.scheduleEstimate()}
  retryAttachment = async (id:string) => {const a=this.snapshot.attachments.find(a=>a.id===id);if(a)await this.upload(a)}
  private async upload(a:Attachment) {
    if(a.busy)return
    a.busy=true;a.status='uploading';this.patch({attachments:[...this.snapshot.attachments]})
    try{
      if(!a.assetId){const asset=await this.request('/assets?purpose='+(a.kind==='voice'?'chat_voice':'chat_image'),{method:'POST',headers:{'Content-Type':'application/octet-stream','Idempotency-Key':a.operationId},body:a.file});a.assetId=asset.asset_id}
      if(a.kind==='voice'){
        a.status='transcribing';this.patch({attachments:[...this.snapshot.attachments]})
        a.transcriptionId??=operationId()
        await this.request('/assets/'+encodeURIComponent(a.assetId!)+'/transcribe',this.json('POST',{conversation_id:'primary'},{'Idempotency-Key':a.transcriptionId}))
      }
      a.status='ready'
    }catch(error){
      const e=error as Error&{code?:string};a.error=e.message
      a.status=['voice_transcription_unconfirmed','siren_outcome_unknown'].includes(e.code??'')?'uncertain':'failed'
      if(e.code&&a.status==='failed')a.transcriptionId=undefined
    }finally{a.busy=false;this.patch({attachments:[...this.snapshot.attachments]});this.scheduleEstimate()}
  }
  voiceAvailable = async () => {try{const result=await this.request('/voice/status');if(!result.available)this.notify('语音服务尚未配置');return result.available===true}catch(e){this.notify((e as Error).message);return false}}
  loadRuntime = async () => {
    try {
      const data=await this.request('/runtime-settings');this.runtime=data
      const editable=data.driver==='openrouter'
      let exact=editable?data.or_model?.effective:null
      if(!editable){try{const c=await this.request('/conversations/primary/context-records');if(c.driver===data.driver)exact=c.exactModel}catch{}}
      const ids=[...new Set<string>([...(editable?data.model_options??[]:[]),exact].filter((x):x is string=>typeof x==='string'&&x.length>0))]
      const efforts:string[]=editable?(data.effort_options??['default']):['default']
      const current=data.reasoning_effort?.override??data.reasoning_effort?.effective??'default'
      this.patch({modelIds:ids,models:ids.length?ids.map(shortModel):['未配置'],model:Math.max(0,ids.indexOf(exact)),efforts,effort:Math.max(0,efforts.indexOf(current)),canConfigure:editable})
    }catch(e){this.notify((e as Error).message)}
  }
  setModel = async (index:number) => {
    if(!this.snapshot.canConfigure){this.notify('当前通道不支持此处切换模型');return}
    const id=this.snapshot.modelIds[index];if(!id)return
    try{await this.request('/runtime-settings',this.json('PUT',{or_model:id}));this.estimateGeneration++;await this.loadRuntime();this.notify('模型已切换；下一次发送前可选择携带的历史')}catch(e){this.notify((e as Error).message)}
  }
  setEffort = async (index:number) => {
    if(!this.snapshot.canConfigure)return
    const effort=this.snapshot.efforts[index];if(!effort)return
    try{await this.request('/runtime-settings',this.json('PUT',{reasoning_effort:effort}));this.estimateGeneration++;await this.loadRuntime()}catch(e){this.notify((e as Error).message)}
  }
  loadContext = async () => {
    try{const c=await this.request('/conversations/primary/context-records');this.patch({context:{used:number(c.context?.estimatedInput),limit:number(c.context?.hardCapacity),lastActual:number(c.context?.lastActualInput),soft:number(c.context?.effectiveSoft),cacheRead:number(c.cache?.lastRead),reference:number(c.context?.uiReference)||null}})}catch{}
  }
  loadPanel = async (kind:'bench'|'log') => {
    const request=++this.panelRequest
    this.patch({panelNote:'正在读取…'})
    try{
      if(kind==='bench'){
        const data=await this.request('/content/creations?limit=100')
        if(request!==this.panelRequest)return
        this.patch({workbench:(data.items??[]).map((x:Json)=>({id:x.id,t:x.title||'未命名作品',d:({image:'图片作品',video:'视频作品',html:'小作品'} as Json)[x.work_kind]||'',at:new Date(x.created_at).toLocaleDateString(),icon:x.icon_asset_id?'/api/v1/assets/'+encodeURIComponent(x.icon_asset_id)+'/content':undefined,href:x.work_asset_id?'/api/v1/assets/'+encodeURIComponent(x.work_asset_id)+'/'+(x.work_kind==='html'?'preview':'content'):undefined})),panelNote:data.items?.length?'':'还没有作品'})
      }else{
        const data=await this.request('/conversations/primary/context-records/events?last=1&limit=30')
        if(request!==this.panelRequest)return
        const labels:Json={'archive.sync':'原文同步','context.warning':'上下文提示','review.sent':'换窗检查','review.failed':'检查未完成','window.rotated':'已换窗'}
        const events=(data.events??[]).slice().reverse().map((e:Json)=>({id:e.eventId,at:time(e.occurredAt),t:labels[e.kind]??e.kind,d:typeof e.payload?.state==='string'?e.payload.state:''}))
        const usage=Object.entries(this.snapshot.usage).map(([id,value])=>({id:'usage:'+id,at:'',t:'整轮实际用量',d:`输入 ${value.totals?.input_tokens ?? '未知'} · 输出 ${value.totals?.output_tokens ?? '未知'}`}))
        const failures=[...this.turnFailures.values()].reverse()
        this.patch({activity:[...failures,...events,...usage],panelNote:failures.length||events.length||usage.length?'':'暂无活动记录'})
      }
    }catch(e){if(request===this.panelRequest)this.patch({panelNote:(e as Error).message})}
  }
  beginSelection = () => {this.selectionKey??=operationId();this.patch({selectionMode:true})}
  select = (id:string) => {const selected=new Set(this.snapshot.selected);selected.has(id)?selected.delete(id):selected.add(id);this.selectionKey??=operationId();this.patch({selected,selectionMode:true})}
  cancelSelection = () => {this.selectionKey=null;this.patch({selected:new Set(),selectionMode:false})}
  /** 手动换窗策略（她 2026-10-19 裁定）：选集确认即换窗——确认返回 rotated=false
   *  （无被阻断输入、窗口还开着）时主动调 /rotate 立即换，不等 600k 软线兜底。 */
  rotateNow = async () => {
    try {
      const runtime=await this.request('/conversations/primary/runtime')
      const id=runtime.active_window?.id
      if(!id){this.notify('当前没有活动窗口');return}
      const res=await this.request('/windows/'+encodeURIComponent(id)+'/rotate',this.json('POST',{}))
      this.notify(res?.window?.id?'已换窗':'换窗结果未知，请看活动记录')
      void this.loadContext()
    }catch(e){this.notify('换窗未执行：'+(e as Error).message)}
  }
  confirmSelection = async (empty=false) => {
    try {
      const runtime=await this.request('/conversations/primary/runtime')
      let id=runtime.active_window?.id
      if(!id){const pending=await this.request('/conversations/primary/context-selection');id=pending.selection?.source_window_id}
      if(!id){this.notify('当前没有需要换窗的历史');return}
      const items=empty?[]:[...this.snapshot.selected].map(id=>this.raw.get(id)).filter(Boolean).map(m=>({message_id:m!.id,revision:m!.revision.revision,content_hash:m!.revision.content_hash}))
      if(!items.length&&!empty){this.notify('请选择历史，或明确选择不带历史');return}
      if(!empty)await this.request('/windows/'+encodeURIComponent(id)+'/context-selection/preview',this.json('POST',{conversation_id:'primary',items}))
      const confirmed=await this.request('/windows/'+encodeURIComponent(id)+'/context-selection/confirm',this.json('POST',{conversation_id:'primary',items,explicit_empty:empty,idempotency_key:this.selectionKey??=operationId()}))
      this.cancelSelection()
      // 有被阻断输入时确认已直接换窗续聊（rotated=true）；否则立即手动换
      if(confirmed?.rotated){this.notify('已换窗');void this.loadContext()}
      else{this.notify('选集已确认，正在换窗…');await this.rotateNow()}
    }catch(e){this.notify((e as Error).message)}
  }
  resolveRoute = async (choice:'cancel'|'edit') => {
    const route=this.snapshot.route;if(!route)return
    if(choice==='edit'){
      const original=[...this.raw.values()].find(m=>m.turn_id===route.turn_id&&m.speaker==='owner')
      this.routeEdit=route.decision_id;this.setDraft(original?.revision.content??'');this.patch({route:null});this.notify('修改后点发送，将保存为原消息的新修订');return
    }
    try{await this.request('/route-decisions/'+encodeURIComponent(route.decision_id),this.json('POST',{choice:'cancel'}));this.patch({route:null})}catch(e){this.notify((e as Error).message)}
  }
  setAlertsOpen = (open:boolean) => {this.alertsOpen=open;if(open)void this.loadAlerts()}
  loadAlerts = (list=true):Promise<void> => {
    // 同时只保留一次请求；SSE burst 合并为一次后续重查，旧响应不覆盖新快照。
    this.alertsDirty=true;this.alertsListRequested ||= list
    if(this.alertsRefresh)return this.alertsRefresh
    this.alertsRefresh=(async()=>{
      do{
        this.alertsDirty=false
        const includeList=this.alertsListRequested;this.alertsListRequested=false
        try{
          const summary=await this.request('/system-alerts/summary')
          this.patch({unreadAlerts:summary.unread_anomaly_count??0,openAlerts:summary.open_count??0,alertsError:''})
          if(includeList){
            const data=await this.request('/system-alerts?lifecycle=all&limit=50')
            this.alertsCursor=data.next_cursor??null
            this.patch({alerts:data.items??[],alertsHasMore:Boolean(data.has_more)})
          }
        }catch{this.patch({alertsError:'系统异常状态暂时无法读取，请重试'})}
      }while(this.alertsDirty&&!this.redirecting)
    })().finally(()=>{this.alertsRefresh=null})
    return this.alertsRefresh
  }
  loadMoreAlerts = async () => {
    const cursor=this.alertsCursor;if(!cursor)return
    try{
      const data=await this.request('/system-alerts?lifecycle=all&limit=50&cursor='+encodeURIComponent(cursor))
      if(this.alertsCursor!==cursor)return // 新快照已替换列表，旧续页不得混入。
      const known=new Set(this.snapshot.alerts.map(a=>a.alert_id))
      this.alertsCursor=data.next_cursor??null
      this.patch({alerts:[...this.snapshot.alerts,...(data.items??[]).filter((a:Json)=>!known.has(a.alert_id))],alertsHasMore:Boolean(data.has_more),alertsError:''})
    }catch{this.patch({alertsError:'更早的系统异常暂时无法读取，请重试'})}
  }
  markAlertsRead = async () => {
    try{await this.request('/system-alerts/read',this.json('POST',{items:this.snapshot.alerts.map(a=>({alert_id:a.alert_id,seen_event_sequence:a.last_event_sequence}))}));await this.loadAlerts()}catch(e){this.notify((e as Error).message)}
  }
}
