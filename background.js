// ============================================================
// CONFIGURAÇÃO
// ============================================================
const CLIENT_ID = "SEU_CLIENT_ID_AQUI";
const REDIRECT_URI = chrome.identity.getRedirectURL();
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-library-read",
].join(" ");

// ============================================================
// ESTADO INTERNO DO DJ
// ============================================================
let djState = {
  isRunning: false,
  sources: [],
  mode: "interleaved",
  // queue armazena só URIs + sourceId para economizar storage
  // { uri, sourceId, name, artistNames }
  queue: [],
  queuedCount: 0,
  currentTrackUri: null,
  startedAt: null, // timestamp de início (para histórico)
};

const QUEUE_BUFFER = 15;
let djStartPromise = null;
let isFilling = false; // debounce anti-duplicação no fillQueue

// ============================================================
// AUTENTICAÇÃO — OAuth PKCE (não alterar)
// ============================================================
let authInProgress = false;
let authPromise = null;
let currentUserProfile = null;

function generateCodeVerifier() {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function authenticate() {
  if (authPromise) return authPromise;
  authInProgress = true;
  authPromise = runSpotifyAuthFlow()
    .catch((e) => {
      throw e;
    })
    .finally(() => {
      authInProgress = false;
      authPromise = null;
    });
  return authPromise;
}

async function runSpotifyAuthFlow() {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  await chrome.storage.local.set({ code_verifier: verifier });
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
    show_dialog: "true",
  });
  const authUrl = `https://accounts.spotify.com/authorize?${params}`;
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      async (redirectUrl) => {
        if (chrome.runtime.lastError || !redirectUrl) {
          reject(chrome.runtime.lastError?.message || "Auth cancelada");
          return;
        }
        const code = new URL(redirectUrl).searchParams.get("code");
        if (!code) {
          reject("Código não encontrado");
          return;
        }
        try {
          const tokens = await exchangeCode(code, verifier);
          await saveTokens(tokens);
          resolve(tokens);
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

function getAuthStatus() {
  return { inProgress: authInProgress };
}

async function exchangeCode(code, verifier) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error("Falha ao trocar código por token");
  return res.json();
}

async function saveTokens(tokens) {
  const expiresAt = Date.now() + tokens.expires_in * 1000;
  const saved = await chrome.storage.local.get("refresh_token");
  await chrome.storage.local.set({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || saved.refresh_token,
    expires_at: expiresAt,
  });
}

async function getAccessToken() {
  const { access_token, refresh_token, expires_at } =
    await chrome.storage.local.get([
      "access_token",
      "refresh_token",
      "expires_at",
    ]);
  if (!access_token) return null;
  if (Date.now() < expires_at - 60000) return access_token;
  return refreshAccessToken(refresh_token);
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    await chrome.storage.local.remove([
      "access_token",
      "refresh_token",
      "expires_at",
    ]);
    throw new Error("Sessão expirada — faça login novamente");
  }
  const tokens = await res.json();
  await saveTokens(tokens);
  return tokens.access_token;
}

function isSpotifyForbidden(error) {
  if (!(error instanceof Error) || !error.message) return false;
  return (
    error.message.startsWith("403 Spotify:") ||
    error.message.startsWith("Spotify error 404:")
  );
}

// ============================================================
// SPOTIFY API
// ============================================================
async function spotifyGet(path) {
  const token = await getAccessToken();
  if (!token) throw new Error("Sem token Spotify (não autenticado)");
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const errorDetails = typeof body === "string" ? body : JSON.stringify(body);
  if (res.status === 401) throw new Error("Token inválido");
  if (res.status === 403) throw new Error(`403 Spotify: ${errorDetails}`);
  if (!res.ok) throw new Error(`Spotify error ${res.status}: ${errorDetails}`);
  return body;
}

