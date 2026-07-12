// TEMAS
const THEMES = [
  { id: "rosegold", label: "Rose Gold", color: "#fbbf24" },
  { id: "midnight", label: "Midnight", color: "#c77dff" },
  { id: "sakura", label: "Sakura", color: "#f9a8d4" },
  { id: "aurora", label: "Aurora", color: "#67e8f9" },
];

function applyTheme(id) {
  document.documentElement.setAttribute("data-theme", id);
  chrome.storage.local.set({ theme: id });
  document
    .querySelectorAll(".theme-dot")
    .forEach((d) => d.classList.toggle("active", d.dataset.theme === id));
}

function buildThemeBar() {
  const bar = document.getElementById("theme-bar");
  if (!bar) return;
  bar.innerHTML = "";
  THEMES.forEach((t) => {
    const dot = document.createElement("button");
    dot.className = "theme-dot";
    dot.dataset.theme = t.id;
    dot.style.background = t.color;
    dot.title = t.label;
    dot.setAttribute("aria-label", `Tema ${t.label}`);
    dot.addEventListener("click", () => applyTheme(t.id));
    bar.appendChild(dot);
  });
}

async function loadSavedTheme() {
  const { theme } = await chrome.storage.local.get("theme");
  applyTheme(theme || "rosegold");
}

// ESTADO DO POPUP
let allPlaylists = [];
let selectedPlaylists = new Map(); // id → { id, name, weight, sortOrder, ... }
let currentMode = "interleaved";
let filterRecent = false;
let pollingInterval = null;
let startFlowInProgress = false;
let searchQuery = "";

// UTILITÁRIOS
function send(type, payload = {}) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage({ type, ...payload }, resolve),
  );
}

function showScreen(id) {
  document
    .querySelectorAll(".screen")
    .forEach((s) => s.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMode(mode) {
  return (
    {
      interleaved: "intercalado",
      weighted: "proporcional",
      shuffle: "aleatório",
    }[mode] ?? mode
  );
}

// INICIALIZAÇÃO
document.addEventListener("DOMContentLoaded", async () => {
  await loadSavedTheme();
  buildThemeBar();
  await init();
});

async function init() {
  const { loggedIn } = await send("AUTH_STATUS");
  if (!loggedIn) {
    showScreen("screen-login");
    bindLogin();
    return;
  }

  const status = await send("DJ_STATUS");
  if (status.isRunning) {
    if (status.sources?.length) {
      status.sources.forEach((s) => {
        if (!selectedPlaylists.has(s.id))
          selectedPlaylists.set(s.id, {
            id: s.id,
            name: s.name,
            weight: 1,
            sortOrder: "original",
          });
      });
    }
    showScreen("screen-playing");
    bindPlaying();
    startStatusPolling();
    return;
  }

  showScreen("screen-select");
  bindSelect();
  loadPlaylists();
}

// TELA: LOGIN
function bindLogin() {
  $("btn-login").addEventListener("click", async () => {
    $("btn-login").innerHTML = '<i class="ti ti-loader"></i> Conectando…';
    $("btn-login").disabled = true;
    const res = await send("AUTH_LOGIN");
    if (res?.ok) {
      await init();
    } else {
      $("btn-login").innerHTML =
        '<i class="ti ti-brand-spotify"></i> Entrar com Spotify';
      $("btn-login").disabled = false;
      alert("Falha no login: " + (res?.error || "tente novamente"));
    }
  });
}

// TELA: SELECIONAR PLAYLISTS
function bindSelect() {
  $("btn-logout").addEventListener("click", async () => {
    await send("AUTH_LOGOUT");
    showScreen("screen-login");
    bindLogin();
  });

  document.querySelectorAll(".pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document
        .querySelectorAll(".pill")
        .forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      currentMode = pill.dataset.mode;
      const weightHint = $("weight-hint");
      if (weightHint)
        weightHint.style.display =
          currentMode === "weighted" ? "block" : "none";
      if (allPlaylists.length) renderPlaylistList(allPlaylists);
    });
  });

  const searchInput = $("search-playlists");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderPlaylistList(allPlaylists);
    });
  }

  // Toggle filtro de recentes
  const filterBtn = $("btn-filter-recent");
  if (filterBtn) {
    filterBtn.addEventListener("click", () => {
      filterRecent = !filterRecent;
      filterBtn.classList.toggle("active", filterRecent);
      filterBtn.title = filterRecent
        ? "Filtro ativo: músicas recentes serão evitadas"
        : "Evitar músicas tocadas recentemente";
    });
  }

  $("btn-start").addEventListener("click", startFlow);

  // Botão de preview
  const previewBtn = $("btn-preview");
  if (previewBtn) previewBtn.addEventListener("click", showPreview);

  // Botão histórico
  const histBtn = $("btn-history");
  if (histBtn) histBtn.addEventListener("click", showHistory);
}

