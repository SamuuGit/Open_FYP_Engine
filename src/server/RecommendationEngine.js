/**
 * @file RecommendationEngine.js
 * @description Motor de recomendação em código aberto que consome os sinais enviados pelo cliente
 * (`realTimeClientInfo.consumption_data.consumption_items`) e ranqueia o próximo lote de vídeos.
 *
 * Demonstra na prática como o servidor interpreta os sinais coletados pelo cliente:
 * - Penalização imediata quando `is_skipped === 1` (< 2 segundos) ou `is_disliked === 1`.
 * - Impulso forte quando `is_finished === 1` (assistiu até o fim / replay), `is_liked === 1`,
 *   `is_favorited === 1`, `is_shared === 1` ou `is_entered_profile === 1`.
 * - Ponderação contínua por `playtime` e `playtime_max`.
 * - Adaptação automática de bitrate/resolução com base em `device_score`, `network` e `block_count`.
 */

import { decompressPayloadGzip } from '../core/FeedApiClient.js';

export const DEFAULT_VIDEO_CATALOG = [
  { id: 'vid_tech_01', category: 'tecnologia', author: '@dev_brasil', title: 'Como funciona um processador por dentro', durationMs: 18000 },
  { id: 'vid_tech_02', category: 'tecnologia', author: '@ia_explicada', title: 'Redes neurais em 15 segundos', durationMs: 15000 },
  { id: 'vid_tech_03', category: 'tecnologia', author: '@cyber_sec', title: 'Análise de pacotes de rede na prática', durationMs: 22000 },
  { id: 'vid_culinaria_01', category: 'culinaria', author: '@chef_em_casa', title: 'Pão de queijo crocante de 3 ingredientes', durationMs: 14000 },
  { id: 'vid_culinaria_02', category: 'culinaria', author: '@doces_rapidos', title: 'Brigadeiro perfeito sem grudar', durationMs: 12000 },
  { id: 'vid_culinaria_03', category: 'culinaria', author: '@churrasco_pro', title: 'Ponto exato da carne na brasa', durationMs: 19000 },
  { id: 'vid_esportes_01', category: 'esportes', author: '@futebol_tatico', title: 'Análise do gol de ontem em câmera lenta', durationMs: 16000 },
  { id: 'vid_esportes_02', category: 'esportes', author: '@corrida_urbana', title: 'Como melhorar seu ritmo nos 5km', durationMs: 15000 },
  { id: 'vid_musica_01', category: 'musica', author: '@violao_solo', title: 'Acordes que deixam qualquer música bonita', durationMs: 20000 },
  { id: 'vid_musica_02', category: 'musica', author: '@synth_lab', title: 'Criando um beat lo-fi do zero', durationMs: 17000 },
  { id: 'vid_humor_01', category: 'humor', author: '@comedia_diaria', title: 'Expectativa vs Realidade no trabalho remoto', durationMs: 11000 },
  { id: 'vid_humor_02', category: 'humor', author: '@memes_br', title: 'Quando o código funciona de primeira', durationMs: 10000 },
  { id: 'vid_ciencia_01', category: 'ciencia', author: '@astro_fatos', title: 'O tamanho real das estrelas no universo', durationMs: 21000 },
  { id: 'vid_ciencia_02', category: 'ciencia', author: '@fisica_curiosa', title: 'Por que o gelo flutua na água?', durationMs: 15000 },
];

/**
 * Pesos transparentes atribuídos a cada sinal do `consumption_items`.
 */
export const SIGNAL_WEIGHTS = Object.freeze({
  SKIP_PENALTY: -4.5,          // Pulou em menos de 2 segundos (is_skipped = 1)
  DISLIKE_PENALTY: -10.0,      // Clicou em "Não tenho interesse" (is_disliked = 1)
  REPORT_PENALTY: -20.0,       // Denunciou o vídeo (is_reported = 1)
  FINISH_BOOST: +5.0,          // Assistiu até o fim / replay (is_finished = 1)
  LIKE_BOOST: +4.0,            // Curtiu (is_liked = 1)
  FAVORITE_BOOST: +6.0,        // Favoritou / salvou (is_favorited = 1)
  SHARE_BOOST: +7.0,           // Compartilhou (is_shared = 1)
  FOLLOW_BOOST: +8.0,          // Seguiu o criador (is_followed = 1)
  COMMENT_BOOST: +4.5,         // Comentou (is_commentted = 1)
  CLICK_COMMENT_BOOST: +2.0,   // Abriu a aba de comentários (is_click_comment = 1)
  ENTER_PROFILE_BOOST: +3.0,   // Entrou no perfil do autor (is_entered_profile = 1)
  PLAYTIME_PER_SEC: +0.35,     // Bônus por cada segundo efetivamente assistido
});

export class RecommendationEngine {
  constructor(catalog = DEFAULT_VIDEO_CATALOG) {
    this.catalog = [...catalog];
    this.videoMap = new Map(this.catalog.map((v) => [v.id, v]));
  }