async function spotifyPost(path, body) {
  const token = await getAccessToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function fetchCurrentUserProfile() {
  if (currentUserProfile) return currentUserProfile;
  currentUserProfile = await spotifyGet("/me");
  return currentUserProfile;
}

async function fetchUserPlaylists() {
  const user = await fetchCurrentUserProfile();
  const playlists = [];
  let url = "/me/playlists?limit=50";
  while (url) {
    const data = await spotifyGet(
      url.startsWith("/") ? url : url.replace("https://api.spotify.com/v1", ""),
    );
    const visible = data.items.filter(
      (p) => p?.id && (p.owner?.id === user.id || p.collaborative),
    );
    playlists.push(...visible);
    url = data.next
      ? data.next.replace("https://api.spotify.com/v1", "")
      : null;
  }
  return playlists;
}

async function fetchPlaylistTracks(playlistId) {
  const tracks = [];
  let url = `/playlists/${encodeURIComponent(playlistId)}/items?limit=50`;
  while (url) {
    const data = await spotifyGet(url);
    if (!data?.items) break;
    const valid = data.items
      .filter((item) => {
        const t = item?.item ?? item?.track;
        return (
          t?.type === "track" && t.uri && !t.uri.startsWith("spotify:local:")
        );
      })
      .map((item) => {
        const t = item?.item ?? item?.track;
        return {
          uri: t.uri,
          name: t.name,
          artistNames: t.artists?.map((a) => a.name).join(", ") ?? "",
        };
      });
    tracks.push(...valid);
    url = data.next
      ? data.next.replace("https://api.spotify.com/v1", "")
      : null;
  }
  return tracks;
}

async function fetchRecentlyPlayed() {
  try {
    const data = await spotifyGet("/me/player/recently-played?limit=50");
    return new Set(data.items?.map((i) => i.track?.uri).filter(Boolean) ?? []);
  } catch {
    return new Set();
  }
}

async function getPlaybackState() {
  try {
    const token = await getAccessToken();
    const res = await fetch("https://api.spotify.com/v1/me/player", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 204 || !res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function addToQueue(uri) {
  const res = await spotifyPost(
    `/me/player/queue?uri=${encodeURIComponent(uri)}`,
  );
  return res.ok;
}

async function playTrack(uri) {
  await spotifyPost("/me/player/play", { uris: [uri] });
}

// ============================================================
// UTILITÁRIOS DE ALEATORIEDADE
// ============================================================
function fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function applySortOrder(source) {
  const tracks = [...source.tracks];
  if (source.sortOrder === "shuffle") fisherYates(tracks);
  return { ...source, tracks };
}

// ============================================================
// ALGORITMOS DE MISTURA
// ============================================================
function buildInterleavedQueue(sources) {
  const queue = [];
  const pointers = sources.map(() => 0);
  const totals = sources.map((s) => s.tracks.length);
  const n = sources.length;
  let order = fisherYates([...Array(n).keys()]);
  let orderIdx = 0;

  while (pointers.some((p, i) => p < totals[i])) {
    let attempts = 0;
    let si = order[orderIdx % order.length];
    while (pointers[si] >= totals[si] && attempts < n) {
      orderIdx++;
      si = order[orderIdx % order.length];
      attempts++;
    }
    if (pointers[si] >= totals[si]) break;

    const blockSize = Math.floor(Math.random() * 3) + 1;
    const count = Math.min(blockSize, totals[si] - pointers[si]);
    for (let b = 0; b < count; b++) {
      queue.push({
        ...sources[si].tracks[pointers[si]],
        sourceId: sources[si].playlistId,
        sourceName: sources[si].name,
      });
      pointers[si]++;
    }
    orderIdx++;
    if (orderIdx % n === 0) {
      order = fisherYates([...Array(n).keys()]);
      orderIdx = 0;
    }
  }
  return queue;
}

function buildWeightedQueue(sources) {
  const queue = [];
  const pointers = sources.map(() => 0);
  const totals = sources.map((s) => s.tracks.length);
  const n = sources.length;

  while (pointers.some((p, i) => p < totals[i])) {
    const window = [];
    for (let i = 0; i < n; i++) {
      const slots = Math.max(1, Math.round((sources[i].weight || 1) * 3));
      for (let s = 0; s < slots; s++) window.push(i);
    }
    fisherYates(window);
    const deduped = [];
    for (const idx of window) {
      if (!deduped.length || deduped[deduped.length - 1] !== idx)
        deduped.push(idx);
      else {
        const at = Math.max(0, deduped.length - 2);
        deduped.splice(at, 0, idx);
      }
    }
    let addedAny = false;
    for (const si of deduped) {
      if (pointers[si] < totals[si]) {
        queue.push({
          ...sources[si].tracks[pointers[si]],
          sourceId: sources[si].playlistId,
          sourceName: sources[si].name,
        });
        pointers[si]++;
        addedAny = true;
      }
    }
    if (!addedAny) break;
  }
  return queue;
}

function buildShuffleQueue(sources) {
  const MAX_RUN = 3;
  const pool = sources.flatMap((s) =>
    s.tracks.map((t) => ({ ...t, sourceId: s.playlistId, sourceName: s.name })),
  );
  fisherYates(pool);

  for (let i = MAX_RUN; i < pool.length; i++) {
    let run = 1;
    while (run < MAX_RUN && pool[i - run]?.sourceId === pool[i]?.sourceId)
      run++;
    if (run < MAX_RUN) continue;
    const currentSource = pool[i].sourceId;
    let swapIdx = -1;
    for (let j = i + 1; j < pool.length && j < i + 50; j++) {
      if (pool[j].sourceId !== currentSource) {
        swapIdx = j;
        break;
      }
    }
    if (swapIdx !== -1) [pool[i], pool[swapIdx]] = [pool[swapIdx], pool[i]];
  }
  return pool;
}

function buildQueue(sources, mode, recentlyPlayedUris = new Set()) {
  const prepared = sources.map(applySortOrder);

  // Filtra músicas tocadas recentemente se o filtro estiver ativo
  const filtered =
    recentlyPlayedUris.size > 0
      ? prepared.map((s) => ({
          ...s,
          tracks: s.tracks.filter((t) => !recentlyPlayedUris.has(t.uri)),
        }))
      : prepared;

  // Garante que ainda sobrou conteúdo suficiente
  const valid = filtered.filter((s) => s.tracks.length > 0);
  const usedSources = valid.length >= 2 ? valid : prepared; // fallback sem filtro

  switch (mode) {
    case "weighted":
      return buildWeightedQueue(usedSources);
    case "shuffle":
      return buildShuffleQueue(usedSources);
    default:
      return buildInterleavedQueue(usedSources);
  }
}

// ============================================================
// HISTÓRICO DE MISTURAS
// ============================================================
const HISTORY_MAX = 10;

async function saveToHistory(sources, mode, totalTracks) {
  const { djHistory = [] } = await chrome.storage.local.get("djHistory");
  const entry = {
    id: Date.now(),
    startedAt: Date.now(),
    mode,
    totalTracks,
    playlists: sources.map((s) => ({
      id: s.playlistId,
      name: s.name,
      weight: s.weight,
      sortOrder: s.sortOrder,
      trackCount: s.tracks.length,
    })),
  };
  djHistory.unshift(entry);
  if (djHistory.length > HISTORY_MAX) djHistory.length = HISTORY_MAX;
  await chrome.storage.local.set({ djHistory });
}

async function getHistory() {
  const { djHistory = [] } = await chrome.storage.local.get("djHistory");
  return djHistory;
}

// ============================================================
// MOTOR DO DJ
// ============================================================
async function startDJ(sources, mode, filterRecent = false) {
  djState.isRunning = true;
  djState.sources = sources;
  djState.mode = mode;
  djState.queuedCount = 0;
  djState.startedAt = Date.now();

  const recentlyPlayed = filterRecent ? await fetchRecentlyPlayed() : new Set();
  djState.queue = buildQueue(sources, mode, recentlyPlayed);

  if (djState.queue.length > 0) {
    await playTrack(djState.queue[0].uri);
    djState.currentTrackUri = djState.queue[0].uri;
    djState.queuedCount = 1;
  }

  await fillQueue();
  await saveToHistory(sources, mode, djState.queue.length);
  chrome.alarms.create("djMonitor", { periodInMinutes: 0.5 });
  await saveDJState();
}

async function fillQueue(targetCount) {
  if (isFilling) return;
  isFilling = true;
  try {
    const cap =
      targetCount !== undefined
        ? Math.min(targetCount, djState.queuedCount + QUEUE_BUFFER)
        : djState.queuedCount + QUEUE_BUFFER;
    const limit = Math.min(cap, djState.queue.length);
    while (djState.queuedCount < limit) {
      const track = djState.queue[djState.queuedCount];
      if (!track) break;
      await addToQueue(track.uri);
      djState.queuedCount++;
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    isFilling = false;
  }
}

async function stopDJ() {
  djState.isRunning = false;
  djState.queue = [];
  djState.sources = [];
  djState.queuedCount = 0;
  djState.currentTrackUri = null;
  djState.startedAt = null;
  chrome.alarms.clear("djMonitor");
  await chrome.storage.local.remove("djState");
}

async function saveDJState() {
  // Salva só o essencial — queue pode ser grande mas já está compacta (só uri+sourceId+name)
  await chrome.storage.local.set({ djState });
}

async function loadDJState() {
  const { djState: saved } = await chrome.storage.local.get("djState");
  if (saved) djState = saved;
}

// ============================================================
// ALARME — monitora e reabastece a fila
// ============================================================
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "djMonitor") return;
  if (!djState.isRunning) return;

  const playback = await getPlaybackState();
  if (!playback) return;

  const currentUri = playback.item?.uri;
  djState.currentTrackUri = currentUri ?? djState.currentTrackUri;

  const playedIndex = djState.queue.findIndex(
    (t) => t?.uri && t.uri === currentUri,
  );
  if (playedIndex !== -1) {
    const target = playedIndex + 1 + QUEUE_BUFFER;
    if (djState.queuedCount < target) await fillQueue(target);
  }

  await saveDJState();
});

// ============================================================
// PREVIEW DA FILA
// ============================================================
function buildPreview(sources, mode, count = 12) {
  // Gera a queue completa e retorna as primeiras `count` entradas
  const queue = buildQueue(sources, mode);
  return queue.slice(0, count).map((t) => ({
    uri: t.uri,
    name: t.name,
    artistNames: t.artistNames,
    sourceName: t.sourceName,
  }));
}

// ============================================================
// MENSAGENS DO POPUP
// ============================================================
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: getErrorMessage(err) }));
  return true;
});

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Erro inesperado";
}

