// P6 §10.4 真实链验收（一次性脚本，不入测试套件——会打真实 Siren TTS，属授权最小调用）：
// host 工具入口 chat_send_voice → est 适配 → 真实 Siren(127.0.0.1:8790) → TTS →
// 资产保存 → 消息完成 → 音频可播放（afinfo 时长>0）→ 同 tool_call 幂等重放不重复合成。
// 运行：ESTOMAGO_TEST_MODE=1 node --experimental-strip-types scripts/verify-p6-live.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { openDatabase } from '../apps/host/src/db/connection.ts';
import { migrate } from '../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../apps/host/src/util/id.ts';
import { buildConfig } from '../apps/host/src/config/schema.ts';
import { buildPaths } from '../apps/host/src/config/paths.ts';
import { readyRuntimePatch, assembleTestTools, writeApprovedIdentity } from '../tests/helpers.ts';
import { EventService } from '../apps/host/src/events/service.ts';
import { MessageService } from '../apps/host/src/messages/service.ts';
import { MediaService } from '../apps/host/src/media/assets.ts';
import { IdentityService } from '../apps/host/src/identity/service.ts';
import { RotationReviewService } from '../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../apps/host/src/memory/hold-checkpoint.ts';
import { SirenAdapter } from '../apps/host/src/integrations/siren/adapter.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-live-'));
writeApprovedIdentity(root);
const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
const paths = buildPaths(root);
const db = openDatabase(path.join(root, 'data'));
migrate(db, sha256Hex);
const messages = new MessageService(db);
messages.ensureConversation('primary');
const media = new MediaService(db, paths.mediaDir, config);
void new EventService(db); void new IdentityService(config, paths);

const token = execSync("grep -o 'ESTOMAGO_SIREN_TOKEN=[^ ]*' /Users/owner/Data/estomago-secrets/siren.env | cut -d= -f2").toString().trim();
const siren = new SirenAdapter('http://127.0.0.1:8790', token);
console.log('siren status:', siren.status);
const { tools } = assembleTestTools({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), messages, media, sirenCall: siren });

const ctx = { roomId: 'primary', windowId: 'w', turnId: 't-p6-live', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'p6-live', toolCallId: 'tc-p6-live' };
const TEXT = '晚安，我的宝宝。';

const out = await tools.execute('chat_send_voice', { text: TEXT }, ctx);
console.log('tool result:', JSON.stringify(out).slice(0, 300));
if (out.ok !== true) { console.log('FAIL: tool not ok'); process.exit(1); }
const v = out.output ?? out.value;
console.log('state:', v.state, '| message:', v.message_id, '| asset:', v.audio_asset_id);

// 消息完成 + 附件 + 正文=原话
const row = db.prepare("SELECT m.kind, r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.id=?").get(v.message_id);
console.log('message row:', JSON.stringify(row));
const att = db.prepare("SELECT asset_id, presentation FROM message_attachments WHERE message_id=?").all(v.message_id);
console.log('attachments:', JSON.stringify(att));

// 资产可播放：文件存在 + afinfo 时长 > 0
const asset = db.prepare('SELECT storage_key, mime_type, byte_size FROM media_assets WHERE id=?').get(v.audio_asset_id);
const file = path.join(paths.mediaDir, String(asset.storage_key));
console.log('asset bytes:', asset.byte_size, 'mime:', asset.mime_type);
const af = execSync(`afinfo "${file}" 2>/dev/null | grep -m1 "estimated duration"`).toString().trim();
console.log('audio:', af);
if (!/estimated duration:\s*[0-9.]+/.test(af) || parseFloat(af.split(':')[1]) <= 0) { console.log('FAIL: audio not playable'); process.exit(1); }

// 幂等：同 tool_call 重放不重复发布、不重复合成
const again = await tools.execute('chat_send_voice', { text: TEXT }, ctx);
console.log('replay:', JSON.stringify(again.output ?? again.value).slice(0, 160));
const rp = again.output ?? again.value ?? {};
if (rp.message_id !== v.message_id || rp.replayed !== true) { console.log('FAIL: replay not idempotent'); process.exit(1); }
const count = db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='voice' AND speaker='assistant'").get().n;
console.log('assistant voice messages:', count, count === 1 ? '(唯一 ✓)' : '(FAIL)');
db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(count === 1 ? 'P6 LIVE ACCEPTANCE: PASS' : 'P6 LIVE ACCEPTANCE: FAIL');
