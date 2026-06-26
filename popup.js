// ============================================================
// TEMAS
// ============================================================
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

// ============================================================
// ESTADO DO POPUP
// ============================================================
let allPlaylists = [];
// Map: id → { id, name, weight, sortOrder, ...outros campos }
let selectedPlaylists = new Map();
let currentMode = "interleaved";
let pollingInterval = null;
let startFlowInProgress = false;
let searchQuery = "";

// ============================================================
// UTILITÁRIOS
// ============================================================
function send(type, payload = {}) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage({ type, ...payload }, resolve),
  );
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

function $(id) { return document.getElementById(id); }

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================
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
    showScreen("screen-playing");
    bindPlaying();
    startStatusPolling();
    return;
  }

  showScreen("screen-select");
  bindSelect();
  loadPlaylists();
}

// ============================================================
// TELA: LOGIN
// ============================================================
function bindLogin() {
  $("btn-login").addEventListener("click", async () => {
    $("btn-login").innerHTML =
      '<i class="ti ti-loader" aria-hidden="true"></i> Conectando…';
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

// ============================================================
// TELA: SELECIONAR PLAYLISTS
// ============================================================
function bindSelect() {
  $("btn-logout").addEventListener("click", async () => {
    await send("AUTH_LOGOUT");
    showScreen("screen-login");
    bindLogin();
  });

  document.querySelectorAll(".pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      currentMode = pill.dataset.mode;
      // Dica de peso só no modo proporcional
      const weightHint = $("weight-hint");
      if (weightHint) {
        weightHint.style.display = currentMode === "weighted" ? "block" : "none";
      }
      // Re-renderiza lista para atualizar quais extras aparecem
      if (allPlaylists.length) renderPlaylistList(allPlaylists);
    });
  });

  // Campo de busca
  const searchInput = $("search-playlists");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderPlaylistList(allPlaylists);
    });
  }

  $("btn-start").addEventListener("click", startFlow);
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

/**
 * Quais controles mostrar dependem do modo:
 *   weighted    → Peso (stepper)
 *   interleaved → Ordem (select)
 *   shuffle     → nenhum (tudo vai pro pool global de qualquer forma)
 */
function extrasForMode() {
  if (currentMode === "weighted") return "weight";
  if (currentMode === "interleaved") return "sort";
  return "none";
}

/** Cria o bloco de extras DOM para uma playlist já selecionada */
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
      </div>
    `;
    div.appendChild(label);

    const valEl = label.querySelector(".stepper-value");
    label.querySelector(".stepper-dec").addEventListener("click", (e) => {
      e.stopPropagation();
      const cur = entry.weight ?? 1;
      const next = Math.max(1, cur - 1);
      entry.weight = next;
      selectedPlaylists.set(pl.id, entry);
      valEl.textContent = next;
    });
    label.querySelector(".stepper-inc").addEventListener("click", (e) => {
      e.stopPropagation();
      const cur = entry.weight ?? 1;
      const next = Math.min(10, cur + 1);
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
          <option value="shuffle" ${sortOrder === "shuffle" ? "selected" : ""}>Embaralhar</option>
        </select>
        <span class="sort-caret">▾</span>
      </div>
    `;
    div.appendChild(label);

    label.querySelector(".sort-select").addEventListener("change", (e) => {
      e.stopPropagation();
      entry.sortOrder = e.target.value;
      selectedPlaylists.set(pl.id, entry);
    });
  }

  return div;
}