async function startDJFromSelectedPlaylists(
  selectedPlaylists,
  mode,
  filterRecent,
) {
  const uniquePlaylists = Array.from(
    new Map(selectedPlaylists.map((pl) => [pl.id, pl])).values(),
  );

  const results = await Promise.allSettled(
    uniquePlaylists.map(async (pl) => {
      try {
        const tracks = await fetchPlaylistTracks(pl.id);
        if (!tracks.length)
          return { skipped: true, reason: "empty", playlist: pl };
        return {
          skipped: false,
          playlistId: pl.id,
          name: pl.name,
          weight: pl.weight || 1,
          sortOrder: pl.sortOrder || "original",
          tracks,
        };
      } catch (e) {
        return {
          skipped: true,
          reason: isSpotifyForbidden(e) ? "forbidden" : "error",
          error: getErrorMessage(e),
          playlist: pl,
        };
      }
    }),
  );

  const sources = results
    .filter(
      (r) =>
        r.status === "fulfilled" &&
        r.value &&
        !r.value.skipped &&
        r.value.tracks.length > 0,
    )
    .map((r) => r.value);

  const skippedPlaylists = results
    .filter((r) => r.status === "fulfilled" && r.value?.skipped)
    .map((r) => ({
      id: r.value.playlist.id,
      name: r.value.playlist.name,
      reason: r.value.reason,
      error: r.value.error,
    }));

  if (sources.length < 2) {
    return {
      error:
        "Selecione pelo menos duas playlists acessiveis. O Spotify so permite ler itens de playlists proprias ou colaborativas nessa API.",
      skipped: skippedPlaylists.length,
      skippedPlaylists,
    };
  }

  await startDJ(sources, mode, filterRecent);

  return {
    ok: true,
    totalTracks: djState.queue.length,
    skipped: skippedPlaylists.length,
    skippedPlaylists,
  };
}

