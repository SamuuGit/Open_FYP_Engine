/**
 * @file index.js
 * @description Ponto de entrada principal da biblioteca Open FYP Signal Engine.
 */

export {
  RealTimeSignalManager,
  SignalStorageAdapter,
  SIGNAL_CONSTANTS,
  INTERACTION_ACTION_MAP,
  createEmptyConsumptionItem,
} from './core/RealTimeSignalManager.js';

export { FocusTimeTracker } from './core/FocusTimeTracker.js';

export {
  VideoPlayReport,
  SCROLL_METHODS,
} from './core/VideoPlayReport.js';

export {
  FeedApiClient,
  API_ENDPOINTS,
  collectDeviceEnvironmentParams,
  compressPayloadGzip,
  decompressPayloadGzip,
  shouldTriggerPrefetch,
} from './core/FeedApiClient.js';

export {
  RecommendationEngine,
  DEFAULT_VIDEO_CATALOG,
  SIGNAL_WEIGHTS,
} from './server/RecommendationEngine.js';
