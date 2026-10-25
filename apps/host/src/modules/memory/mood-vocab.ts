// modules/memory/mood-vocab.ts（P04.5）：心情词表状态与受控刷新（memory catalog 正本）。
// 从 host-tools 原样迁移：mariposa memory.mood.vocab 为正本，本地快照仅离线回退；
// 词表变更通过装配回调失效目录缓存（host-tools buildHostTools 注册该回调），不反向依赖宿主。
import type { MariposaClient } from '../../integrations/mariposa/client.ts';

let moodCategories: string[] = ['开心', '爱', '生气', '吃醋', '悲伤', '渴望', '不安'];
let moodVocabVersion: string | null = null;
let onCategoriesChanged: (() => void) | null = null;

export function currentMoodCategories(): readonly string[] {
  return moodCategories;
}

/** 装配根注册目录缓存失效回调（词表变更时由本模块调用）。 */
export function setMoodCategoriesChangedCallback(cb: (() => void) | null): void {
  onCategoriesChanged = cb;
}

/** best-effort 拉词表（幂等、失败保快照）；变更后失效工具集缓存（经装配回调）。
 *  需绑定白名单含 memory.mood.vocab（estómago builtin 已含）。 */
export async function refreshMoodCategories(client: MariposaClient): Promise<boolean> {
  try {
    const r = await client.moodVocab();
    if (r.ok && r.categories && r.categories.length) {
      if (r.categories.join('\u0000') !== moodCategories.join('\u0000') || r.version !== moodVocabVersion) {
        moodCategories = [...r.categories];
        moodVocabVersion = r.version ?? null;
        onCategoriesChanged?.();
      }
      return true;
    }
  } catch {
    // mariposa 不可达：保持快照与缓存，域校验以服务端为准
  }
  return false;
}
