# Engine Open Source FYP (MIT)

Replicação *clean-room* em código aberto (licença MIT) da arquitetura de coleta de sinais de engajamento em tempo real, telemetria em duplo canal e pré-busca do feed **"Para Você" (*For You*)** mapeada na análise de engenharia reversa.

---

## 🚀 Como Utilizar o Código de Forma Funcional

Existem duas formas principais de usar este código:

### 🌟 Modo 1: Interface Visual Interativa no Navegador (Recomendado para Testes)

Criamos uma **interface web completa e funcional** que simula o feed do TikTok no navegador com um painel de telemetria ao vivo.

#### 1. Iniciar o Servidor
No terminal, entre na pasta do projeto e execute:
```powershell
cd "c:\Users\Samuel3\OneDrive\Desktop\Engenharia reversa\open-fyp-signal-engine"
npm start
```
*(Você verá: `🚀 Open FYP Server rodando em: http://localhost:3000`)*

#### 2. Abrir no Navegador
Abra o seu navegador (Chrome, Edge, Firefox, etc.) e acesse:
👉 **`http://localhost:3000`**

#### 3. O que você pode testar na interface:
- **Player estilo TikTok (lado esquerdo):**
  - Navegue usando os botões na tela, a **roda do mouse** ou as **setas ↑ / ↓** do teclado.
  - Passe um vídeo antes de 2 segundos para ver o carimbo **"PULO ATIVO (< 2s)"** disparando.
  - Deixe passar de 2 segundos para ver o status virar **"ENGAJAMENTO VÁLIDO"**.
  - Clique em **❤️ Curtir**, **⭐ Salvar**, **💬 Comentar** ou **🚫 Não tenho interesse**.
- **Painel de Controle do Algoritmo (lado direito):**
  - Veja o cronômetro do vídeo atual (`playtime` vs `focus_time`).
  - Observe o **"Bloco de Notas Invisível"** (tabela com os últimos 20 vídeos) sendo preenchido a cada rolagem.
  - Veja o gráfico de barras de **Afinidade do Servidor** mudando instantaneamente conforme suas preferências.

---

### 💻 Modo 2: Integrar em seu Próprio Aplicativo (Frontend & Backend)

Se você estiver construindo seu próprio app de vídeos curtos, feed de posts ou reels, pode importar os módulos diretamente no seu projeto:

#### No Frontend (React, Vue, Svelte, React Native ou Vanilla JS)
```javascript
import {
  RealTimeSignalManager,
  FocusTimeTracker,
  FeedApiClient
} from './src/index.js';

// 1. Inicializa o gerenciador local de sinais (Canal 1)
const signalManager = new RealTimeSignalManager({ uidOrWid: 'user_123' });
await signalManager.init();

// 2. Rastreador de foco (pausa quando o usuário sai da aba)
const focusTracker = new FocusTimeTracker();

// 3. Cliente de rede com compressão Gzip
const apiClient = new FeedApiClient({
  signalManager,
  requestHandler: async (req) => {
    // Envia para o seu próprio backend
    const res = await fetch('/api/recommend/item_list/', {
      method: req.method,
      headers: req.headers,
      body: req.gzipBody,
    });
    return res.json();
  }
});

// Ao rolar o vídeo, atualize o tempo assistido:
await signalManager.updatePlayTime('video_abc', 2500); // 2.5s (não é skip)

// Ao curtir o vídeo:
await apiClient.sendEngagementAction('video_abc', 'like');

// Ao pedir novos vídeos (comprime automaticamente os últimos 16 itens):
const newBatch = await apiClient.fetchForYouFeed();
```

#### No Backend (Node.js, Express, Fastify, etc.)
```javascript
import { RecommendationEngine, decompressPayloadGzip } from './src/index.js';

const engine = new RecommendationEngine();

// No endpoint que entrega o feed:
app.post('/api/recommend/item_list/', async (req, res) => {
  // Descomprime o Gzip enviado pelo cliente
  const body = req.headers['content-encoding'] === 'gzip'
    ? await decompressPayloadGzip(req.rawBody)
    : req.body;

  // O motor calcula os novos pesos e reordena os vídeos
  const responseData = await engine.handleRecommendRequest({
    endpoint: '/api/recommend/item_list/',
    queryParams: req.query,
    rawBodyObject: body,
  });

  res.json(responseData);
});
```

---

## 🧪 Testes Automatizados e Simulação via Terminal

Se preferir rodar apenas pelo terminal:
- **Testes unitários:** `npm test`
- **Simulação em texto:** `npm run demo`
