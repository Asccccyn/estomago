// B6/N0（2026-10-24）：平台音频适配合同冻结（P2 前的极小合同——具体名称复用现有实现）。
// 浏览器实现=src/call-client.ts（首例参照）；未来 iOS Swift 模块实现同一合同。
// 边界（CallHome 原位吸收 MD §7）：PCM 不经逐帧 JavaScript↔Swift 文本桥接；
// 页面休眠≠音频会话丢失；采样率/蓝牙路由/AEC/CallKit 激活属原生适配细节，不进对话核心。
// 本文件只冻结形状，不实现任何平台功能（未写满未来所有平台——按需要再扩）。

/** 平台音频会话句柄：由平台实现创建与持有 */
export interface PlatformAudioSession {
  /** 开始采集/播放（在用户手势内调用；返回失败=权限拒绝/设备占用，如实上抛） */
  start(): Promise<void>;
  /** 停止并释放全部设备资源（幂等） */
  stop(): Promise<void>;
  /** 静音/恢复上行（本地策略；恢复后新输入自动开始） */
  setMuted(muted: boolean): void;
  /** 当前音频路由描述（如 'browser-default' / 'earpiece' / 'speaker' / 'bluetooth'；平台如实报告） */
  route(): string;
  /** 上行 PCM 帧（16k/mono/Int16LE）——浏览器由 AudioWorklet 产生；iOS 由原生引擎回调桥接（批帧，非逐帧文本桥） */
  onUplinkFrame(cb: (pcm: Int16Array) => void): () => void;
  /** 下行 PCM 播放（帧率以 header 为准） */
  play(pcm: Int16Array, rateHz: number): void;
  /** 本播放流已排空（drain 事实；Core 侧 playback_drained 的本地依据） */
  onPlaybackDrained(cb: (streamId: string) => void): () => void;
  /** 系统中断/恢复（电话打断、路由变化、页面休眠恢复——平台如实上报，不静默丢会话） */
  onInterruption(cb: (event: { kind: 'began' | 'ended' | 'route-changed' | 'session-lost'; detail?: string }) => void): () => void;
  /** 采集电平（0..1；UI 电平条用） */
  onLevel(cb: (rms: number) => void): () => void;
  /** 错误（权限/设备/路由失败——如实分类，不伪称静音） */
  onError(cb: (err: { kind: 'permission-denied' | 'device-unavailable' | 'route-failed' | 'engine-failed'; message: string }) => void): () => void;
}

/** 平台工厂：每通电话创建一个会话；实现方负责生命周期（挂断=stop+释放） */
export type PlatformAudioFactory = () => PlatformAudioSession;

/** 已冻结的输入标识/播放进度语义（与 Siren 协议 v2 对齐；不改协议） */
export type AudioInputIdentity = { inputId: string };
export type PlaybackProgress = { streamId: string; playedMs: number; basis: 'client_reported' | 'unknown' };
