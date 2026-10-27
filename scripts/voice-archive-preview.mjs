#!/usr/bin/env node
// GLM_VOICE_UNIFICATION P6（02§6）：历史空正文语音归档——**只读预览统计**。
// 统计四类（有原声/有转写/缺素材/已归档待补），不做任何写入；生产回填独立交接。
// 用法：node scripts/voice-archive-preview.mjs [ESTOMAGO_HOME 或默认数据根]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = process.argv[2] ?? path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const dbPath = path.join(home, 'chat.sqlite3'); // 数据根=ESTOMAGO_HOME/data 或显式传入 data 目录（chat.sqlite3 直在其下）
if (!fs.existsSync(dbPath)) { console.error(`数据库不存在：${dbPath}（只读预览，不做创建）`); process.exit(1); }
// node:sqlite 与宿主同引擎（只读打开，不创建）
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true, open: true });

const q = (sql) => { try { return db.prepare(sql).all(); } catch { return null; } }; // 旧库缺列=如实 null（预览脚本不要求先迁移）
const out = {
  generated_at: new Date().toISOString(), db: dbPath,
  voice_messages_total: q("SELECT COUNT(*) n FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE r.kind='voice'")[0].n,
  voice_with_empty_content: q("SELECT COUNT(*) n FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE r.kind='voice' AND TRIM(COALESCE(r.content,''))=''")[0].n,
  voice_empty_with_transcript: q("SELECT COUNT(*) n FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision JOIN message_attachments ma ON ma.message_id=m.id AND ma.revision=r.revision AND ma.presentation='voice' WHERE TRIM(COALESCE(r.content,''))='' AND TRIM(COALESCE(ma.derived_text,''))<>''")[0].n,
  voice_empty_without_transcript: q("SELECT COUNT(*) n FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision JOIN message_attachments ma ON ma.message_id=m.id AND ma.revision=r.revision AND ma.presentation='voice' WHERE TRIM(COALESCE(r.content,''))='' AND TRIM(COALESCE(ma.derived_text,''))=''")[0].n,
  archived_source_rows: q("SELECT COUNT(*) n FROM source_sync_receipts")[0].n,
  archived_empty_pending_fix: q("SELECT COUNT(*) n FROM source_sync_receipts sr JOIN messages m ON m.id=sr.origin_message_id JOIN message_revisions r ON r.message_id=m.id AND r.revision=sr.revision WHERE r.kind='voice' AND TRIM(COALESCE(r.content,''))=''")[0].n,
  calls_with_mode: q("SELECT analysis_mode, COUNT(*) n FROM voice_calls GROUP BY analysis_mode") ?? '旧库未迁移（无 analysis_mode 列）',
};
console.log(JSON.stringify(out, null, 1));
db.close();