async function previewFromSelectedPlaylists(selectedPlaylists, mode) {
  const uniquePlaylists = Array.from(
    new Map(selectedPlaylists.map((pl) => [pl.id, pl])).values(),
  );

  const results = await Promise.allSettled(
    uniquePlaylists.map(async (pl) => {
      try {
        const tracks = await fetchPlaylistTracks(pl.id);
        if (!tracks.length) return null;
        return {
          playlistId: pl.id,
          name: pl.name,
          weight: pl.weight || 1,
          sortOrder: pl.sortOrder || "original",
          tracks,
        };
      } catch {
        return null;
      }
    }),
  );

  const sources = results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);
  if (sources.length < 2)
    return { error: "Playlists insuficientes para preview" };

  const preview = buildPreview(sources, mode);
  return { ok: true, preview };
}

async function handleMessage(message) {
  switch (message.type) {
    case "AUTH_LOGIN":
      await authenticate();
      return { ok: true, auth: getAuthStatus() };

    case "AUTH_LOGOUT":
      await chrome.storage.local.remove([
        "access_token",
        "refresh_token",
        "expires_at",
      ]);
      currentUserProfile = null;
      await stopDJ();
      return { ok: true };

    case "AUTH_STATUS": {
      const token = await getAccessToken().catch(() => null);
      return { loggedIn: !!token };
    }

    case "GET_PLAYLISTS": {
      const playlists = await fetchUserPlaylists();
      return { playlists };
    }

    case "START_DJ": {
      const { selectedPlaylists, mode, filterRecent } = message;
      if (djStartPromise) return djStartPromise;
      djStartPromise = startDJFromSelectedPlaylists(
        selectedPlaylists,
        mode,
        filterRecent,
      ).finally(() => {
        djStartPromise = null;
      });
      return djStartPromise;
    }

    case "PREVIEW_QUEUE": {
      const { selectedPlaylists, mode } = message;
      return previewFromSelectedPlaylists(selectedPlaylists, mode);
    }

    case "STOP_DJ":
      await stopDJ();
      return { ok: true };

    case "DJ_STATUS":
      return {
        isRunning: djState.isRunning,
        mode: djState.mode,
        totalQueued: djState.queuedCount,
        totalTracks: djState.queue.length,
        currentTrackUri: djState.currentTrackUri,
        sources: djState.sources.map((s) => ({
          id: s.playlistId,
          name: s.name,
        })),
        // Música atual + próximas 3 da queue para exibir no painel
        upNext: djState.queue
          .slice(djState.queuedCount, djState.queuedCount + 4)
          .map((t) => ({
            uri: t.uri,
            name: t.name,
            artistNames: t.artistNames,
            sourceName: t.sourceName,
          })),
        nowPlaying:
          djState.queue.find((t) => t.uri === djState.currentTrackUri) ?? null,
      };

    case "GET_HISTORY":
      return { history: await getHistory() };

    case "REPEAT_MIX": {
      // Inicia um fluxo com os dados do histórico diretamente
      const { entry } = message;
      if (!entry?.playlists?.length)
        return { error: "Entrada de histórico inválida" };

      if (djStartPromise) return djStartPromise;
      djStartPromise = startDJFromSelectedPlaylists(
        entry.playlists.map((p) => ({
          id: p.id,
          name: p.name,
          weight: p.weight,
          sortOrder: p.sortOrder,
        })),
        entry.mode,
        false,
      ).finally(() => {
        djStartPromise = null;
      });
      return djStartPromise;
    }

    default:
      return { error: "Mensagem desconhecida" };
  }
}

loadDJState();

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});