function renderPlaylistList(playlists) {
  const list = $("playlist-list");

  const filtered = searchQuery
    ? playlists.filter((pl) => pl.name.toLowerCase().includes(searchQuery))
    : playlists;

  if (!filtered.length) {
    list.innerHTML = '<div class="loading-row">Nenhuma playlist encontrada.</div>';
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
    const thumbEl = imgUrl
      ? `<div class="playlist-thumb"><img src="${escapeHtml(imgUrl)}" alt="" /></div>`
      : `<div class="playlist-thumb"><i class="ti ti-music" aria-hidden="true"></i></div>`;

    item.innerHTML = `
      ${thumbEl}
      <div class="playlist-info">
        <div class="playlist-name">${escapeHtml(pl.name)}</div>
        <div class="playlist-tracks">${pl.items?.total ?? pl.tracks?.total ?? "?"} músicas</div>
      </div>
      <div class="playlist-check">
        ${isSelected ? '<i class="ti ti-check" style="font-size:10px"></i>' : ""}
      </div>
    `;

    if (isSelected && sel) {
      const extrasDiv = buildExtrasDiv(pl, sel);
      if (extrasDiv) item.querySelector(".playlist-info").appendChild(extrasDiv);
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
    const extras = item.querySelector(".playlist-extras");
    if (extras) extras.remove();
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
  $("selected-count").textContent = `${count} selecionada${count !== 1 ? "s" : ""}`;
  $("btn-start").disabled = count < 2;
}

async function startFlow() {
  if (startFlowInProgress) return;
  startFlowInProgress = true;

  const btn = $("btn-start");
  btn.innerHTML =
    '<i class="ti ti-loader" aria-hidden="true"></i> Carregando faixas…';
  btn.disabled = true;

  const selected = Array.from(selectedPlaylists.values());

  const res = await send("START_DJ", {
    selectedPlaylists: selected,
    mode: currentMode,
  });

  startFlowInProgress = false;

  if (res?.ok) {
    if (res.skipped > 0) {
      console.warn("Shufflune: playlists puladas:", res.skippedPlaylists || res.skipped);
    }
    showScreen("screen-playing");
    bindPlaying();
    startStatusPolling();
  } else {
    btn.innerHTML = '<i class="ti ti-player-play"></i> Iniciar fluxo';
    btn.disabled = false;
    if (res?.skippedPlaylists?.length) {
      const forbidden = res.skippedPlaylists.find((pl) => pl.reason === "forbidden");
      if (forbidden) {
        alert(
          'Erro ao iniciar: a playlist "' + forbidden.name +
          '" não está acessível para leitura. ' +
          "Verifique se você é proprietário ou colaborador dessa playlist e tente novamente.",
        );
        return;
      }
    }
    alert(
      "Erro ao iniciar: " +
        (res?.error || "verifique se o Spotify está aberto e tocando."),
    );
  }
}

// ============================================================
// RESET DE ESTADO — chamado ao parar o DJ
// ============================================================
function resetSelectState() {
  // Reset completo: seleções, busca, botão
  selectedPlaylists.clear();
  searchQuery = "";
  const searchInput = $("search-playlists");
  if (searchInput) searchInput.value = "";

  // Reset botão iniciar
  const btn = $("btn-start");
  if (btn) {
    btn.innerHTML = '<i class="ti ti-player-play" aria-hidden="true"></i> Iniciar fluxo';
    btn.disabled = true;
  }

  // Reset contador
  const countEl = $("selected-count");
  if (countEl) countEl.textContent = "0 selecionadas";

  // Reset pills de modo
  document.querySelectorAll(".pill").forEach((p) => {
    p.classList.toggle("active", p.dataset.mode === "interleaved");
  });
  currentMode = "interleaved";

  // Limpa polling se ainda ativo
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

// ============================================================
// TELA: DJ RODANDO
// ============================================================
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

function renderActiveSources() {
  const container = $("active-sources-list");
  if (!container) return;
  const names = Array.from(selectedPlaylists.values()).map((pl) => pl.name);
  container.innerHTML = names
    .map(
      (n) => `
    <span class="source-tag">
      <span class="source-dot"></span>
      ${escapeHtml(n)}
    </span>
  `,
    )
    .join("");
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

  const modeLabels = {
    interleaved: "modo intercalado fluído",
    weighted: "modo proporcional",
    shuffle: "modo aleatório",
  };
  if ($("playing-mode"))
    $("playing-mode").textContent = modeLabels[status.mode] || status.mode;
}
