// 脱敏日志（01 §18.1/05 §9）：只记 ID/状态/计数/hash，构造上不可能携带正文/凭据/签名。
import fs from 'node:fs';
import path from 'node:path';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export class Logger {
  private stream: fs.WriteStream | null = null;

  constructor(logDir: string | null) {
    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      this.stream = fs.createWriteStream(path.join(logDir, 'host.log'), { flags: 'a' });
    }
  }

  info(event: string, fields: LogFields = {}): void {
    this.write('INFO', event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write('WARN', event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write('ERROR', event, fields);
  }

  private write(level: string, event: string, fields: LogFields): void {
    const line = `${new Date().toISOString()} ${level} ${event} ${safeJson(fields)}`;
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
    this.stream?.write(line + '\n');
  }

  close(): void {
    this.stream?.end();
  }
}

function safeJson(fields: LogFields): string {
  try {
    return JSON.stringify(fields);
  } catch {
    return '{"log":"unserializable fields"}';
  }
}
