/**
 * @file VideoPlayReport.js
 * @description Replicação clean-room do Canal 2 (Telemetria Analítica de Eventos e Classificador Local).
 *
 * Responsabilidades:
 * - Emitir os eventos analíticos de ciclo de vida do player:
 *   `video_play`, `play_time`, `video_play_finish`, `video_pause` e `video_resume`.
 * - Rastrear o método de rolagem (`scroll_method`: 'slide' | 'keyboard' | 'click_button')
 *   e se a rolagem automática (`is_autoscroll`) ou o modo mudo (`is_mute`) estão ativos.
 * - Executar o classificador local de estado de engajamento:
 *   - `high_vv_count`: mais de 5 vídeos reproduzidos na sessão.
 *   - `low_engagement`: múltiplos vídeos consecutivos pulados rapidamente (< 2 segundos).
 *   - `avatar_hover`: passagem do cursor sobre o avatar do criador.
 * - Enfileirar e despachar lotes JSON para o endpoint analítico `POST /v1/list`.
 */

export const SCROLL_METHODS = Object.freeze({
  SLIDE: 'slide',               // Roda do mouse (wheel) ou gesto de trackpad
  KEYBOARD: 'keyboard',         // Setas ArrowDown / ArrowUp
  CLICK_BUTTON: 'click_button', // Botões de próximo/anterior na interface
  AUTOSCROLL: 'autoscroll',     // Avanço automático ao finalizar o vídeo
});

export class VideoPlayReport {
  /**
   * @param {Object} [options]
   * @param {number} [options.appId=1988] - ID da aplicação desktop web.
   * @param {number} [options.batchSize=10] - Quantidade de eventos para disparo automático de lote.
   * @param {(payload: Object)=>Promise<any>} [options.transport] - Função de envio HTTP para `/v1/list`.
   */
  constructor(options = {}) {
    this.appId = options.appId || 1988;
    this.batchSize = options.batchSize || 10;
    this.transport = options.transport || null;

    this.numVideoPlayed = 0;
    this.consecutiveShortWatches = 0;
    this.eventQueue = [];
    this.eventHistory = [];

    this.engagementFlags = {
      high_vv_count: false,
      low_engagement: false,
      avatar_hover: false,
    };
  }

  /**
   * Registra um evento na fila analítica (padrão TEA SDK `/v1/list`).
   * @param {string} eventName
   * @param {Object} params
   */
  _enqueueEvent(eventName, params = {}) {
    const now = Date.now();
    const eventRecord = {
      event: eventName,
      local_time_ms: now,
      datetime: new Date(now).toISOString(),
      params: {
        enter_from: 'homepage_hot',
        aid: this.appId,
        ...params,
      },
    };

    this.eventQueue.push(eventRecord);
    this.eventHistory.push(eventRecord);

    if (this.eventQueue.length >= this.batchSize) {
      this.flushBatch().catch(() => {});
    }

    return eventRecord;
  }

  /**
   * Dispara `video_play` quando um vídeo entra na viewport e inicia a reprodução.
   * @param {Object} data
   * @param {string} data.item_id
   * @param {string} data.author_id
   * @param {'slide'|'keyboard'|'click_button'|'autoscroll'} [data.scroll_method='slide']
   * @param {boolean} [data.is_autoscroll=false]
   * @param {boolean} [data.is_mute=false]
   * @param {number} [data.item_list_index=0]
   */
  sendVideoPlayEvent(data) {
    this.numVideoPlayed += 1;
    if (this.numVideoPlayed > 5) {
      this.engagementFlags.high_vv_count = true;
    }

    return this._enqueueEvent('video_play', {
      group_id: String(data.item_id),
      author_id: String(data.author_id || 'unknown_author'),
      scroll_method: data.scroll_method || SCROLL_METHODS.SLIDE,
      is_autoscroll: data.is_autoscroll ? 1 : 0,
      is_mute: data.is_mute ? 1 : 0,
      item_list_index: Number(data.item_list_index || 0),
      num_video_played: this.numVideoPlayed,
    });
  }

