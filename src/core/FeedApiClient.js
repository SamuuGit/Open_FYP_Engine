/**
 * @file FeedApiClient.js
 * @description Replicação clean-room da camada de comunicação com a API de recomendação e engajamento.
 *
 * Responsabilidades:
 * - Construir os parâmetros de query (ambiente, hardware, rede, contadores de vídeo e pullType).
 * - Empacotar os últimos 16 itens do `RealTimeSignalManager` no corpo POST (`realTimeClientInfo`)
 *   e comprimi-los com Gzip (`Content-Encoding: gzip`).
 * - Calcular o momento exato de pré-busca (`shouldTriggerPrefetch`) para carregar o próximo lote
 *   de 30 vídeos antes de a lista atual terminar (estratégias `halfway` e `penultimate`).
 * - Expor métodos para todos os endpoints de engajamento:
 *   - `GET /api/recommend/item_list/` & `POST /api/recommend/item_list/`
 *   - `POST /api/prefetch/recommend/item_list/`
 *   - `GET /api/record/impression/action/`
 *   - `POST /api/discover/client_impression/`
 *   - `POST /api/commit/item/digg/` (Curtir)
 *   - `POST /api/dislike/item/` (Não tenho interesse)
 *   - `POST /api/item/collect/` (Favoritar)
 *   - `POST /api/commit/follow/user/` (Seguir)
 *   - `POST /tiktok/v1/upvote/publish` (Republicar)
 */

export const API_ENDPOINTS = Object.freeze({
  RECOMMEND_ITEM_LIST: '/api/recommend/item_list/',
  PREFETCH_RECOMMEND_ITEM_LIST: '/api/prefetch/recommend/item_list/',
  RECORD_IMPRESSION_ACTION: '/api/record/impression/action/',
  DISCOVER_CLIENT_IMPRESSION: '/api/discover/client_impression/',
  COMMIT_ITEM_DIGG: '/api/commit/item/digg/',
  DISLIKE_ITEM: '/api/dislike/item/',
  COLLECT_ITEM: '/api/item/collect/',
  FOLLOW_USER: '/api/commit/follow/user/',
  UPVOTE_PUBLISH: '/tiktok/v1/upvote/publish',
  TEA_BATCH_LIST: '/v1/list',
});

/**
 * Coleta as métricas de hardware, tela, tema e rede enviadas junto com cada pedido de feed.
 */
export function collectDeviceEnvironmentParams(overrides = {}) {
  const now = new Date();
  const isBrowser = typeof window !== 'undefined' && typeof navigator !== 'undefined';

  const cpuCores = isBrowser
    ? navigator.hardwareConcurrency || 8
    : overrides.cpu_core_number || 8;
  const downlinkMbps =
    isBrowser && navigator.connection && typeof navigator.connection.downlink === 'number'
      ? navigator.connection.downlink
      : overrides.network ?? 10;

  // Score sintético de capacidade do dispositivo (baseado em núcleos e memória)
  const deviceScore = Number(
    overrides.device_score ?? Math.min(10, (cpuCores * 0.85 + 2.0)).toFixed(2)
  );

  return {
    aid: 1988,
    app_name: 'tiktok_web',
    device_platform: 'web_pc',
    cpu_core_number: cpuCores,
    device_score: deviceScore,
    network: downlinkMbps,
    window_width: isBrowser ? window.innerWidth : overrides.window_width || 1920,
    window_height: isBrowser ? window.innerHeight : overrides.window_height || 1080,
    dark_mode: overrides.dark_mode ?? 1,
    time_of_day: overrides.time_of_day ?? now.getHours(),
    day_of_week: overrides.day_of_week ?? now.getDay(),
    ...overrides,
  };
}

/**
 * Comprime uma string JSON em Gzip (compatível com Browser `CompressionStream` e Node `node:zlib`).
 * @param {string} jsonString
 * @returns {Promise<Uint8Array>}
 */
