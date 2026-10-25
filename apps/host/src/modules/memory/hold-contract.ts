// modules/memory/hold-contract.ts（P04.3）：mariposa hold 契约常量正本。
// 从 runtime/host-tools.ts 逐字随迁（形状门；域校验仍以服务端为准）。
// mariposa 现行 hold 契约常量（正本=mariposa input_schemas；此处只做形状门，域校验仍以服务端为准）
export const HOLD_CATEGORIES = ['daily', 'milestone', 'sad', 'sweet', 'date', 'plan', 'sex', 'anniversary', 'reloplay', 'diary'] as const;
export const HOLD_CREATION_MODES = ['contemporaneous', 'retrospective'] as const;
export const HOLD_DATE_CONFIDENCE = ['exact', 'inferred', 'unknown'] as const;
export const HOLD_TITLE_MAX = 30;
