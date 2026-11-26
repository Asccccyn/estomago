// Test hosts listen on OS-assigned loopback ports. Never dial an installed service.
const net = require('node:net');
const ports = new Set();
const emit = net.Server.prototype.emit;
net.Server.prototype.emit = function (type, ...rest) {
  if (type === 'listening') {
    const address = this.address();
    if (address && typeof address === 'object') ports.add(address.port);
  }
  return emit.call(this, type, ...rest);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const opts = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = Number(opts?.port ?? opts);
  const host = opts?.host ?? (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (!ports.has(port) || !['127.0.0.1','::1','localhost'].includes(host)) throw Error('AUDIT_NON_FIXTURE_NETWORK');
  return connect.apply(this, args);
};
