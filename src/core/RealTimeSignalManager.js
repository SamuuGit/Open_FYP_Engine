/**
 * @file RealTimeSignalManager.js
 * @description Replicação clean-room em código aberto do Canal 1 (In-Band Real-Time Signal Loop).
 *
 * Responsabilidades:
 * - Manter uma janela deslizante dos últimos 20 vídeos assistidos (`consumptionItems`).
 * - Persistir o estado localmente no IndexedDB (`WebAppRealtimeSignalDB` -> store `userSignalData`)
 *   no navegador (ou em memória/arquivo no Node.js).
 * - Sincronizar escritas concorrentes entre abas usando Web Locks API (`csm-<uidOrWid>`).
 * - Aplicar a regra de detecção de "pulo rápido" (Skip Detection):
 *   `is_skipped = (0 < playtime && playtime < 2000) ? 1 : 0` (menos de 2 segundos).
 * - Rastrear as 11 flags booleanas de interação por vídeo, qualidade de rede/buffer
 *   e contadores acumulados de sessão e do dia.
 * - Exportar os últimos 16 vídeos com `playtime > 0` para o payload POST do feed "Para Você".
 */

export const SIGNAL_CONSTANTS = Object.freeze({
  DB_NAME: 'WebAppRealtimeSignalDB',
  STORE_NAME: 'userSignalData',
  LOCK_PREFIX: 'csm-',
  MAX_BUFFER_SIZE: 20,        // Janela máxima mantida no banco local
  PAYLOAD_SLICE_SIZE: 16,     // Quantidade enviada em cada requisição do feed
  SKIP_THRESHOLD_MS: 2000,    // Menos de 2000 ms (2s) com playtime > 0 marca is_skipped = 1
});

/**
 * Mapa das 11 ações de interação suportadas para suas respectivas flags no item de consumo.
 */
export const INTERACTION_ACTION_MAP = Object.freeze({
  like: 'is_liked',
  follow: 'is_followed',
  favorite: 'is_favorited',
  share: 'is_shared',
  dislike: 'is_disliked',
  report: 'is_reported',
  enter_profile: 'is_entered_profile',
  skip: 'is_skipped',
  comment: 'is_commentted',       // Grafia original preservada por compatibilidade de protocolo
  click_cover: 'is_click_cover',
  click_comment: 'is_click_comment',
});

/**
 * Cria um registro inicial zerado para um vídeo no histórico de consumo.
 * @param {string} itemId - ID único do vídeo.
 */
export function createEmptyConsumptionItem(itemId) {
  return {
    id: String(itemId),
    playtime: 0,
    playtime_max: 0,
    first_frame_duration: 0,
    block_count: 0,
    block_duration: 0,
    is_finished: 0,
    is_liked: 0,
    is_followed: 0,
    is_favorited: 0,
    is_shared: 0,
    is_disliked: 0,
    is_reported: 0,
    is_entered_profile: 0,
    is_skipped: 0,
    is_commentted: 0,
    is_click_cover: 0,
    is_click_comment: 0,
  };
}

/**
 * Retorna a data atual no formato YYYY-MM-DD para controle de rotação diária.
 */
function getCurrentDateKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Adaptador de armazenamento compatível com IndexedDB (Browser) e Map em memória (Node.js).
 */
export class SignalStorageAdapter {
  constructor() {
    this.memoryStore = new Map();
    this.isBrowserIndexedDB =
      typeof indexedDB !== 'undefined' && indexedDB !== null;
  }

