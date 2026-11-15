# Shufflune — Documentação Técnica

> Extensão Chrome (Manifest V3) que funciona como um DJ inteligente em cima do Spotify, intercalando múltiplas playlists em um fluxo contínuo sem criar playlists permanentes.

---

## Sumário

- [Arquitetura](#arquitetura)
- [Estrutura de Arquivos](#estrutura-de-arquivos)
- [Autenticação](#autenticação)
- [Spotify API — Rotas Utilizadas](#spotify-api--rotas-utilizadas)
- [Motor do DJ](#motor-do-dj)
- [Algoritmos de Mistura](#algoritmos-de-mistura)
- [Comunicação Popup ↔ Service Worker](#comunicação-popup--service-worker)
- [Interface — Telas e Componentes](#interface--telas-e-componentes)
- [Sistema de Temas](#sistema-de-temas)
- [Estado e Persistência](#estado-e-persistência)
- [Limitações da API Spotify (Dev Mode)](#limitações-da-api-spotify-dev-mode)
- [Configuração e Deploy](#configuração-e-deploy)

---

## Arquitetura

```
┌─────────────────────────────────────────────────┐
│              Chrome Extension (MV3)             │
│                                                 │
│  ┌──────────────┐        ┌───────────────────┐  │
│  │  Side Panel  │◄──────►│  Service Worker   │  │
│  │  (popup.html │  msgs  │  (background.js)  │  │
│  │   popup.js   │        │                   │  │
│  │   popup.css) │        │  Auth + DJ Engine │  │
│  └──────────────┘        └────────┬──────────┘  │
│                                   │             │
│                          chrome.storage.local   │
│                          chrome.alarms          │
│                          chrome.identity        │
└───────────────────────────────────┼─────────────┘
                                    │ fetch
                          ┌─────────▼──────────┐
                          │    Spotify API      │
                          │  api.spotify.com    │
                          │  accounts.spotify.com│
                          └────────────────────┘
```

**Sem backend.** Toda a lógica roda no service worker do Chrome. A autenticação é feita via OAuth 2.0 PKCE diretamente no browser.

---

## Estrutura de Arquivos

```
shufflune/
├── manifest.json       # Configuração da extensão (MV3)
├── background.js       # Service worker: auth, API, motor do DJ
├── popup.html          # Estrutura HTML do side panel
├── popup.css           # Estilos + sistema de temas
├── popup.js            # Lógica da interface
└── icons/
    ├── shufflune16.png
    ├── shufflune48.png
    └── shufflune128.png
```

---

## Autenticação

### Fluxo: OAuth 2.0 Authorization Code + PKCE

Usado porque a extensão não tem backend — o `client_secret` não pode ser exposto.

```
Usuário clica "Entrar"
        │
        ▼
generateCodeVerifier()  →  64 bytes aleatórios (base64url)
generateCodeChallenge() →  SHA-256 do verifier (base64url)
        │
        ▼
chrome.identity.launchWebAuthFlow()
  URL: https://accounts.spotify.com/authorize
  Params: client_id, response_type=code, redirect_uri,
          scope, code_challenge_method=S256,
          code_challenge, show_dialog=true
        │
        ▼
Spotify redireciona para redirect_uri com ?code=...
        │
        ▼
exchangeCode(code, verifier)
  POST https://accounts.spotify.com/api/token
  Body: grant_type=authorization_code, code, redirect_uri,
        client_id, code_verifier
        │
        ▼
saveTokens() → chrome.storage.local
  { access_token, refresh_token, expires_at }
```

### Scopes Solicitados

| Scope | Finalidade |
|---|---|
| `playlist-read-private` | Ler playlists privadas do usuário |
| `playlist-read-collaborative` | Ler playlists colaborativas |
| `user-read-playback-state` | Ver o que está tocando |
| `user-modify-playback-state` | Controlar reprodução e fila |
| `user-read-currently-playing` | Música atual |
| `user-library-read` | Acesso à biblioteca do usuário |

### Renovação de Token

```javascript
// getAccessToken() — chamado antes de toda requisição
if (Date.now() < expires_at - 60000) return access_token; // válido (margem de 1 min)

// senão, renova via refresh_token:
POST https://accounts.spotify.com/api/token
Body: grant_type=refresh_token, refresh_token, client_id
```

Se o refresh falhar (token revogado), os tokens são removidos do storage e o usuário precisa logar novamente.

---

## Spotify API — Rotas Utilizadas

### Autenticação

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `https://accounts.spotify.com/api/token` | Troca code por tokens (PKCE) |
| `POST` | `https://accounts.spotify.com/api/token` | Renova access token via refresh |

### Web API

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/me` | Perfil do usuário autenticado |
| `GET` | `/me/playlists?limit=50` | Lista de playlists do usuário (paginada) |
| `GET` | `/playlists/{id}/items?limit=50` | Faixas de uma playlist (paginada) |
| `GET` | `/me/player` | Estado atual da reprodução |
| `POST` | `/me/player/play` | Inicia reprodução de uma faixa |
| `POST` | `/me/player/queue?uri={uri}` | Adiciona faixa à fila do Spotify |

> **Atenção — mudança de fevereiro/2026:** O endpoint `/playlists/{id}/tracks` foi descontinuado em Development Mode. O endpoint correto agora é `/playlists/{id}/items`. O campo da faixa também mudou: `item.track` → `item.item` (com fallback para `item.track` por compatibilidade).

### Paginação

Todos os endpoints de listagem são paginados. O código segue o campo `next` retornado pela API até que seja `null`:

```javascript
let url = '/me/playlists?limit=50';
while (url) {
  const data = await spotifyGet(url);
  // processa data.items...
  url = data.next ? data.next.replace('https://api.spotify.com/v1', '') : null;
}
```

---

## Motor do DJ

### Estado Global (`djState`)

```javascript
let djState = {
  isRunning: false,
  sources: [],          // [{ playlistId, name, tracks[], weight, sortOrder }]
  mode: 'interleaved',  // 'interleaved' | 'weighted' | 'shuffle'
  queue: [],            // sequência completa gerada antes da reprodução
  queuedCount: 0,       // quantas músicas já foram enviadas ao Spotify
  currentTrackUri: null,
};

const QUEUE_BUFFER = 15; // músicas pré-enfileiradas à frente da atual
```

### Ciclo de vida

```
START_DJ (mensagem do popup)
        │
        ▼
startDJFromSelectedPlaylists()
  ├── deduplica playlists selecionadas
  ├── fetchPlaylistTracks() para cada uma (Promise.allSettled)
  │     └── playlists com 403 ou vazias são puladas com log
  └── mínimo de 2 fontes válidas para iniciar
        │
        ▼
startDJ(sources, mode)
  ├── buildQueue(sources, mode)  → aplica sortOrder + gera queue completo
  ├── playTrack(queue[0])        → inicia reprodução no Spotify
  ├── fillQueue()                → enfileira os próximos QUEUE_BUFFER
  └── chrome.alarms.create('djMonitor', { periodInMinutes: 0.5 })
        │
        ▼ (a cada 30 segundos)
chrome.alarms.onAlarm → 'djMonitor'
  ├── getPlaybackState() → descobre qual música está tocando
  ├── localiza índice na queue pelo URI atual
  └── fillQueue() → enfileira músicas até o buffer estar cheio
```

### Enfileiramento

```javascript
// fillQueue — enfileira músicas mantendo QUEUE_BUFFER de antecedência
const toQueue = Math.min(QUEUE_BUFFER, queue.length - queuedCount);
for (let i = 0; i < toQueue; i++) {
  await addToQueue(track.uri);
  djState.queuedCount++;
  await new Promise(r => setTimeout(r, 200)); // throttle anti rate-limit
}
```

O delay de 200ms entre chamadas à `/me/player/queue` evita rate limiting da API do Spotify.

---

## Algoritmos de Mistura

### Ordenação interna (`sortOrder`) — aplicada antes de qualquer modo

Cada source tem um campo `sortOrder`:

| Valor | Comportamento |
|---|---|
| `original` | Mantém a ordem exata que veio do Spotify (default) |
| `shuffle` | Embaralha com Fisher-Yates antes da mistura |

```javascript
function applySortOrder(source) {
  if (source.sortOrder === 'shuffle') return { ...source, tracks: fisherYates([...source.tracks]) };
  return { ...source, tracks: [...source.tracks] };
}
```

> **Quando aparece na UI:** `sortOrder` só é configurável no modo **Intercalado**, pois impacta diretamente o padrão de alternância. Nos outros modos o controle é omitido.

---

### Intercalado Fluído (`interleaved`) — default

Sem padrão fixo (não é ABAB). Blocos aleatórios de 1–3 músicas por playlist, ordem das playlists re-embaralhada a cada rodada.

```
Exemplo de saída: A, B, B, A, C, A, C, C, B, A, B, C, ...
```

**Algoritmo:**
1. Cria uma ordem aleatória das N playlists
2. Para cada playlist na ordem: escolhe um bloco de 1–3 músicas (aleatório)
3. Ao completar uma volta por todas as playlists: re-embaralha a ordem
4. Repete até esgotar todas as faixas de todas as playlists

> O controle **Ordem** (Original / Embaralhar) aparece apenas nesse modo, pois a ordem interna da playlist afeta o resultado final.

---

### Proporcional (`weighted`)

Cada playlist tem um `weight` (1–10). Playlists com peso maior aparecem proporcionalmente mais vezes na fila.

```
Exemplo: Rock(peso=3), Pop(peso=1)
Saída aproximada: Rock, Pop, Rock, Rock, Pop, Rock, Rock, Pop, ...
(sem padrão fixo — janelas são embaralhadas)
```

**Algoritmo:**
1. Monta uma janela com `weight × 3` slots por playlist
2. Embaralha a janela com Fisher-Yates
3. Remove duplicatas consecutivas para parecer mais natural
4. Emite as músicas da janela avançando os ponteiros
5. Repete com nova janela até esgotar tudo

> O controle **Peso** (stepper −/+, 1–10) aparece apenas nesse modo.

---

### Aleatório Global (`shuffle`)

Todas as músicas de todas as playlists vão para um pool único, então Fisher-Yates é aplicado sobre o pool inteiro. A origem da playlist é ignorada após isso.

```javascript
const pool = sources.flatMap(s => s.tracks.map(t => ({ ...t, sourceId: s.playlistId })));
return fisherYates(pool);
```

> Nenhum controle extra aparece nesse modo — nem Peso nem Ordem, pois o resultado já é completamente aleatório independente de qualquer configuração.

---

## Comunicação Popup ↔ Service Worker

Toda comunicação usa `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`.

### Mensagens disponíveis

| `type` | Payload | Resposta | Descrição |
|---|---|---|---|
| `AUTH_LOGIN` | — | `{ ok, auth }` | Inicia fluxo OAuth |
| `AUTH_LOGOUT` | — | `{ ok }` | Remove tokens e para o DJ |
| `AUTH_STATUS` | — | `{ loggedIn }` | Verifica se há token válido |
| `GET_PLAYLISTS` | — | `{ playlists[] }` | Lista playlists acessíveis |
| `START_DJ` | `{ selectedPlaylists[], mode }` | `{ ok, totalTracks, skipped, skippedPlaylists[] }` | Inicia o DJ |
| `STOP_DJ` | — | `{ ok }` | Para o DJ, limpa alarme e reseta estado |
| `DJ_STATUS` | — | `{ isRunning, mode, totalQueued, totalTracks }` | Estado atual do DJ |

### Payload de `selectedPlaylists`

```javascript
[{
  id: 'playlist_id',
  name: 'Nome da playlist',
  weight: 3,            // 1–10, usado no modo weighted
  sortOrder: 'shuffle', // 'original' | 'shuffle', usado no modo interleaved
  ownerId: 'user_id',
  collaborative: false,
}]
```

---

## Interface — Telas e Componentes

O side panel tem 3 telas gerenciadas por `showScreen(id)`:

### Tela 1: Login (`#screen-login`)

- Logo + subtítulo
- Botão "Entrar com Spotify" → dispara `AUTH_LOGIN`
- Estrelinhas decorativas animadas

### Tela 2: Seleção (`#screen-select`)

- **Top bar:** título + botão logout
- **Seletor de tema:** 4 dots clicáveis
- **Pills de modo:** Intercalado / Proporcional / Aleatório
  - Ao trocar de modo: a lista re-renderiza e os controles extras se atualizam
  - Dica contextual aparece só no modo Proporcional
- **Campo de busca:** filtra playlists em tempo real pelo nome, sem perder seleções
- **Lista de playlists:** só exibe playlists onde o usuário é dono ou colaborador
  - Thumbnail + nome + contagem de músicas
  - Ao selecionar: aparece o controle extra contextual:
    - **Intercalado** → select "Ordem" (Original / Embaralhar)
    - **Proporcional** → stepper "Peso" (botões −/+, valor 1–10)
    - **Aleatório** → nenhum controle extra
- **Footer:** botão "Iniciar fluxo" (habilitado com ≥ 2 playlists selecionadas)

### Tela 3: DJ Rodando (`#screen-playing`)

- **Orb animado** com `orb-pulse` (escala 1 → 1.07)
- **Status:** modo ativo
- **Progresso:** `queued / total` músicas + barra de progresso
- **Fontes ativas:** tags das playlists em uso
- **Footer:** botões Parar / Nova mistura / Logout
- **Polling a cada 5s** via `setInterval` → `DJ_STATUS`

### Reset de estado ao parar

`resetSelectState()` é chamada em Parar / Nova mistura / Logout. Garante:
- `selectedPlaylists` (Map) limpo
- Campo de busca resetado
- Pills de modo voltam para Intercalado
- Botão "Iniciar fluxo" desabilitado
- Polling encerrado

---

## Sistema de Temas

4 temas via CSS custom properties em `[data-theme]`:

| ID | Nome | Cor principal |
|---|---|---|
| `rosegold` | Rose Gold | `#fbbf24` (amarelo/dourado) |
| `midnight` | Midnight | `#c77dff` (lilás) |
| `sakura` | Sakura | `#f9a8d4` (rosa) |
| `aurora` | Aurora | `#67e8f9` (ciano) |

Variáveis usadas por todos os componentes:

```css
--ph-bg           /* gradiente de fundo */
--ph-accent       /* cor principal do tema */
--ph-muted        /* textos secundários */
--ph-card         /* fundo de cards */
--ph-gradient     /* gradiente de botões e orb */
--ph-btn-glow     /* sombra do botão primário */
--ph-orb-glow     /* sombra do orb */
```

Tema salvo em `chrome.storage.local` e restaurado no carregamento.

---

## Estado e Persistência

Tudo via `chrome.storage.local`:

| Chave | Tipo | Conteúdo |
|---|---|---|
| `access_token` | `string` | Token OAuth atual |
| `refresh_token` | `string` | Token de renovação |
| `expires_at` | `number` | Timestamp de expiração (ms) |
| `code_verifier` | `string` | Verifier PKCE (temporário, usado só durante auth) |
| `djState` | `object` | Estado completo do DJ (restaurado ao reiniciar o service worker) |
| `theme` | `string` | ID do tema selecionado |

O `djState` é salvo após cada operação para sobreviver ao ciclo de vida do service worker (que pode ser encerrado pelo Chrome a qualquer momento). Ao `STOP_DJ`, o `djState` é completamente resetado no storage e em memória.

---

## Limitações da API Spotify (Dev Mode)

Desde **fevereiro de 2026**, apps em Development Mode têm restrições adicionais:

| Restrição | Detalhe |
|---|---|
| **Endpoint `/playlists/{id}/tracks` removido** | Usar `/playlists/{id}/items` |
| **`/playlists/{id}/items` só funciona para playlists próprias ou colaborativas** | Playlists públicas de outros usuários retornam 403 |
| **Máximo de 5 usuários por app** | Configurado em User Management no dashboard |
| **Owner precisa ter Spotify Premium** | O DJ usa `queue` e `play`, que são funcionalidades Premium |
| **Limite de busca reduzido** | `/search` retorna no máximo 10 resultados |

Para remover essas restrições, é necessário solicitar **Extended Quota Mode** via formulário no [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).

---

## Configuração e Deploy

### Pré-requisitos

- Chrome 114+ (suporte a Side Panel API)
- Conta Spotify com Premium ativa
- App registrado em [developer.spotify.com](https://developer.spotify.com)

### Setup do app Spotify

1. Criar app em developer.spotify.com/dashboard
2. Em **Edit Settings**, adicionar a Redirect URI:
   ```
   https://<extension-id>.chromiumapp.org/
   ```
   O ID da extensão pode ser obtido em `chrome://extensions` após carregar o app.
3. Marcar **Web API** como API em uso
4. Copiar o **Client ID**

### Instalação da extensão

1. Abrir `chrome://extensions`
2. Ativar **Modo do desenvolvedor**
3. Clicar em **Carregar sem compactação**
4. Selecionar a pasta do projeto

### Configuração do Client ID

Copie `config.example.js` para `config.js` (ignorado pelo git) e defina:

```javascript
const CLIENT_ID = "seu_client_id_aqui";
```

### Uso

1. Clicar no ícone da extensão na barra do Chrome → o side panel abre na lateral direita
2. Fazer login com Spotify
3. Selecionar 2 ou mais playlists (apenas playlists próprias ou colaborativas)
4. Escolher o modo de mistura
5. Configurar os controles contextuais por playlist (aparecem ao selecionar):
   - **Intercalado:** Ordem (Original mantém a sequência do Spotify; Embaralhar aplica Fisher-Yates antes da mistura)
   - **Proporcional:** Peso 1–10 (playlists com peso maior aparecem mais vezes)
   - **Aleatório:** sem controles (pool global embaralhado)
6. Clicar em **Iniciar fluxo**
7. O Spotify precisa estar ativo em algum dispositivo para o enfileiramento funcionar
