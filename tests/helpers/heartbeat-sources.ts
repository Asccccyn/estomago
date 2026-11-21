import { HeartbeatSources } from '../../apps/host/src/modules/heartbeat/sources.ts';
import type { HeartbeatSource } from '../../packages/contracts/src/heartbeat.ts';

const cards = Array.from({ length: 10 }, (_, index): HeartbeatSource => ({
  kind: 'moments', namespace: 'content', id: `fixture-card-${index + 1}`,
  revision: 1, identity: `content:moments:fixture-card-${index + 1}`, permissionScope: 'primary',
}));

/** Replace only the external source discovery/read boundary. Deck creation,
 * tool dispatch, delivery, scheduling and publication use the real host. */
export function installHeartbeatFixtureSources(): () => void {
  const choose = HeartbeatSources.prototype.choose;
  const resolve = HeartbeatSources.prototype.resolve;
  HeartbeatSources.prototype.choose = async (conversationId, eligible) =>
    cards.filter(card => card.permissionScope === conversationId && eligible(card));
  HeartbeatSources.prototype.resolve = async (source, conversationId) => {
    const card = cards.find(candidate => candidate.id === source.id && candidate.revision === source.revision);
    return card && card.permissionScope === conversationId
      ? { status: 'available', text: `合成心跳卡内容：${card.id}`, imageIds: [], assetIds: [] }
      : { status: 'revision_unavailable' };
  };
  return () => {
    HeartbeatSources.prototype.choose = choose;
    HeartbeatSources.prototype.resolve = resolve;
  };
}
