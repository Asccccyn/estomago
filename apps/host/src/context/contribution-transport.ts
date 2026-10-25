// context/contribution-transport.ts（S13）：同轮浮现贡献的传输投影适配层。
// 从 memory-surfacing/contracts.ts 经由 supervisor 的引用改走本适配层：
// OR/DS 信封差异是 provider 投影边界，独立于贡献叶合同与浮现业务实现。
export { supportsSurfacingTransport, surfaceTransportMessage } from '../memory-surfacing/contracts.ts';
