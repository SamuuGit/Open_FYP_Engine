/**
 * @file signalEngine.test.js
 * @description Testes automatizados validando todas as regras da engenharia reversa:
 * 1. Regra dos 2 segundos (`is_skipped = 1` para 0 < playtime < 2000ms e `0` para >= 2000ms).
 * 2. Janela deslizante máxima de 20 itens no banco local e fatia dos últimos 16 itens no payload POST.
 * 3. Rastreamento das 11 flags booleanas de interação e `reportPlayFinish` (`is_finished = 1`).
 * 4. Separação entre tempo bruto (`duration`) e tempo real de foco (`focus_time`).
 * 5. Compressão Gzip do payload `realTimeClientInfo` e adaptação do motor de recomendação.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RealTimeSignalManager,
  FocusTimeTracker,
  VideoPlayReport,
  FeedApiClient,
  RecommendationEngine,
  shouldTriggerPrefetch,
  compressPayloadGzip,
  decompressPayloadGzip,
} from '../src/index.js';

test('Regra dos 2 segundos: marca is_skipped = 1 abaixo de 2000ms e is_skipped = 0 a partir de 2000ms', async () => {
  const manager = new RealTimeSignalManager({ uidOrWid: 'test_skip_rule' });
  await manager.init();

  // Assistiu por 950ms (< 2000ms) -> deve marcar is_skipped = 1
  const shortWatch = await manager.updatePlayTime('video_1', 950);
  assert.equal(shortWatch.playtime, 950);
  assert.equal(shortWatch.is_skipped, 1);

  // Assistiu por mais 1200ms (total 2150ms >= 2000ms) -> is_skipped deve passar para 0
  const longerWatch = await manager.updatePlayTime('video_1', 1200);
  assert.equal(longerWatch.playtime, 2150);
  assert.equal(longerWatch.playtime_max, 1200);
  assert.equal(longerWatch.is_skipped, 0);
});

test('Janela deslizante: mantém no máximo 20 vídeos no banco e envia os últimos 16 com playtime > 0 no payload', async () => {
  const manager = new RealTimeSignalManager({ uidOrWid: 'test_window_size' });
  await manager.init();

  // Insere 25 vídeos com playtime > 0
  for (let i = 1; i <= 25; i++) {
    await manager.updatePlayTime(`vid_${i}`, 2500);
  }

  // Insere 1 vídeo apenas impresso (playtime == 0)
  await manager.createOrGetConsumptionItem('vid_zero_playtime');

  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.consumptionItems.length, 20, 'Banco local deve reter no máximo 20 itens');
  assert.equal(snapshot.consumptionItems[0].id, 'vid_7', 'Itens mais antigos devem ser descartados');

  const payload = manager.getConsumptionParams();
  const sentItems = payload.realTimeClientInfo.consumption_data.consumption_items;
  assert.equal(sentItems.length, 16, 'Payload POST deve conter exatamente os últimos 16 vídeos com playtime > 0');
  assert.equal(sentItems[sentItems.length - 1].id, 'vid_25');
});

test('11 flags de interação e reportPlayFinish atualizam corretamente o item de consumo', async () => {
  const manager = new RealTimeSignalManager({ uidOrWid: 'test_interactions' });
  await manager.init();

  await manager.updatePlayTime('vid_inter', 5000);
  await manager.reportPlayFinish('vid_inter');
  await manager.updateVideoInteraction('vid_inter', 'like', 1);
  await manager.updateVideoInteraction('vid_inter', 'favorite', 1);
  await manager.updateVideoInteraction('vid_inter', 'comment', 1);
  await manager.updateVideoInteraction('vid_inter', 'enter_profile', 1);

  const [item] = manager.getConsumptionParams().realTimeClientInfo.consumption_data.consumption_items;
  assert.equal(item.is_finished, 1);
  assert.equal(item.is_liked, 1);
  assert.equal(item.is_favorited, 1);
  assert.equal(item.is_commentted, 1);
  assert.equal(item.is_entered_profile, 1);
  assert.equal(item.is_disliked, 0);
});

test('FocusTimeTracker separa tempo total aberto (duration) de tempo de foco ativo (focus_time)', () => {
  let fakeClock = 1000;
  const tracker = new FocusTimeTracker({ nowFn: () => fakeClock });

  tracker.startVideoSession(); // t = 1000ms (focado)
  fakeClock = 4000;            // +3000ms focado
  tracker.onWindowBlur('switch_tab');

  fakeClock = 10000;           // +6000ms com janela minimizada/em outra aba (não deve contar no focus_time)
  tracker.onWindowFocus();

  fakeClock = 12000;           // +2000ms focado novamente
  const metrics = tracker.getMetrics();

  assert.equal(metrics.duration, 11000, 'Duração bruta deve ser 11000ms');
  assert.equal(metrics.focus_time, 5000, 'Tempo em foco ativo deve ser exatamente 5000ms');
});

test('Gzip e Motor de Recomendação: comprime, descomprime e reordena o feed com base nos sinais', async () => {
  const engine = new RecommendationEngine();
  const manager = new RealTimeSignalManager({ uidOrWid: 'test_e2e' });
  await manager.init();

  const client = new FeedApiClient({
    signalManager: manager,
    requestHandler: (req) => engine.handleRecommendRequest(req),
  });

  // Usuário pula rapidamente vídeos de culinária (< 2s) e assiste até o fim + curte vídeos de tecnologia
  await manager.updatePlayTime('vid_culinaria_01', 600);
  await manager.updateVideoInteraction('vid_culinaria_01', 'dislike', 1);

  await manager.updatePlayTime('vid_tech_01', 18000);
  await manager.reportPlayFinish('vid_tech_01');
  await manager.updateVideoInteraction('vid_tech_01', 'like', 1);
  await manager.updateVideoInteraction('vid_tech_01', 'favorite', 1);

  const { request, response } = await client.fetchForYouFeed({
    isInitialLoad: false,
    isPrefetch: true,
  });

  assert.ok(request.compressedByteLength > 0);
  const decompressed = await decompressPayloadGzip(request.gzipBody);
  assert.equal(
    decompressed.realTimeClientInfo.consumption_data.consumption_items.length,
    2
  );

  // Categoria 'tecnologia' deve ter afinidade muito maior que 'culinaria'
  assert.ok(
    response.categoryAffinity.tecnologia > response.categoryAffinity.culinaria,
    'Tecnologia deve ser impulsionada e culinária penalizada'
  );
  assert.equal(response.itemList[0].category, 'tecnologia');
});

test('Gatilho de Prefetch suporta as estratégias halfway e penultimate', () => {
  assert.equal(
    shouldTriggerPrefetch({ currentIndex: 3, totalItems: 6, batchStartIndex: 0, strategy: 'halfway' }),
    true
  );
  assert.equal(
    shouldTriggerPrefetch({ currentIndex: 4, totalItems: 6, batchStartIndex: 0, strategy: 'penultimate' }),
    true
  );
});