async function loadPlaylists() {
  $("playlist-list").innerHTML =
    '<div class="loading-row">Carregando playlists…</div>';
  const { playlists, error } = await send("GET_PLAYLISTS");
  if (error || !playlists) {
    $("playlist-list").innerHTML =
      '<div class="loading-row">Erro ao carregar playlists.</div>';
    return;
  }
  allPlaylists = playlists;
  renderPlaylistList(playlists);
}

// CONTROLES EXTRAS POR MODO
function extrasForMode() {
  if (currentMode === "weighted") return "weight";
  if (currentMode === "interleaved") return "sort";
  return "none";
}

function buildExtrasDiv(pl, entry) {
  const kind = extrasForMode();
  if (kind === "none") return null;

  const div = document.createElement("div");
  div.className = "playlist-extras";
  div.onclick = (e) => e.stopPropagation();

  if (kind === "weight") {
    const weight = entry.weight ?? 1;
    const label = document.createElement("label");
    label.className = "extra-label";
    label.innerHTML = `
      <span>Peso</span>
      <div class="weight-stepper">
        <button class="stepper-btn stepper-dec" type="button">−</button>
        <span class="stepper-value">${weight}</span>
        <button class="stepper-btn stepper-inc" type="button">+</button>
      </div>`;
    div.appendChild(label);
    const valEl = label.querySelector(".stepper-value");
    label.querySelector(".stepper-dec").addEventListener("click", (e) => {
      e.stopPropagation();
      const next = Math.max(1, (entry.weight ?? 1) - 1);
      entry.weight = next;
      selectedPlaylists.set(pl.id, entry);
      valEl.textContent = next;
    });
    label.querySelector(".stepper-inc").addEventListener("click", (e) => {
      e.stopPropagation();
      const next = Math.min(10, (entry.weight ?? 1) + 1);
      entry.weight = next;
      selectedPlaylists.set(pl.id, entry);
      valEl.textContent = next;
    });
  }

  if (kind === "sort") {
    const sortOrder = entry.sortOrder ?? "original";
    const label = document.createElement("label");
    label.className = "extra-label";
    label.innerHTML = `
      <span>Ordem</span>
      <div class="sort-select-wrap">
        <select class="sort-select">
          <option value="original" ${sortOrder === "original" ? "selected" : ""}>Original</option>
          <option value="shuffle"  ${sortOrder === "shuffle" ? "selected" : ""}>Embaralhar</option>
        </select>
        <span class="sort-caret">▾</span>
      </div>`;
    div.appendChild(label);
    label.querySelector(".sort-select").addEventListener("change", (e) => {
      e.stopPropagation();
      entry.sortOrder = e.target.value;
      selectedPlaylists.set(pl.id, entry);
    });
  }

  return div;
}