export async function compressPayloadGzip(jsonString) {
  if (typeof CompressionStream !== 'undefined') {
    const encoder = new TextEncoder();
    const stream = new Blob([encoder.encode(jsonString)])
      .stream()
      .pipeThrough(new CompressionStream('gzip'));
    const arrayBuffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  // Fallback para ambiente Node.js
  const { gzipSync } = await import('node:zlib');
  return new Uint8Array(gzipSync(Buffer.from(jsonString, 'utf-8')));
}

/**
 * Descomprime um buffer Gzip de volta para objeto JSON (útil para inspeção e para o servidor).
 * @param {Uint8Array|Buffer} compressedBytes
 * @returns {Promise<Object>}
 */
export async function decompressPayloadGzip(compressedBytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([compressedBytes])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    return JSON.parse(text);
  }

  const { gunzipSync } = await import('node:zlib');
  const text = gunzipSync(Buffer.from(compressedBytes)).toString('utf-8');
  return JSON.parse(text);
}

/**
 * Avalia se o cliente deve disparar a pré-busca (`prefetch`) de mais 30 vídeos.
 *
 * Replicação da lógica encontrada em `foryou.islands.d193d030.js` (módulo 865525):
 * - Estratégia `halfway` (v1): dispara quando `currentIndex === Math.floor((totalItems + batchStartIndex) / 2)`
 * - Estratégia `penultimate` (v2): dispara quando `currentIndex === totalItems - 2`
 *
 * @param {Object} params
 * @param {number} params.currentIndex - Índice do vídeo que o usuário está assistindo agora.
 * @param {number} params.totalItems - Total de vídeos atualmente carregados na fila do feed.
 * @param {number} [params.batchStartIndex=0] - Índice onde começou o lote mais recente.
 * @param {'halfway'|'penultimate'} [params.strategy='halfway'] - Estratégia ativa na flag A/B.
 */
export function shouldTriggerPrefetch({
  currentIndex,
  totalItems,
  batchStartIndex = 0,
  strategy = 'halfway',
}) {
  if (totalItems <= 1) return false;
  if (strategy === 'penultimate') {
    return currentIndex === totalItems - 2;
  }
  const triggerIndex = Math.floor((totalItems + batchStartIndex) / 2);
  return currentIndex === triggerIndex;
}

/**
 * Cliente de comunicação com os endpoints de recomendação e ações do feed.
 */
export class FeedApiClient {
  /**
   * @param {Object} options
   * @param {import('./RealTimeSignalManager.js').RealTimeSignalManager} options.signalManager
   * @param {import('./VideoPlayReport.js').VideoPlayReport} [options.playReporter]
   * @param {(request: Object)=>Promise<any>} [options.requestHandler] - Interceptador/transporte HTTP.
   */
  constructor(options = {}) {
    if (!options.signalManager) {
      throw new Error('FeedApiClient requer uma instância de RealTimeSignalManager.');
    }
    this.signalManager = options.signalManager;
    this.playReporter = options.playReporter || null;
    this.requestHandler = options.requestHandler || null;

    this.fypVvCount = 0;   // w_g_fyp_vv: vídeos vistos no For You
    this.totalVvCount = 0; // w_g_vv: vídeos vistos globalmente na sessão
    this.requestLog = [];
  }

  /**
   * Incrementa os contadores de vídeos visualizados (`vv_count_fyp` e `vv_count`).
   */
  incrementVvCounters() {
    this.fypVvCount += 1;
    this.totalVvCount += 1;
  }

