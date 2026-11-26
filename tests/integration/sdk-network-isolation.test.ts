import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { proxyOnlySdkSpawn } from '../../apps/host/src/runtime/sdk-network.ts';

test('Mac SDK process can reach only its proxy port; closed proxy cannot fall back to TCP, IPv6 or UDP', { skip: process.platform !== 'darwin' }, async () => {
  let directConnections = 0;
  const proxy = net.createServer(socket => socket.end());
  const direct = net.createServer(socket => { directConnections++; socket.end(); });
  const ipv6 = net.createServer(socket => { directConnections++; socket.end(); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  direct.listen(0, '127.0.0.1'); await once(direct, 'listening');
  ipv6.listen(0, '::1'); await once(ipv6, 'listening');
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  const directPort = (direct.address() as net.AddressInfo).port;
  const ipv6Port = (ipv6.address() as net.AddressInfo).port;
  const script = `
    const net = require('net'), dgram = require('dgram');
    const tcp = (host, port) => new Promise(resolve => {
      const socket = net.connect({ host, port });
      socket.once('connect', () => { socket.destroy(); resolve('connected'); });
      socket.once('error', e => resolve(e.code));
      socket.setTimeout(2000, () => { socket.destroy(); resolve('timeout'); });
    });
    (async () => {
      const allowed = await tcp('127.0.0.1', ${proxyPort});
      const direct = await tcp('127.0.0.1', ${directPort});
      const ipv6 = await tcp('::1', ${ipv6Port});
      const udp = await new Promise(resolve => {
        const socket = dgram.createSocket('udp4');
        socket.on('error', e => { socket.close(); resolve(e.code); });
        socket.send('synthetic', ${directPort}, '127.0.0.1', e => { socket.close(); resolve(e?.code ?? 'sent'); });
      });
      console.log(JSON.stringify({ allowed, direct, ipv6, udp }));
    })();`;
  const attempt = async () => {
    const child = proxyOnlySdkSpawn(`http://127.0.0.1:${proxyPort}`)({ command: process.execPath, args: ['-e', script],
      env: { PATH: process.env.PATH }, signal: new AbortController().signal });
    let text = ''; child.stdout.on('data', chunk => { text += chunk; }); child.stdin.end();
    const [code] = await once(child as any, 'exit');
    assert.equal(code, 0); return JSON.parse(text);
  };
  try {
    assert.deepEqual(await attempt(), { allowed: 'connected', direct: 'EPERM', ipv6: 'EPERM', udp: 'EPERM' });
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    assert.deepEqual(await attempt(), { allowed: 'ECONNREFUSED', direct: 'EPERM', ipv6: 'EPERM', udp: 'EPERM' });
    assert.equal(directConnections, 0);
  } finally {
    proxy.close(); direct.close(); ipv6.close();
  }
});