// LISTA DE PLAYLISTS
function renderPlaylistList(playlists) {
  const list = $("playlist-list");
  const filtered = searchQuery
    ? playlists.filter((pl) => pl.name.toLowerCase().includes(searchQuery))
    : playlists;

  if (!filtered.length) {
    list.innerHTML =
      '<div class="loading-row">Nenhuma playlist encontrada.</div>';
    return;
  }

  list.innerHTML = "";
  filtered.forEach((pl) => {
    const sel = selectedPlaylists.get(pl.id);
    const isSelected = !!sel;
    const item = document.createElement("div");
    item.className = "playlist-item" + (isSelected ? " selected" : "");
    item.dataset.id = pl.id;

    const imgUrl = pl.images?.[0]?.url;
    const thumbEl = pl._isLiked
      ? `<div class="playlist-thumb playlist-thumb--liked"><i class="ti ti-heart-filled"></i></div>`
      : imgUrl
        ? `<div class="playlist-thumb"><img src="${escapeHtml(imgUrl)}" alt="" /></div>`
        : `<div class="playlist-thumb"><i class="ti ti-music"></i></div>`;

    item.innerHTML = `
      ${thumbEl}
      <div class="playlist-info">
        <div class="playlist-name">${escapeHtml(pl.name)}</div>
        <div class="playlist-tracks">${pl.items?.total ?? pl.tracks?.total ?? "?"} músicas</div>
      </div>
      <div class="playlist-check">${isSelected ? '<i class="ti ti-check" style="font-size:10px"></i>' : ""}</div>`;

    if (isSelected && sel) {
      const extrasDiv = buildExtrasDiv(pl, sel);
      if (extrasDiv)
        item.querySelector(".playlist-info").appendChild(extrasDiv);
    }

    item.addEventListener("click", (e) => {
      if (e.target.closest(".playlist-extras")) return;
      togglePlaylist(pl, item);
    });
    list.appendChild(item);
  });
}

function togglePlaylist(pl, item) {
  if (selectedPlaylists.has(pl.id)) {
    selectedPlaylists.delete(pl.id);
    item.classList.remove("selected");
    item.querySelector(".playlist-check").innerHTML = "";
    item.querySelector(".playlist-extras")?.remove();
  } else {
    const entry = {
      id: pl.id,
      name: pl.name,
      weight: 1,
      sortOrder: "original",
      ownerId: pl.owner?.id,
      collaborative: pl.collaborative,
    };
    selectedPlaylists.set(pl.id, entry);
    item.classList.add("selected");
    item.querySelector(".playlist-check").innerHTML =
      '<i class="ti ti-check" style="font-size:10px"></i>';
    const infoDiv = item.querySelector(".playlist-info");
    if (infoDiv) {
      const extrasDiv = buildExtrasDiv(pl, entry);
      if (extrasDiv) infoDiv.appendChild(extrasDiv);
    }
  }
  const count = selectedPlaylists.size;
  $("selected-count").textContent =
    `${count} selecionada${count !== 1 ? "s" : ""}`;
  $("btn-start").disabled = count < 2;
  if ($("btn-preview")) $("btn-preview").disabled = count < 2;
}

// PREVIEW DA FILA
async function showPreview() {
  const modal = $("modal-preview");
  const body = $("preview-body");
  if (!modal || !body) return;

  body.innerHTML = '<div class="loading-row">Gerando preview…</div>';
  modal.classList.remove("hidden");

  const selected = Array.from(selectedPlaylists.values());
  const res = await send("PREVIEW_QUEUE", {
    selectedPlaylists: selected,
    mode: currentMode,
  });

  if (res?.error || !res?.preview?.length) {
    body.innerHTML =
      '<div class="loading-row">Não foi possível gerar preview.</div>';
    return;
  }

  body.innerHTML = res.preview
    .map(
      (t, i) => `
    <div class="preview-row">
      <span class="preview-num">${i + 1}</span>
      <div class="preview-info">
        <div class="preview-name">${escapeHtml(t.name)}</div>
        <div class="preview-meta">${escapeHtml(t.artistNames)} · <span class="preview-source">${escapeHtml(t.sourceName)}</span></div>
      </div>
    </div>`,
    )
    .join("");

  $("btn-close-preview").onclick = () => modal.classList.add("hidden");
  $("btn-start-from-preview").onclick = () => {
    modal.classList.add("hidden");
    startFlow();
  };
}