  /**
   * Solicita um lote de vídeos para o feed "Para Você" (`/api/recommend/item_list/` ou `/api/prefetch/recommend/item_list/`).
   *
   * @param {Object} [options]
   * @param {boolean} [options.isInitialLoad=false] - Se true, pede `count: 6` (pullType 1); caso contrário, `count: 30` (pullType 2).
   * @param {boolean} [options.isPrefetch=false] - Se true, usa o endpoint `/api/prefetch/recommend/item_list/`.
   * @param {Object} [options.envOverrides] - Sobrescritas opcionais de hardware/ambiente.
   */
  async fetchForYouFeed(options = {}) {
    const isInitialLoad = Boolean(options.isInitialLoad);
    const isPrefetch = Boolean(options.isPrefetch);

    const endpoint = isPrefetch
      ? API_ENDPOINTS.PREFETCH_RECOMMEND_ITEM_LIST
      : API_ENDPOINTS.RECOMMEND_ITEM_LIST;

    const queryParams = {
      ...collectDeviceEnvironmentParams(options.envOverrides),
      count: isInitialLoad ? 6 : 30,
      pullType: isInitialLoad ? 1 : 2,
      vv_count_fyp: this.fypVvCount,
      vv_count: this.totalVvCount,
    };

    // Extrai os últimos 16 vídeos com playtime > 0 do RealTimeSignalManager
    const postBodyObject = this.signalManager.getConsumptionParams();
    const jsonString = JSON.stringify(postBodyObject);
    const gzipBytes = await compressPayloadGzip(jsonString);

    const requestDescriptor = {
      method: 'POST',
      endpoint,
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
      queryParams,
      rawBodyObject: postBodyObject,
      uncompressedByteLength: Buffer.byteLength(jsonString, 'utf-8'),
      compressedByteLength: gzipBytes.byteLength,
      gzipBody: gzipBytes,
      timestamp: Date.now(),
    };

    this.requestLog.push(requestDescriptor);

    if (typeof this.requestHandler === 'function') {
      const response = await this.requestHandler(requestDescriptor);
      const returnedCount = Array.isArray(response?.itemList)
        ? response.itemList.length
        : queryParams.count;
      await this.signalManager.recordFeedBatchLoaded(returnedCount);
      return { request: requestDescriptor, response };
    }

    await this.signalManager.recordFeedBatchLoaded(queryParams.count);
    return { request: requestDescriptor, response: null };
  }

  /**
   * Confirma a impressão de um vídeo na tela (`GET /api/record/impression/action/`)
   * e registra o item no `RealTimeSignalManager`.
   * @param {string} itemId
   */
  async recordImpression(itemId) {
    this.incrementVvCounters();
    await this.signalManager.createOrGetConsumptionItem(itemId);

    const req = {
      method: 'GET',
      endpoint: API_ENDPOINTS.RECORD_IMPRESSION_ACTION,
      queryParams: { item_id: String(itemId), aid: 1988 },
      timestamp: Date.now(),
    };
    this.requestLog.push(req);

    if (typeof this.requestHandler === 'function') {
      return this.requestHandler(req);
    }
    return req;
  }

  /**
   * Envia uma ação explícita de engajamento (curtir, não interessado, favoritar, seguir, compartilhar)
   * atualizando simultaneamente o `RealTimeSignalManager` (Canal 1) e chamando o endpoint da API.
   *
   * @param {string} itemId
   * @param {'like'|'dislike'|'favorite'|'follow'|'share'|'comment'|'enter_profile'} action
   * @param {Object} [extraParams]
   */
  async sendEngagementAction(itemId, action, extraParams = {}) {
    await this.signalManager.updateVideoInteraction(itemId, action, 1);

    const endpointByAction = {
      like: API_ENDPOINTS.COMMIT_ITEM_DIGG,
      dislike: API_ENDPOINTS.DISLIKE_ITEM,
      favorite: API_ENDPOINTS.COLLECT_ITEM,
      follow: API_ENDPOINTS.FOLLOW_USER,
      share: API_ENDPOINTS.UPVOTE_PUBLISH,
    };

    const endpoint = endpointByAction[action] || API_ENDPOINTS.DISCOVER_CLIENT_IMPRESSION;
    const req = {
      method: 'POST',
      endpoint,
      queryParams: {
        aweme_id: String(itemId),
        action_type: action,
        aid: 1988,
        ...extraParams,
      },
      timestamp: Date.now(),
    };

    this.requestLog.push(req);
    if (typeof this.requestHandler === 'function') {
      return this.requestHandler(req);
    }
    return req;
  }
}
