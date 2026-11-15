/**
 * @file runSimulation.js
 * @description Simulação completa ponta a ponta (Cliente <-> Servidor) demonstrando
 * toda a lógica replicada em funcionamento real.
 */

import {
  RealTimeSignalManager,
  FocusTimeTracker,
  VideoPlayReport,
  FeedApiClient,
  RecommendationEngine,
  SCROLL_METHODS,
  shouldTriggerPrefetch,
} from '../src/index.js';

async function run() {
  console.log('======================================================================');
  console.log(' OPEN FYP SIGNAL ENGINE — SIMULAÇÃO PONTA A PONTA (CLEAN-ROOM)');
  console.log('======================================================================\n');

  // 1. Inicializa o motor de recomendação (Servidor) e os módulos do Cliente
  const serverEngine = new RecommendationEngine();
  const signalManager = new RealTimeSignalManager({ uidOrWid: 'user_demo_9981' });
  await signalManager.init();

  const playReporter = new VideoPlayReport({
    batchSize: 5,
    transport: async (batch) => {
      console.log(
        `[Canal 2 -> POST /v1/list] Lote analítico enviado com ${batch[0].events.length} eventos.`
      );
    },
  });

  const apiClient = new FeedApiClient({
    signalManager,
    playReporter,
    requestHandler: async (req) => {
      if (req.endpoint.includes('/recommend/item_list/')) {
        return serverEngine.handleRecommendRequest(req);
      }
      return { statusCode: 0 };
    },
  });

  // 2. Carregamento inicial do feed ("Para Você" - pullType: 1, count: 6)
  console.log('1) Abrindo o aplicativo -> Solicitando lote inicial (count: 6)...');
  const initialFeed = await apiClient.fetchForYouFeed({ isInitialLoad: true });
  console.log(
    `   Recebidos ${initialFeed.response.itemList.length} vídeos iniciais | Qualidade: ${initialFeed.response.streamProfile.resolution}\n`
  );

  // 3. Simula o comportamento do usuário assistindo a vídeos variados
  const simulatedActions = [
    {
      video: { id: 'vid_culinaria_01', author: '@chef_em_casa', durationMs: 14000 },
      watchMs: 850, // Menos de 2 segundos -> Regra de Skip (is_skipped = 1)
      focusMs: 850,
      scrollMethod: SCROLL_METHODS.SLIDE,
      interactions: [],
      desc: 'Pulou rápido em 0.85s (< 2s -> is_skipped = 1)',
    },
    {
      video: { id: 'vid_esportes_01', author: '@futebol_tatico', durationMs: 16000 },
      watchMs: 1400, // Menos de 2 segundos -> Regra de Skip (is_skipped = 1)
      focusMs: 1400,
      scrollMethod: SCROLL_METHODS.SLIDE,
      interactions: ['dislike'],
      desc: 'Pulou em 1.40s (< 2s -> is_skipped = 1) e clicou em "Não interessado"',
    },
    {
      video: { id: 'vid_tech_01', author: '@dev_brasil', durationMs: 18000 },
      watchMs: 18000, // Assistiu até o fim (100%)
      focusMs: 18000,
      finished: true,
      scrollMethod: SCROLL_METHODS.KEYBOARD,
      interactions: ['like', 'favorite'],
      desc: 'Assistiu 100% (18s -> is_finished = 1), curtiu e favoritou',
    },
    {
      video: { id: 'vid_ciencia_01', author: '@astro_fatos', durationMs: 21000 },
      watchMs: 15000, // Vídeo ficou aberto 15s, mas usuário trocou de aba aos 6s!
      focusMs: 6000,
      tabSwitched: true,
      scrollMethod: SCROLL_METHODS.CLICK_BUTTON,
      interactions: ['like', 'click_comment'],
      desc: 'Aberto por 15s (foco real de 6s por troca de janela), curtiu e abriu comentários',
    },
  ];

  console.log('2) Simulando navegação do usuário no feed:\n');

  for (let idx = 0; idx < simulatedActions.length; idx++) {
    const step = simulatedActions[idx];
    const { video } = step;

    // Confirma impressão na tela
    await apiClient.recordImpression(video.id);

    // Dispara evento de início de vídeo no Canal 2
    playReporter.sendVideoPlayEvent({
      item_id: video.id,
      author_id: video.author,
      scroll_method: step.scrollMethod,
      item_list_index: idx,
    });

    // Se houve troca de aba/janela, reporta pausa por switch_tab
    if (step.tabSwitched) {
      playReporter.sendPauseEvent({
        item_id: video.id,
        enter_method: 'switch_tab',
      });
    }

    // Atualiza tempo de reprodução no Canal 1 (RealTimeSignalManager)
    const updatedItem = await signalManager.updatePlayTime(video.id, step.watchMs);

    // Se assistiu até o fim, marca is_finished = 1
    if (step.finished) {
      await signalManager.reportPlayFinish(video.id);
      playReporter.sendPlayFinishEvent({ item_id: video.id, loop_count: 1 });
    }

    // Registra interações explícitas (like, favorite, dislike, etc.)
    for (const action of step.interactions) {
      await apiClient.sendEngagementAction(video.id, action);
    }

    // Dispara evento play_time no Canal 2 com duration vs focus_time
    playReporter.sendPlayTimeEvent({
      item_id: video.id,
      duration: step.watchMs,
      focus_time: step.focusMs,
      video_duration: video.durationMs,
    });

    console.log(
      `   [Vídeo ${idx + 1}: ${video.id}] ${step.desc}\n` +
        `      -> Estado salvo no IndexedDB: playtime=${updatedItem.playtime}ms | is_skipped=${updatedItem.is_skipped} | is_finished=${step.finished ? 1 : 0}`
    );

    // Verifica se atingiu o ponto de pré-busca (halfway)
    const triggerPrefetch = shouldTriggerPrefetch({
      currentIndex: idx,
      totalItems: initialFeed.response.itemList.length,
      batchStartIndex: 0,
      strategy: 'halfway',
    });

    if (triggerPrefetch) {
      console.log(
        `\n   ⚡ [Gatilho de Prefetch Atingido no índice ${idx}] Disparando POST /api/prefetch/recommend/item_list/ com os sinais coletados!`
      );
      const prefetchResult = await apiClient.fetchForYouFeed({
        isInitialLoad: false,
        isPrefetch: true,
      });

      console.log(
        `      Payload JSON: ${prefetchResult.request.uncompressedByteLength} bytes -> Comprimido Gzip: ${prefetchResult.request.compressedByteLength} bytes`
      );
      console.log(
        `      Afinidade calculada pelo servidor a partir dos sinais:`,
        prefetchResult.response.categoryAffinity
      );
      console.log(
        `      Top 3 próximos vídeos recomendados:`,
        prefetchResult.response.itemList
          .slice(0, 3)
          .map((v) => `${v.id} (${v.category} | score: ${v.rankingScore})`)
      );
      console.log('');
    }
  }

  await playReporter.flushBatch();
  console.log('\n======================================================================');
  console.log(' Simulação concluída com sucesso!');
  console.log('======================================================================');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