  async _openIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(SIGNAL_CONSTANTS.DB_NAME, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(SIGNAL_CONSTANTS.STORE_NAME)) {
          db.createObjectStore(SIGNAL_CONSTANTS.STORE_NAME, { keyPath: 'uidOrWid' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async get(uidOrWid) {
    if (!this.isBrowserIndexedDB) {
      const data = this.memoryStore.get(uidOrWid);
      return data ? structuredClone(data) : null;
    }
    const db = await this._openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SIGNAL_CONSTANTS.STORE_NAME, 'readonly');
      const store = tx.objectStore(SIGNAL_CONSTANTS.STORE_NAME);
      const req = store.get(uidOrWid);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async put(record) {
    if (!this.isBrowserIndexedDB) {
      this.memoryStore.set(record.uidOrWid, structuredClone(record));
      return;
    }
    const db = await this._openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SIGNAL_CONSTANTS.STORE_NAME, 'readwrite');
      const store = tx.objectStore(SIGNAL_CONSTANTS.STORE_NAME);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

/**
 * Gerenciador de Sinais em Tempo Real (Canal 1).
 */
export class RealTimeSignalManager {
  /**
   * @param {Object} options
   * @param {string} [options.uidOrWid='anonymous_device_wid'] - Identificador do usuário ou dispositivo.
   * @param {SignalStorageAdapter} [options.storage] - Adaptador de persistência customizado.
   */
  constructor(options = {}) {
    this.uidOrWid = String(options.uidOrWid || 'anonymous_device_wid');
    this.storage = options.storage || new SignalStorageAdapter();

    // Contadores voláteis da sessão atual (em memória)
    this.sessionStats = {
      session_v_num: 0, // Total de vídeos entregues na aba/sessão
      session_r_num: 0, // Total de lotes (requisições) carregados na sessão
    };

    // Estado espelhado localmente para leitura rápida
    this.state = {
      uidOrWid: this.uidOrWid,
      last_active_date: getCurrentDateKey(),
      day_v_num: 0,
      day_r_num: 0,
      day_view_time: 0,
      consumptionItems: [],
    };
  }

  /**
   * Executa uma função protegida por Web Lock (`csm-<uidOrWid>`) quando disponível no navegador,
   * evitando condições de corrida quando múltiplas abas atualizam o IndexedDB.
   */
  async _withCrossTabLock(fn) {
    const lockName = `${SIGNAL_CONSTANTS.LOCK_PREFIX}${this.uidOrWid}`;
    if (
      typeof navigator !== 'undefined' &&
      navigator.locks &&
      typeof navigator.locks.request === 'function'
    ) {
      return navigator.locks.request(lockName, async () => fn());
    }
    return fn();
  }

  /**
   * Inicializa ou restaura o estado salvo no banco local e verifica virada de dia.
   */
  async init(uidOrWid) {
    if (uidOrWid) {
      this.uidOrWid = String(uidOrWid);
    }
    return this._withCrossTabLock(async () => {
      const stored = await this.storage.get(this.uidOrWid);
      const today = getCurrentDateKey();

      if (stored) {
        this.state = stored;
        if (this.state.last_active_date !== today) {
          this.state.last_active_date = today;
          this.state.day_v_num = 0;
          this.state.day_r_num = 0;
          this.state.day_view_time = 0;
        }
      } else {
        this.state = {
          uidOrWid: this.uidOrWid,
          last_active_date: today,
          day_v_num: 0,
          day_r_num: 0,
          day_view_time: 0,
          consumptionItems: [],
        };
      }
      await this.storage.put(this.state);
      return structuredClone(this.state);
    });
  }

  /**
   * Garante que a data diária está atualizada antes de somar métricas do dia.
   */
  _ensureDailyRollover() {
    const today = getCurrentDateKey();
    if (this.state.last_active_date !== today) {
      this.state.last_active_date = today;
      this.state.day_v_num = 0;
      this.state.day_r_num = 0;
      this.state.day_view_time = 0;
    }
  }

  /**
   * Localiza um vídeo na lista dos últimos 20 ou o insere no final,
   * descartando o mais antigo caso ultrapasse `MAX_BUFFER_SIZE` (20).
   */
  _getOrCreateItemInternal(itemId) {
    const id = String(itemId);
    let item = this.state.consumptionItems.find((entry) => entry.id === id);
    if (!item) {
      item = createEmptyConsumptionItem(id);
      this.state.consumptionItems.push(item);
      if (this.state.consumptionItems.length > SIGNAL_CONSTANTS.MAX_BUFFER_SIZE) {
        this.state.consumptionItems.shift();
      }
    }
    return item;
  }

  /**
   * Registra a impressão inicial de um vídeo quando ele entra na tela.
   * @param {string} itemId
   */
  async createOrGetConsumptionItem(itemId) {
    return this._withCrossTabLock(async () => {
      this._ensureDailyRollover();
      const item = this._getOrCreateItemInternal(itemId);
      await this.storage.put(this.state);
      return structuredClone(item);
    });
  }

  /**
   * Atualiza o tempo de visualização de um vídeo e recalcula a regra dos 2 segundos (`is_skipped`).
   *
   * Regra exata replicada:
   * - `playtime` acumula todos os segmentos assistidos daquele vídeo (ms).
   * - `playtime_max` guarda o maior segmento contínuo sem interrupção (ms).
   * - `is_skipped = (0 < playtime && playtime < 2000) ? 1 : 0`
   *
   * @param {string} itemId - ID do vídeo.
   * @param {number} durationMs - Duração do trecho recém-assistido em milissegundos.
   */
  async updatePlayTime(itemId, durationMs) {
    const delta = Math.max(0, Math.round(Number(durationMs) || 0));
    return this._withCrossTabLock(async () => {
      this._ensureDailyRollover();
      const item = this._getOrCreateItemInternal(itemId);

      item.playtime += delta;
      item.playtime_max = Math.max(item.playtime_max, delta);

      // Regra dos 2 segundos (2000 ms):
      item.is_skipped =
        item.playtime > 0 && item.playtime < SIGNAL_CONSTANTS.SKIP_THRESHOLD_MS
          ? 1
          : 0;

      // Acumula no tempo de visualização do dia (em segundos inteiros/fracionários ou ms normalizados)
      this.state.day_view_time += Math.round(delta / 1000);

      await this.storage.put(this.state);
      return structuredClone(item);
    });
  }

  /**
   * Marca que o usuário assistiu ao vídeo até o fim (100% / gatilho de replay).
   * @param {string} itemId
   */
  async reportPlayFinish(itemId) {
    return this._withCrossTabLock(async () => {
      const item = this._getOrCreateItemInternal(itemId);
      item.is_finished = 1;
      item.is_skipped = 0; // Se terminou o vídeo, garante que não é considerado pulado
      await this.storage.put(this.state);
      return structuredClone(item);
    });
  }

  /**
   * Atualiza métricas técnicas de qualidade de reprodução (QoE) do vídeo.
   * @param {string} itemId
   * @param {Object} quality
   * @param {number} [quality.first_frame_duration] - Tempo até renderizar o 1º frame (ms).
   * @param {number} [quality.block_count] - Quantidade de travamentos (rebufferings).
   * @param {number} [quality.block_duration] - Duração acumulada dos travamentos (ms).
   */
  async updateQualityInfo(itemId, quality = {}) {
    return this._withCrossTabLock(async () => {
      const item = this._getOrCreateItemInternal(itemId);
      if (typeof quality.first_frame_duration === 'number') {
        item.first_frame_duration = Math.round(quality.first_frame_duration);
      }
      if (typeof quality.block_count === 'number') {
        item.block_count += Math.round(quality.block_count);
      }
      if (typeof quality.block_duration === 'number') {
        item.block_duration += Math.round(quality.block_duration);
      }
      await this.storage.put(this.state);
      return structuredClone(item);
    });
  }

  /**
   * Atualiza uma das 11 flags booleanas de interação do usuário com o vídeo.
   * @param {string} itemId - ID do vídeo.
   * @param {keyof typeof INTERACTION_ACTION_MAP | string} action - Nome da ação (ex.: 'like', 'dislike', 'favorite', 'share').
   * @param {0|1} [value=1] - Valor da flag (1 = ativado, 0 = desativado).
   */
  async updateVideoInteraction(itemId, action, value = 1) {
    const fieldName = INTERACTION_ACTION_MAP[action] || action;
    if (!Object.values(INTERACTION_ACTION_MAP).includes(fieldName)) {
      throw new Error(`Ação de interação desconhecida: "${action}"`);
    }

    return this._withCrossTabLock(async () => {
      const item = this._getOrCreateItemInternal(itemId);
      item[fieldName] = value ? 1 : 0;
      await this.storage.put(this.state);
      return structuredClone(item);
    });
  }

  /**
   * Atualiza os contadores de lotes e vídeos recebidos a cada resposta do endpoint `/api/recommend/item_list/`.
   * @param {number} receivedVideoCount - Quantidade de vídeos retornados no lote.
   */
  async recordFeedBatchLoaded(receivedVideoCount = 0) {
    const count = Math.max(0, Number(receivedVideoCount) || 0);
    return this._withCrossTabLock(async () => {
      this._ensureDailyRollover();
      this.sessionStats.session_r_num += 1;
      this.sessionStats.session_v_num += count;
      this.state.day_r_num += 1;
      this.state.day_v_num += count;
      await this.storage.put(this.state);
    });
  }

  /**
   * Constrói o objeto `realTimeClientInfo` enviado no corpo (POST body) de
   * `/api/recommend/item_list/` e `/api/prefetch/recommend/item_list/`.
   *
   * Filtra apenas vídeos que tiveram reprodução efetiva (`playtime > 0`) e
   * seleciona os últimos 16 itens (`slice(-16)`).
   */
  getConsumptionParams() {
    const validItems = this.state.consumptionItems
      .filter((item) => item.playtime > 0)
      .slice(-SIGNAL_CONSTANTS.PAYLOAD_SLICE_SIZE);

    return {
      realTimeClientInfo: {
        consumption_data: {
          consumption_items: structuredClone(validItems),
          day_view_time: this.state.day_view_time,
          batch_num: this.sessionStats.session_r_num,
          batch_num_all: this.state.day_r_num,
          play_num: this.sessionStats.session_v_num,
          play_num_all: this.state.day_v_num,
        },
      },
    };
  }

  /**
   * Retorna uma cópia completa do estado atual (os 20 itens + contadores) para inspeção visual.
   */
  getSnapshot() {
    return {
      ...structuredClone(this.state),
      session_v_num: this.sessionStats.session_v_num,
      session_r_num: this.sessionStats.session_r_num,
    };
  }
}