  /**
   * Calcula a pontuação de um único item consumido com base nas flags do `RealTimeSignalManager`.
   */
  scoreConsumptionItem(item) {
    let score = 0;

    if (item.is_skipped === 1) score += SIGNAL_WEIGHTS.SKIP_PENALTY;
    if (item.is_disliked === 1) score += SIGNAL_WEIGHTS.DISLIKE_PENALTY;
    if (item.is_reported === 1) score += SIGNAL_WEIGHTS.REPORT_PENALTY;

    if (item.is_finished === 1) score += SIGNAL_WEIGHTS.FINISH_BOOST;
    if (item.is_liked === 1) score += SIGNAL_WEIGHTS.LIKE_BOOST;
    if (item.is_favorited === 1) score += SIGNAL_WEIGHTS.FAVORITE_BOOST;
    if (item.is_shared === 1) score += SIGNAL_WEIGHTS.SHARE_BOOST;
    if (item.is_followed === 1) score += SIGNAL_WEIGHTS.FOLLOW_BOOST;
    if (item.is_commentted === 1) score += SIGNAL_WEIGHTS.COMMENT_BOOST;
    if (item.is_click_comment === 1) score += SIGNAL_WEIGHTS.CLICK_COMMENT_BOOST;
    if (item.is_entered_profile === 1) score += SIGNAL_WEIGHTS.ENTER_PROFILE_BOOST;

    // Bônus proporcional ao tempo assistido (quando não foi pulado em < 2s)
    if (item.is_skipped === 0 && item.playtime > 0) {
      const watchedSeconds = Math.min(30, item.playtime / 1000);
      score += watchedSeconds * SIGNAL_WEIGHTS.PLAYTIME_PER_SEC;
    }

    return Number(score.toFixed(2));
  }

  /**
   * Escolhe a qualidade ideal de vídeo considerando `network` (Mbps), `device_score`
   * e se o cliente reportou travamentos (`block_count > 0`) nos últimos vídeos.
   */
  selectAdaptiveStreamQuality(queryParams = {}, consumptionItems = []) {
    const totalBlocks = consumptionItems.reduce((acc, i) => acc + (i.block_count || 0), 0);
    const networkMbps = Number(queryParams.network ?? 10);
    const deviceScore = Number(queryParams.device_score ?? 8);

    if (totalBlocks >= 2 || networkMbps < 2.5 || deviceScore < 4) {
      return { resolution: '480p', bitrateKbps: 650, reason: 'protecao_contra_travamento' };
    }
    if (networkMbps < 6 || deviceScore < 6.5) {
      return { resolution: '720p', bitrateKbps: 1400, reason: 'equilibrio_rede_hardware' };
    }
    return { resolution: '1080p', bitrateKbps: 2800, reason: 'alta_capacidade' };
  }

  /**
   * Processa uma requisição de `/api/recommend/item_list/` ou `/api/prefetch/recommend/item_list/`
   * (descomprimindo o corpo Gzip se necessário) e retorna o lote personalizado.
   */
  async handleRecommendRequest(requestDescriptor) {
    let body = requestDescriptor.rawBodyObject;
    if (!body && requestDescriptor.gzipBody) {
      body = await decompressPayloadGzip(requestDescriptor.gzipBody);
    }

    const consumptionData = body?.realTimeClientInfo?.consumption_data || {};
    const consumptionItems = consumptionData.consumption_items || [];
    const queryParams = requestDescriptor.queryParams || {};
    const requestedCount = Number(queryParams.count || 6);

    // 1. Calcula afinidade por categoria a partir dos últimos 16 vídeos assistidos
    const categoryAffinity = {};
    for (const video of this.catalog) {
      categoryAffinity[video.category] = 1.0; // Afinidade base neutra
    }

    const itemDiagnostics = [];
    for (const item of consumptionItems) {
      const catalogEntry = this.videoMap.get(item.id);
      const category = catalogEntry ? catalogEntry.category : 'desconhecida';
      const deltaScore = this.scoreConsumptionItem(item);

      if (categoryAffinity[category] !== undefined) {
        categoryAffinity[category] = Number(
          (categoryAffinity[category] + deltaScore).toFixed(2)
        );
      }

      itemDiagnostics.push({
        id: item.id,
        category,
        playtimeMs: item.playtime,
        isSkipped: item.is_skipped === 1,
        isFinished: item.is_finished === 1,
        isLiked: item.is_liked === 1,
        deltaScore,
      });
    }

    // 2. Define a qualidade de stream adaptativa
    const streamProfile = this.selectAdaptiveStreamQuality(queryParams, consumptionItems);

    // 3. Ordena os vídeos candidatos priorizando as categorias com maior afinidade
    const watchedIds = new Set(consumptionItems.map((i) => i.id));
    const rankedCandidates = [...this.catalog]
      .map((video) => {
        const alreadyWatchedPenalty = watchedIds.has(video.id) ? -3.0 : 0;
        const rankingScore = Number(
          ((categoryAffinity[video.category] ?? 1.0) + alreadyWatchedPenalty).toFixed(2)
        );
        return {
          ...video,
          rankingScore,
          streamProfile,
        };
      })
      .sort((a, b) => b.rankingScore - a.rankingScore);

    return {
      statusCode: 0,
      statusMsg: 'success',
      isPrefetch: requestDescriptor.endpoint.includes('prefetch'),
      pullType: queryParams.pullType,
      requestedCount,
      receivedConsumptionCount: consumptionItems.length,
      streamProfile,
      categoryAffinity,
      itemDiagnostics,
      itemList: rankedCandidates.slice(0, requestedCount),
    };
  }
}
