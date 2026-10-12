/* The existing single-owner pairing credential becomes an HttpOnly session. */
(() => {
  'use strict';
  const panel = document.getElementById('login-panel');
  const form = document.getElementById('login-form');
  const password = document.getElementById('password');
  const submit = document.getElementById('login-submit');
  const message = document.getElementById('login-message');
  let busy = false, leaving = false, sessionCheck = 0;

  function enterHome() {
    if (leaving) return;
    leaving = true;
    password.value = '';
    location.replace('/');
  }

  async function resumeSession() {
    const check = ++sessionCheck;
    try {
      const response = await fetch('/api/v1/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const session = await response.json();
      if (check === sessionCheck && !busy && session.authenticated === true) enterHome();
    } catch { /* A failed session probe must not prevent an explicit login attempt. */ }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || leaving || !form.reportValidity()) return;
    const token = password.value.trim();
    if (!token) { message.textContent = '请输入密码。'; password.focus(); return; }
    busy = true;
    ++sessionCheck;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    message.textContent = '正在开门…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
      if (response.ok) {
        const result = await response.json();
        if (result.ok !== true) throw new Error('Invalid login response');
        message.textContent = '';
        enterHome();
      } else if (response.status === 401) {
        message.textContent = '口令不正确，请再试一次。';
      } else if (response.status === 403) {
        message.textContent = '登录请求被拒绝，请刷新后重试。';
      } else {
        message.textContent = '暂时连接不上，请稍后再试。';
      }
    } catch {
      message.textContent = '暂时连接不上，请稍后再试。';
    } finally {
      clearTimeout(timeout);
      busy = false;
      submit.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });

  form.addEventListener('input', () => { if (!busy) message.textContent = ''; });
  panel.addEventListener('keydown', event => event.stopPropagation());
  window.addEventListener('pageshow', event => {
    if (event.persisted) { leaving = false; void resumeSession(); }
  });
  void resumeSession();
})();
