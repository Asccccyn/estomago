export function microphoneEnvironmentIssue() {
  if (globalThis.isSecureContext === false) return '当前页面不是安全连接，浏览器无法开启麦克风。请使用本站 HTTPS 地址打开。'
  if (!navigator.mediaDevices?.getUserMedia) return '当前浏览器不支持麦克风采集，请在 Safari 或 Chrome 中打开本站 HTTPS 地址。'
  return null
}

/** @param {unknown} error */
export function microphoneErrorMessage(error) {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : null
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限未获允许。请在浏览器的本网站设置中允许麦克风，再点击录音。'
  if (name === 'NotFoundError') return '没有找到可用的麦克风，请检查设备连接。'
  if (name === 'NotReadableError') return '麦克风暂时无法使用，可能正被其他应用占用，请结束占用后重试。'
  return '无法开始录音，请检查麦克风和浏览器权限后重试。'
}

export function secureMicrophoneUrl() {
  const url = new URL(window.location.href)
  // A local development port usually has no TLS listener. Do not invent one.
  if (url.protocol !== 'http:' || url.port || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.local')) return null
  url.protocol = 'https:'
  return url.href
}
