import { useEffect, useMemo, useState, useSyncExternalStore, useRef } from 'react'
import { EstomagoClient } from './chat-client'

export function useEstomago() {
  const client = useMemo(() => new EstomagoClient(), [])
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
  useEffect(() => { void client.start(); return client.stop }, [client])
  const [rec, setRec] = useState<number | null>(null)
  const [recSecs, setRecSecs] = useState(0)
  const [recPaused, setRecPaused] = useState(false)
  const pausedRef = useRef(false)
  const clock = useRef({ activeMs: 0, resumedAt: 0 })
  const recording = useRef<{ generation: number; starting: boolean; recorder: MediaRecorder | null; stream: MediaStream | null; cancelled: boolean }>({generation:0,starting:false,recorder:null,stream:null,cancelled:false})
  const stopRec = (sendIt: boolean) => {
    const r=recording.current;r.generation++;r.cancelled=!sendIt
    if(r.recorder&&r.recorder.state!=='inactive')r.recorder.stop()
    else r.stream?.getTracks().forEach(t=>t.stop())
  }
  useEffect(() => {
    const end=()=>stopRec(false)
    window.addEventListener('pagehide',end)
    return ()=>{end();window.removeEventListener('pagehide',end)}
  }, [])
  useEffect(() => {
    if(rec===null)return
    // 暂停期间计时冻结（spoken 时长与 UI 一致；MediaRecorder.pause 后无新帧）
    const id=setInterval(()=>{if(pausedRef.current)return;const seconds=Math.floor((clock.current.activeMs+performance.now()-clock.current.resumedAt)/1000);setRecSecs(seconds);if(seconds>=120)stopRec(true)},200)
    return ()=>clearInterval(id)
  }, [rec])
  const pauseRec = () => {
    const r=recording.current
    if(!r.recorder)return
    if(r.recorder.state==='recording'){r.recorder.pause();clock.current.activeMs+=performance.now()-clock.current.resumedAt;pausedRef.current=true;setRecPaused(true)}
    else if(r.recorder.state==='paused'){r.recorder.resume();clock.current.resumedAt=performance.now();pausedRef.current=false;setRecPaused(false)}
  }
  const startRec = async () => {
    const r=recording.current
    if(r.starting||r.recorder)return
    if(client.snapshot.attachments.length){client.notify('请先发送或移除当前附件');return}
    if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){client.notify('此访问环境不支持录音，请使用支持麦克风的安全连接');return}
    r.starting=true;const generation=++r.generation
    try{
      pausedRef.current=false;setRecPaused(false)
      if(!await client.voiceAvailable()||generation!==r.generation)return
      const mime=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t))
      if(!mime){client.notify('当前浏览器没有可用录音格式');return}
      const stream=await navigator.mediaDevices.getUserMedia({audio:true})
      if(generation!==r.generation||client.snapshot.attachments.length){stream.getTracks().forEach(t=>t.stop());return}
      r.stream=stream;r.cancelled=false
      const recorder=new MediaRecorder(stream,{mimeType:mime});r.recorder=recorder
      const chunks:Blob[]=[];let failed=false
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)}
      recorder.onerror=()=>{failed=true;stopRec(false);client.notify('录音中断，请重试')}
      recorder.onstop=()=>{
        stream.getTracks().forEach(t=>t.stop());r.stream=null;r.recorder=null;setRec(null);pausedRef.current=false;setRecPaused(false)
        if(r.cancelled||failed)return
        const file=new Blob(chunks,{type:recorder.mimeType||mime})
        if(file.size)void client.queue(file,'语音','voice')
        else client.notify('没有录到音频')
      }
      recorder.start(1000);clock.current={activeMs:0,resumedAt:performance.now()};setRecSecs(0);setRec(Date.now())
    }catch{r.stream?.getTracks().forEach(t=>t.stop());r.stream=null;r.recorder=null;client.notify('无法开始录音，请检查麦克风权限')}
    finally{r.starting=false}
  }
  const onPick = (file?: File) => {
    if(!file)return
    if(recording.current.starting||recording.current.recorder){client.notify('请先结束录音');return}
    if(!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type)){client.notify('当前支持 PNG、JPEG、GIF 和 WebP 图片');return}
    void client.queue(file,file.name)
  }
  const copy = async (text:string) => {
    try{
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text)
      else {
        const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select()
        const copied=document.execCommand('copy');area.remove();if(!copied)throw new Error()
      }
    }catch{client.notify('复制暂不可用，可以长按正文复制')}
  }
  return {client,state,rec,recSecs,recPaused,startRec,stopRec,pauseRec,onPick,copy}
}