// HISTÓRICO DE MISTURAS
async function showHistory() {
  const modal = $("modal-history");
  const body = $("history-body");
  if (!modal || !body) return;

  modal.classList.remove("hidden");
  body.innerHTML = '<div class="loading-row">Carregando…</div>';

  const { history } = await send("GET_HISTORY");

  if (!history?.length) {
    body.innerHTML = '<div class="loading-row">Nenhuma mistura anterior.</div>';
    $("btn-close-history").onclick = () => modal.classList.add("hidden");
    return;
  }

  body.innerHTML = history
    .map((entry) => {
      const date = new Date(entry.startedAt).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const names = entry.playlists.map((p) => escapeHtml(p.name)).join(", ");
      return `
    <div class="history-entry" data-id="${entry.id}">
      <div class="history-meta">
        <span class="history-mode">${escapeHtml(formatMode(entry.mode))}</span>
        <span class="history-date">${date}</span>
      </div>
      <div class="history-playlists">${names}</div>
      <div class="history-stats">${entry.totalTracks} músicas</div>
      <button class="btn-repeat-mix" data-entry='${escapeHtml(JSON.stringify(entry))}'>
        <i class="ti ti-refresh"></i> Repetir
      </button>
    </div>`;
    })
    .join("");

  body.querySelectorAll(".btn-repeat-mix").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const entry = JSON.parse(btn.dataset.entry);
      modal.classList.add("hidden");
      await repeatMix(entry);
    });
  });

  $("btn-close-history").onclick = () => modal.classList.add("hidden");
}

async function repeatMix(entry) {
  const btn = $("btn-start");
  btn.innerHTML = '<i class="ti ti-loader"></i> Repetindo mistura…';
  btn.disabled = true;

  const res = await send("REPEAT_MIX", { entry });
  if (res?.ok) {
    showScreen("screen-playing");
    // Reconstrói selectedPlaylists a partir do histórico
    selectedPlaylists.clear();
    entry.playlists.forEach((p) =>
      selectedPlaylists.set(p.id, {
        id: p.id,
        name: p.name,
        weight: p.weight,
        sortOrder: p.sortOrder,
      }),
    );
    bindPlaying();
    startStatusPolling();
  } else {
    btn.innerHTML = '<i class="ti ti-player-play"></i> Iniciar fluxo';
    btn.disabled = selectedPlaylists.size < 2;
    alert("Erro ao repetir mistura: " + (res?.error || "tente novamente"));
  }
}

// INICIAR FLUXO
async function startFlow() {
  if (startFlowInProgress) return;
  startFlowInProgress = true;
  const btn = $("btn-start");
  btn.innerHTML = '<i class="ti ti-loader"></i> Carregando faixas…';
  btn.disabled = true;

  const selected = Array.from(selectedPlaylists.values());
  const res = await send("START_DJ", {
    selectedPlaylists: selected,
    mode: currentMode,
    filterRecent,
  });
  startFlowInProgress = false;

  if (res?.ok) {
    showScreen("screen-playing");
    bindPlaying();
    startStatusPolling();
  } else {
    btn.innerHTML = '<i class="ti ti-player-play"></i> Iniciar fluxo';
    btn.disabled = false;
    const forbidden = res?.skippedPlaylists?.find(
      (pl) => pl.reason === "forbidden",
    );
    if (forbidden) {
      alert(
        `Erro: a playlist "${forbidden.name}" não é acessível. Verifique se você é dono ou colaborador.`,
      );
    } else {
      alert(
        "Erro ao iniciar: " +
          (res?.error || "verifique se o Spotify está aberto e tocando."),
      );
    }
  }
}