  /**
   * Dispara `play_time` quando o usuário sai do vídeo (scroll para o próximo ou fecha),
   * reportando tanto o `duration` bruto quanto o `focus_time` real em primeiro plano.
   * @param {Object} data
   * @param {string} data.item_id
   * @param {number} data.duration - Tempo total aberto em ms.
   * @param {number} data.focus_time - Tempo com janela em foco em ms.
   * @param {number} [data.video_duration=15000] - Duração total do arquivo de vídeo em ms.
   */
  sendPlayTimeEvent(data) {
    const duration = Math.max(0, Math.round(Number(data.duration) || 0));
    const focusTime = Math.max(0, Math.round(Number(data.focus_time ?? duration)));
    const videoDuration = Math.max(1, Math.round(Number(data.video_duration) || 15000));
    const percentage = Number(Math.min(1, duration / videoDuration).toFixed(4));

    // Avalia classificador local de baixo engajamento (sequência de vídeos < 2000ms)
    if (duration < 2000) {
      this.consecutiveShortWatches += 1;
      if (this.consecutiveShortWatches >= 3) {
        this.engagementFlags.low_engagement = true;
      }
    } else {
      this.consecutiveShortWatches = 0;
      this.engagementFlags.low_engagement = false;
    }

    return this._enqueueEvent('play_time', {
      group_id: String(data.item_id),
      duration,
      focus_time: focusTime,
      video_duration: videoDuration,
      percentage,
      is_low_engagement: this.engagementFlags.low_engagement ? 1 : 0,
      is_high_vv_count: this.engagementFlags.high_vv_count ? 1 : 0,
    });
  }

  /**
   * Dispara `video_play_finish` a cada vez que o vídeo atinge 100% da duração (incluindo loops/replays).
   * @param {Object} data
   * @param {string} data.item_id
   * @param {number} [data.loop_count=1]
   */
  sendPlayFinishEvent(data) {
    return this._enqueueEvent('video_play_finish', {
      group_id: String(data.item_id),
      loop_count: Number(data.loop_count || 1),
    });
  }

  /**
   * Dispara `video_pause` diferenciando pausa manual de troca de aba/janela.
   * @param {Object} data
   * @param {string} data.item_id
   * @param {'click_pause'|'switch_tab'|'window_blur'} [data.enter_method='click_pause']
   */
  sendPauseEvent(data) {
    return this._enqueueEvent('video_pause', {
      group_id: String(data.item_id),
      enter_method: data.enter_method || 'click_pause',
    });
  }

  /**
   * Dispara `video_resume` quando a reprodução é retomada.
   * @param {Object} data
   * @param {string} data.item_id
   * @param {'click_play'|'switch_tab_return'} [data.enter_method='click_play']
   */
  sendResumeEvent(data) {
    return this._enqueueEvent('video_resume', {
      group_id: String(data.item_id),
      enter_method: data.enter_method || 'click_play',
    });
  }

  /**
   * Registra interesse implícito quando o usuário posiciona o mouse sobre o avatar do autor.
   * @param {string} itemId
   * @param {string} authorId
   */
  recordAvatarHover(itemId, authorId) {
    this.engagementFlags.avatar_hover = true;
    return this._enqueueEvent('avatar_hover', {
      group_id: String(itemId),
      author_id: String(authorId),
    });
  }

  /**
   * Empacota e envia os eventos acumulados na fila para `POST /v1/list`.
   */
  async flushBatch() {
    if (this.eventQueue.length === 0) {
      return null;
    }

    const eventsToSend = this.eventQueue.splice(0, this.eventQueue.length);
    const batchPayload = [
      {
        user: {
          user_unique_id: 'desktop_pwa_user',
        },
        header: {
          app_id: this.appId,
          os_name: 'windows',
          device_platform: 'webapp_desktop_pwa',
        },
        events: eventsToSend,
      },
    ];

    if (typeof this.transport === 'function') {
      await this.transport(batchPayload);
    }

    return batchPayload;
  }
}
