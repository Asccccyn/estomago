// modules/memory/mood-vocab.ts（P04.5）：心情词表状态与受控刷新（memory catalog 正本）。
// 从 host-tools 原样迁移：mariposa memory.mood.vocab 为正本，本地快照仅离线回退；
// 仅在新窗解析时刷新，现有窗口始终使用其已冻结枚举。
import { HOLD_INPUT } from './hold-contract.ts';
import type { MariposaClient } from '../../integrations/mariposa/client.ts';

let moodCategories: string[] = [...HOLD_INPUT.properties.mood.properties.tags.items.enum];
let moodVocabVersion: string | null = null;

export function currentMoodCategories(): readonly string[] {
  return moodCategories;
}

/** 新窗拉取领域词表；失败保留已知快照，实际写入仍由领域服务校验。
 *  需绑定白名单含 memory.mood.vocab（estómago builtin 已含）。 */
export async function refreshMoodCategories(client: MariposaClient): Promise<boolean> {
  try {
    const r = await client.moodVocab();
    if (r.ok && r.categories && r.categories.length) {
      if (r.categories.join('\u0000') !== moodCategories.join('\u0000') || r.version !== moodVocabVersion) {
        moodCategories = [...r.categories];
        moodVocabVersion = r.version ?? null;
      }
      return true;
    }
  } catch {
    // mariposa 不可达：保持快照与缓存，域校验以服务端为准
  }
  return false;
}
