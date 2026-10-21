// Real local Host DB -> persistent event -> HTTP SSE -> production React client.
// No model execution, user messages, external service, or production root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch, pollUntil } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { EstomagoClient } from '../../apps/web/react/src/chat-client.ts';

// Node-side EventSource adapter reads the real wire; reconnect is controlled by the test.
class WireEvents {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  opened = 0;
  received: Array<Record<string, any>> = [];
  controller: AbortController | null = null;
  private pending = new Set<Promise<void>>();
  private url: string;
  private token: string;
  constructor(url: string, token: string) { this.url = url; this.token = token; this.open(); }
  open() {
    const controller = new AbortController(); this.controller = controller;
    const task = (async () => {
      try {
        const response = await fetch(this.url, { headers: { Authorization: `Bearer ${this.token}` }, signal: controller.signal });
        assert.equal(response.status, 200);
        this.opened++; this.onopen?.();
        let buffered = '';
        const decoder = new TextDecoder();
        for await (const chunk of response.body!) {
          buffered += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffered.indexOf('\n\n')) >= 0) {
            const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2);
            const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6);
            if (data) { this.received.push(JSON.parse(data)); this.onmessage?.({ data }); }
          }
        }
      } catch (error) { if (!controller.signal.aborted) throw error; }
    })();
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }
  close() { this.controller?.abort(); }
  async settled() { await Promise.all([...this.pending]); }
}

test('Bootstrap异常由真实HTTP/SSE进入独立系统状态；已读/恢复/重连均如实', { timeout: 20000 }, async () => {
  const root = tempRoot('bootstrap-alerts-http-');
  writeApprovedIdentity(root);
  const config = buildConfig({ deployment: { port: 0 }, ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'mock' } });
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  let client: EstomagoClient | null = null;
  let wire: WireEvents | null = null;
  try {
    await host.start();
    const base = `http://127.0.0.1:${host.port}`;
    const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
    client = new EstomagoClient({
      fetch: async (url, init) => fetch(base + String(url), { ...init,
        headers: { ...init?.headers as Record<string,string>, Authorization: `Bearer ${token}`, Origin: base } }),
      eventSource: url => (wire = new WireEvents(base + url, token)) as unknown as EventSource,
      redirect: () => assert.fail('synthetic authenticated client must stay signed in'),
    });
    await client.start();
    await pollUntil(() => Boolean(wire?.opened));
    // Drain boot/onopen HTTP refresh before observing a new alert, so this
    // assertion exercises SSE delivery rather than racing the initial read.
    await client.loadAlerts(false);
    const before = host.db.prepare('SELECT COUNT(*) n FROM provider_requests').get() as { n: number };
    const key = 'bootstrap:synthetic-window';
    host.alerts!.observe({ code: 'BOOTSTRAP_INCOMPLETE', scopeKind: 'integration', scopeId: 'mariposa',
      dedupeKey: key, observationId: null, safeSummary: {
        title: '部分开窗资料未载全', detail: '只缺心情文字，已保留同快照核验过的 I 和计划。',
        window_id: 'synthetic-window', reason: 'BOOTSTRAP_PAGE_TRANSPORT', count: 1,
        retryable: true, action_taken: 'retained_verified_sections',
        mood_text: 'PRIVATE_MOOD_CANARY', i_body: 'PRIVATE_I_CANARY', plan_body: 'PRIVATE_PLAN_CANARY',
      } });
    await pollUntil(() => client!.snapshot.unreadAlerts === 1
      && Boolean(wire?.received.some(event => event.kind === 'system.alert.changed')));
    assert.equal(client.snapshot.openAlerts, 1);
    assert.ok(wire!.received.some(event => event.kind === 'system.alert.changed'));
    client.setAlertsOpen(true);
    await client.loadAlerts();
    const first = client.snapshot.alerts[0]!;
    assert.equal(first.code, 'BOOTSTRAP_INCOMPLETE');
    assert.equal(first.severity, 'warning');
    assert.match(first.safe_summary!.detail!, /只缺心情文字/);
    await client.markAlertsRead();
    assert.equal(client.snapshot.unreadAlerts, 0);
    assert.equal(client.snapshot.openAlerts, 1);
    assert.equal(client.snapshot.alerts[0]!.lifecycle, 'open');

    host.alerts!.observe({ code: 'BOOTSTRAP_INCOMPLETE', severity: 'critical', scopeKind: 'integration',
      scopeId: 'mariposa', dedupeKey: key, observationId: null,
      safeSummary: { title: '开窗资料无法验证', detail: 'I 未能通过验证，本次开窗停止。',
        reason: 'BOOTSTRAP_I_INVALID', action_taken: 'bootstrap_blocked' } });
    await pollUntil(() => client!.snapshot.alerts[0]?.severity === 'critical');
    assert.equal(client.snapshot.unreadAlerts, 1);
    assert.equal(client.snapshot.alerts[0]!.occurrence_count, 2);

    host.alerts!.resolve(key, { summary: { title: '开窗资料已恢复', detail: '本窗口已经完成完整快照验证。',
      action_taken: 'snapshot_verified_complete', window_id: 'synthetic-window' } });
    await pollUntil(() => client!.snapshot.openAlerts === 0 && client!.snapshot.alerts[0]?.lifecycle === 'resolved');
    assert.equal(client.snapshot.unreadAlerts, 0);

    // Global events are absent from conversation-specific replay; onopen must refresh summary.
    wire!.close(); await wire!.settled();
    host.alerts!.observe({ code: 'BOOTSTRAP_INCOMPLETE', scopeKind: 'integration', scopeId: 'mariposa',
      dedupeKey: 'bootstrap:offline-window', observationId: null,
      safeSummary: { title: '另一窗口的心情文字未载全', reason: 'BOOTSTRAP_PAGE_LIMIT' } });
    wire!.open();
    await pollUntil(() => client!.snapshot.unreadAlerts === 1 && client!.snapshot.openAlerts === 1);
    assert.ok(wire!.opened >= 2);

    const persisted = JSON.stringify(host.db.prepare('SELECT * FROM system_alerts').all())
      + JSON.stringify(host.db.prepare("SELECT payload_ref FROM runtime_stream_events WHERE kind='system.alert.changed'").all());
    assert.doesNotMatch(persisted, /PRIVATE_(MOOD|I|PLAN)_CANARY/);
    assert.doesNotMatch(JSON.stringify(client.snapshot.alerts), /PRIVATE_(MOOD|I|PLAN)_CANARY/);
    assert.equal((host.db.prepare('SELECT COUNT(*) n FROM provider_requests').get() as { n: number }).n, before.n);
    assert.equal((host.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, 0);
    const noAuth = await fetch(base + '/api/v1/system-alerts/summary');
    assert.equal(noAuth.status, 401);
  } finally {
    client?.stop();
    await wire?.settled();
    await host.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
