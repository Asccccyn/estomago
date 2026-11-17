// BIND tick 60s→350ms（仅拦截该 interval；fetch 不拦截——M 走真实服务）
const interval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) =>
  interval(fn, ms === 60000 && String(fn).includes('this.sourceBindTick()') ? 1500 : ms, ...args);
