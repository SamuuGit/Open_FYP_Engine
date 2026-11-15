/**
 * @file FocusTimeTracker.js
 * @description Replicação clean-room do rastreador de foco ativo de janela (Módulo 130750).
 *
 * Responsabilidades:
 * - Separar o tempo bruto em que o vídeo esteve aberto (`duration`) do tempo em que
 *   o usuário realmente manteve a janela ativa e visível em primeiro plano (`focus_time`).
 * - Identificar se uma pausa no vídeo ocorreu por clique manual (`click_pause`) ou
 *   por perda de foco/troca de aba (`switch_tab`).
 */

export class FocusTimeTracker {
  /**
   * @param {Object} [options]
   * @param {()=>number} [options.nowFn] - Função de relógio em ms (permite injeção em testes).
   */
  constructor(options = {}) {
    this.nowFn = options.nowFn || (() => Date.now());
    this.isWindowFocused = true;
    this.sessionStartMs = null;
    this.focusSegmentStartMs = null;
    this.accumulatedFocusMs = 0;
    this.lastBlurReason = null;

    this._bindBrowserEvents();
  }

  _bindBrowserEvents() {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    window.addEventListener('focus', () => this.onWindowFocus());
    window.addEventListener('blur', () => this.onWindowBlur('window_blur'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.onWindowBlur('switch_tab');
      } else {
        this.onWindowFocus();
      }
    });
  }

  /**
   * Inicia a contagem para um novo vídeo que começou a tocar no feed.
   */
  startVideoSession() {
    const now = this.nowFn();
    this.sessionStartMs = now;
    this.accumulatedFocusMs = 0;
    this.focusSegmentStartMs = this.isWindowFocused ? now : null;
    this.lastBlurReason = null;
  }

  /**
   * Chamado quando a janela perde foco ou a aba fica oculta.
   * @param {'switch_tab'|'window_blur'} [reason='switch_tab']
   */
  onWindowBlur(reason = 'switch_tab') {
    const now = this.nowFn();
    if (this.isWindowFocused && this.focusSegmentStartMs !== null) {
      this.accumulatedFocusMs += Math.max(0, now - this.focusSegmentStartMs);
      this.focusSegmentStartMs = null;
    }
    this.isWindowFocused = false;
    this.lastBlurReason = reason;
  }

  /**
   * Chamado quando a janela recupera o foco em primeiro plano.
   */
  onWindowFocus() {
    const now = this.nowFn();
    if (!this.isWindowFocused) {
      this.isWindowFocused = true;
      this.focusSegmentStartMs = now;
    }
  }

  /**
   * Finaliza ou consulta a medição atual do vídeo, retornando `duration` (tempo bruto)
   * e `focus_time` (tempo real com janela em foco).
   */
  getMetrics() {
    const now = this.nowFn();
    if (this.sessionStartMs === null) {
      return { duration: 0, focus_time: 0, is_focused: this.isWindowFocused };
    }

    const grossDuration = Math.max(0, now - this.sessionStartMs);
    let activeFocus = this.accumulatedFocusMs;
    if (this.isWindowFocused && this.focusSegmentStartMs !== null) {
      activeFocus += Math.max(0, now - this.focusSegmentStartMs);
    }

    return {
      duration: grossDuration,
      focus_time: Math.min(grossDuration, activeFocus),
      is_focused: this.isWindowFocused,
    };
  }
}