// RESET DE ESTADO
function resetSelectState() {
  selectedPlaylists.clear();
  searchQuery = "";
  filterRecent = false;
  const searchInput = $("search-playlists");
  if (searchInput) searchInput.value = "";
  const btn = $("btn-start");
  if (btn) {
    btn.innerHTML = '<i class="ti ti-player-play"></i> Iniciar fluxo';
    btn.disabled = true;
  }
  const previewBtn = $("btn-preview");
  if (previewBtn) previewBtn.disabled = true;
  const filterBtn = $("btn-filter-recent");
  if (filterBtn) filterBtn.classList.remove("active");
  const countEl = $("selected-count");
  if (countEl) countEl.textContent = "0 selecionadas";
  document
    .querySelectorAll(".pill")
    .forEach((p) =>
      p.classList.toggle("active", p.dataset.mode === "interleaved"),
    );
  currentMode = "interleaved";
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

// TELA: DJ RODANDO
function bindPlaying() {
  const handleStop = async () => {
    await send("STOP_DJ");
    resetSelectState();
    showScreen("screen-select");
    buildThemeBar();
    bindSelect();
    loadPlaylists();
  };
  $("btn-stop").addEventListener("click", handleStop);
  $("btn-new-mix").addEventListener("click", handleStop);
  $("btn-logout-playing").addEventListener("click", async () => {
    await send("AUTH_LOGOUT");
    resetSelectState();
    showScreen("screen-login");
    bindLogin();
  });
  renderActiveSources();
}

function renderActiveSources(sources) {
  const container = $("active-sources-list");
  if (!container) return;
  const items = sources?.length
    ? sources
    : Array.from(selectedPlaylists.values()).map((pl) => ({ name: pl.name }));
  container.innerHTML = items
    .map(
      (s) => `
    <span class="source-tag">
      <span class="source-dot"></span>
      ${escapeHtml(s.name)}
    </span>`,
    )
    .join("");
}

function renderNowPlaying(status) {
  const np = $("now-playing-info");
  if (!np) return;

  // Tenta achar a música atual na queue pelo URI
  const current = status.nowPlaying;
  if (current) {
    np.innerHTML = `
      <div class="np-track">${escapeHtml(current.name)}</div>
      <div class="np-artist">${escapeHtml(current.artistNames ?? "")}</div>
      <div class="np-source">${escapeHtml(current.sourceName ?? "")}</div>`;
  } else {
    np.innerHTML = "";
  }

  // Próximas da fila
  const upNextEl = $("up-next-list");
  if (!upNextEl) return;
  if (status.upNext?.length) {
    upNextEl.innerHTML = status.upNext
      .map(
        (t) => `
      <div class="up-next-row">
        <div class="up-next-name">${escapeHtml(t.name)}</div>
        <div class="up-next-meta">${escapeHtml(t.artistNames ?? "")} · <span class="up-next-source">${escapeHtml(t.sourceName ?? "")}</span></div>
      </div>`,
      )
      .join("");
  } else {
    upNextEl.innerHTML = "";
  }
}

function startStatusPolling() {
  updateDJStatus();
  pollingInterval = setInterval(updateDJStatus, 5000);
}

async function updateDJStatus() {
  const status = await send("DJ_STATUS");
  if (!status?.isRunning) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    return;
  }

  const queued = status.totalQueued || 0;
  const total = status.totalTracks || 0;
  const pct = total > 0 ? Math.round((queued / total) * 100) : 0;

  if ($("queued-count")) $("queued-count").textContent = queued;
  if ($("total-count")) $("total-count").textContent = total;
  if ($("progress-bar")) $("progress-bar").style.width = pct + "%";
  if ($("playing-mode"))
    $("playing-mode").textContent = formatMode(status.mode);

  if (status.sources?.length) {
    status.sources.forEach((s) => {
      if (!selectedPlaylists.has(s.id))
        selectedPlaylists.set(s.id, {
          id: s.id,
          name: s.name,
          weight: 1,
          sortOrder: "original",
        });
    });
    renderActiveSources(status.sources);
  }

  renderNowPlaying(status);
}