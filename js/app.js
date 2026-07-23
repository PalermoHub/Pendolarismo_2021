import { buildIndex, topFlows } from "./flow-index.js";
import { computeMetrics, quantileBreaks, classify, classCounts, topBottom, donutSegments, percentileRanks } from "./coro-index.js";

let flowIndex = null;
let centroidi = null;
let geo = null;
let dataLoaded = false;
let mapLoaded = false;

let popRes = null;
let coroData = null; // { metrics: Map<id,{autocontenimento,saldo,intensita,densita,distanzaCapoluogo}>, ...Breaks (5 classi), ...Breaks3 (tercili), ...Ranks (percentile) }

function fetchJson(path) {
  return fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  });
}

async function loadData() {
  const [flows, centroidiData, geoData, popResData, areaKmqData, distCapoluogoData] = await Promise.all([
    fetchJson("data/flows.json"),
    fetchJson("data/centroidi.json"),
    fetchJson("data/geo.json"),
    fetchJson("data/pop_res_2021.json"),
    fetchJson("data/area_kmq.json"),
    fetchJson("data/dist_capoluogo.json"),
  ]);
  flowIndex = buildIndex(flows);
  centroidi = centroidiData;
  geo = geoData;
  popRes = popResData;
  coroData = buildCoroData(flowIndex.totals, popRes, areaKmqData, distCapoluogoData);
  dataLoaded = true;
  initGeoFilters();
  buildGeoSuggestions();
  tryInitialRender();
  renderAnalisiRegioni();
  applyCoroFeatureState();
}

function buildCoroData(totals, pop, areaKmq, distCapoluogo) {
  const metrics = computeMetrics(totals, pop, areaKmq, distCapoluogo);
  const finite = (key) => [...metrics.values()].map((m) => m[key]).filter((v) => v !== null);
  return {
    metrics,
    autocontBreaks: quantileBreaks(finite("autocontenimento")),
    saldoBreaks: quantileBreaks(finite("saldo")),
    intensitaBreaks: quantileBreaks(finite("intensita")),
    // Tercili (2 breakpoint -> 3 classi basso/medio/alto) per gli assi delle mappe bivariate.
    saldoBreaks3: quantileBreaks(finite("saldo"), 3),
    densitaBreaks3: quantileBreaks(finite("densita"), 3),
    autocontBreaks3: quantileBreaks(finite("autocontenimento"), 3),
    distCapBreaks3: quantileBreaks(finite("distanzaCapoluogo"), 3),
    // Ranghi percentile per punteggiare l'estremità di un comune sui due assi bivariati.
    saldoRanks: percentileRanks(metrics, "saldo"),
    densitaRanks: percentileRanks(metrics, "densita"),
    autocontRanks: percentileRanks(metrics, "autocontenimento"),
    distCapRanks: percentileRanks(metrics, "distanzaCapoluogo"),
  };
}

loadData().catch((err) => {
  document.getElementById("panelEmpty").textContent = `Errore caricamento dati: ${err.message}`;
  console.error(err);
});

const BASE_PADDING = 30;
const panelEl = document.getElementById("panel");
const toolbarEl = document.getElementById("mapToolbar");

if (window.matchMedia("(max-width: 768px)").matches) {
  panelEl.classList.add("collapsed");
  // Set subito, senza aspettare il ResizeObserver: altrimenti --panel-offset
  // resta al default 350px (da :root) e su schermi stretti il tab #panelToggle
  // (right: var(--panel-offset)) nasce con coordinate fuori schermo.
  document.documentElement.style.setProperty("--panel-offset", "0px");
}

function computeMapPadding() {
  const offset = panelEl.classList.contains("collapsed")
    ? 0
    : panelEl.getBoundingClientRect().width;
  // La toolbar è fissa sul bordo sinistro della mappa: senza compensarla nel
  // padding, il centro "vero" (home view) risulta spostato a sinistra dietro
  // di essa, più evidente su mobile dove occupa una fetta maggiore di schermo.
  const toolbarWidth = toolbarEl ? toolbarEl.getBoundingClientRect().width : 0;
  return {
    top: BASE_PADDING,
    bottom: BASE_PADDING,
    left: toolbarWidth + BASE_PADDING,
    right: offset + BASE_PADDING,
  };
}

function setupPanelToggle() {
  const toggle = document.getElementById("panelToggle");
  const mobileBtn = document.getElementById("btnPanelToggleMobile");
  const root = document.documentElement;

  function syncOffset(animate) {
    const padding = computeMapPadding();
    root.style.setProperty("--panel-offset", `${padding.right - BASE_PADDING}px`);
    if (animate) {
      map.easeTo({ padding, duration: 300 });
    } else {
      map.setPadding(padding);
    }
  }

  function syncButtons() {
    const collapsed = panelEl.classList.contains("collapsed");
    toggle.textContent = collapsed ? "▶" : "◀";
    mobileBtn.classList.toggle("active", !collapsed);
  }

  function togglePanel() {
    panelEl.classList.toggle("collapsed");
    syncButtons();
    syncOffset(true);
  }

  syncButtons();
  toggle.addEventListener("click", togglePanel);
  mobileBtn.addEventListener("click", togglePanel);

  new ResizeObserver(() => syncOffset(false)).observe(panelEl);
}

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const PMTILES_URL = "https://gbvitrano.it/anncus/data/comuni.pmtiles";

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      "carto-dark": {
        type: "raster",
        tiles: [
          "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
          "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
          "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
          "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        ],
        tileSize: 256,
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      },
      comuni: {
        type: "vector",
        url: `pmtiles://${PMTILES_URL}`,
        promoteId: { comuni: "pro_com" },
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#0a0a0f" } },
      { id: "carto-dark-layer", type: "raster", source: "carto-dark" },
      {
        id: "comuni-fill",
        type: "fill",
        source: "comuni",
        "source-layer": "comuni",
        paint: { "fill-color": "#000000", "fill-opacity": 0 },
      },
      {
        id: "comuni-selected",
        type: "line",
        source: "comuni",
        "source-layer": "comuni",
        paint: { "line-color": "#3d7fff", "line-width": 2.5 },
        filter: ["==", ["get", "pro_com"], -1],
      },
    ],
  },
  center: [12.41, 40.66],
  zoom: 4.1,
  minZoom: 1,
  maxZoom: 12,
  // Box centrato sulla longitudine dell'Italia (12.41): quando il pan è
  // vincolato ai bordi, MapLibre centra il box nel viewport, non il `center`
  // sopra — un box sbilanciato a est spingeva l'Italia a sinistra.
  maxBounds: [
    [-28, 10],
    [52, 66],
  ],
  hash: true,
  attributionControl: false,
});

map.addControl(new maplibregl.AttributionControl({ compact: true }));

const overlay = new deck.MapboxOverlay({ layers: [] });
map.addControl(overlay);

// Layer di base (archi/nodi della vista corrente) + layer hover, composti insieme:
// l'hover mostra sempre gli archi del comune sotto il mouse, anche a "flussi" spenti.
let currentBaseLayers = [];
let hoveredProCom = null;

function hoverArcsAllowed() {
  return activePanelTab === "flussi" && selectedProCom === null && !showAllFlows && showNodes;
}

function applyLayers() {
  const hoverLayer = hoveredProCom !== null && hoverArcsAllowed() ? buildHoverArcLayer(hoveredProCom) : null;
  overlay.setProps({ layers: hoverLayer ? [...currentBaseLayers, hoverLayer] : currentBaseLayers });
}

function setBaseLayers(layers) {
  currentBaseLayers = layers;
  applyLayers();
}

function buildHoverArcLayer(proCom) {
  const origin = point(proCom);
  if (!origin) return null;
  const arcs = [];
  for (const { other, val } of flowIndex.byOrigin.get(proCom) ?? []) {
    const dest = point(other);
    if (dest) arcs.push({ from: origin, to: dest, val, fromId: proCom, toId: other, kind: "out" });
  }
  for (const { other, val } of flowIndex.byDest.get(proCom) ?? []) {
    const src = point(other);
    if (src) arcs.push({ from: src, to: origin, val, fromId: other, toId: proCom, kind: "in" });
  }
  const maxArcVal = Math.max(1, ...arcs.map((d) => d.val));
  return new deck.ArcLayer({
    id: "hover-arcs",
    data: arcs,
    pickable: false,
    getSourcePosition: (d) => d.from,
    getTargetPosition: (d) => d.to,
    getSourceColor: (d) => (d.kind === "out" ? [255, 68, 0, 220] : [251, 235, 124, 220]),
    getTargetColor: (d) => (d.kind === "out" ? [255, 68, 0, 220] : [251, 235, 124, 220]),
    getWidth: (d) => 1 + 2.5 * Math.sqrt(d.val / maxArcVal),
  });
}

setupPanelToggle();

let selectedProCom = null;
let direction = "both";
let showAllFlows = true;
let showNodes = true;
let showAllComuneLinks = false;

document.getElementById("btnComuneLinks").addEventListener("click", (e) => {
  showAllComuneLinks = !showAllComuneLinks;
  e.currentTarget.classList.toggle("active", showAllComuneLinks);
  if (selectedProCom !== null) renderArcs(selectedProCom);
});

const HOME_VIEW = { center: [12.41, 40.66], zoom: 4.1 };

document.getElementById("btnHome").addEventListener("click", () => {
  map.easeTo({ ...HOME_VIEW, padding: computeMapPadding(), duration: 600 });
});

const fsIconEnter = document.getElementById("fsIconEnter");
const fsIconExit = document.getElementById("fsIconExit");

document.getElementById("btnFullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});

document.addEventListener("fullscreenchange", () => {
  const active = !!document.fullscreenElement;
  fsIconEnter.style.display = active ? "none" : "";
  fsIconExit.style.display = active ? "" : "none";
});

document.getElementById("btnShowNodes").addEventListener("click", (e) => {
  showNodes = !showNodes;
  e.currentTarget.classList.toggle("active", showNodes);
  if (!showNodes && hoveredProCom !== null) hoveredProCom = null;
  updateFlowView();
});

// La legenda funge da filtro per tipo di flusso (uscita/entrata/interno/esterno),
// interconnesso con i filtri a scala regione/provincia/comune: si applica sempre
// allo scope geografico attualmente attivo.
const legendFilters = { out: true, in: true, internal: true, external: true };

document.querySelectorAll("#legend .legend-row[data-kind]").forEach((row) => {
  row.addEventListener("click", () => {
    const kind = row.dataset.kind;
    legendFilters[kind] = !legendFilters[kind];
    row.classList.toggle("off", !legendFilters[kind]);
    updateFlowView();
  });
});

document.querySelectorAll(".dirBtn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    direction = e.currentTarget.dataset.dir;
    document.querySelectorAll(".dirBtn").forEach((b) => b.classList.toggle("active", b === e.currentTarget));
    if (selectedProCom !== null) renderArcs(selectedProCom);
  });
});

document.getElementById("btnShowAllFlows").addEventListener("click", (e) => {
  showAllFlows = !showAllFlows;
  e.currentTarget.classList.toggle("active", showAllFlows);
  if (showAllFlows && hoveredProCom !== null) hoveredProCom = null;
  updateFlowView();
});

function tryInitialRender() {
  if (dataLoaded && mapLoaded) updateFlowView();
}

function resetGeoFilters() {
  filterRegione.value = "";
  populateProvince(null);
  updateChips();
}

const filterRegione = document.getElementById("filterRegione");
const filterProvincia = document.getElementById("filterProvincia");
const filterComune = document.getElementById("filterComune");

function fillSelect(select, options, placeholder) {
  select.innerHTML = `<option value="">${placeholder}</option>` +
    options.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join("");
}

function populateProvince(codReg) {
  const list = geo.province
    .filter((p) => !codReg || p.cod_reg === codReg)
    .sort((a, b) => a.nome.localeCompare(b.nome, "it"));
  fillSelect(filterProvincia, list.map((p) => ({ value: p.cod, label: `${p.nome} (${p.sigla})` })), "Tutte le province");
  filterProvincia.disabled = list.length === 0;
  filterComune.innerHTML = '<option value="">Seleziona comune</option>';
  filterComune.disabled = true;
}

function populateComuni(codProv) {
  const list = Object.entries(geo.comuni)
    .filter(([, g]) => g[1] === codProv)
    .map(([id]) => ({ value: id, label: nomeComune(Number(id)) }))
    .sort((a, b) => a.label.localeCompare(b.label, "it"));
  fillSelect(filterComune, list, "Seleziona comune");
  filterComune.disabled = list.length === 0;
}

function initGeoFilters() {
  const regioni = [...geo.regioni].sort((a, b) => a.nome.localeCompare(b.nome, "it"));
  fillSelect(filterRegione, regioni.map((r) => ({ value: r.cod, label: r.nome })), "Tutte le regioni");
}

filterRegione.addEventListener("change", (e) => {
  const codReg = e.target.value ? Number(e.target.value) : null;
  populateProvince(codReg);
  updateFlowView();
  updateChips();
});

filterProvincia.addEventListener("change", (e) => {
  const codProv = e.target.value ? Number(e.target.value) : null;
  if (codProv) {
    populateComuni(codProv);
  } else {
    filterComune.innerHTML = '<option value="">Seleziona comune</option>';
    filterComune.disabled = true;
  }
  updateFlowView();
  updateChips();
});

filterComune.addEventListener("change", (e) => {
  if (!e.target.value) {
    selectedProCom = null;
    updateFlowView();
    updateChips();
    return;
  }
  const proCom = Number(e.target.value);
  const pos = point(proCom);
  if (!pos) return;
  map.flyTo({ center: pos, zoom: Math.max(map.getZoom(), 10) });
  onComuneClick(proCom, nomeComune(proCom), pos);
  updateChips();
});

// Scope attivo determinato dai select: comune > provincia > regione > vista globale (toggle).
function currentScope() {
  if (filterComune.value) return { type: "comune", id: Number(filterComune.value) };
  if (filterProvincia.value) return { type: "provincia", id: Number(filterProvincia.value) };
  if (filterRegione.value) return { type: "regione", id: Number(filterRegione.value) };
  return { type: "all" };
}

// ── Barra di ricerca intelligente (regione/provincia/comune) ───────────
const geoSearchInput   = document.getElementById("geoSearchInput");
const geoSearchClear   = document.getElementById("geoSearchClear");
const geoSearchDD      = document.getElementById("geoSearchDD");
const geoChips         = document.getElementById("geoChips");
const geoFilterBtn     = document.getElementById("geoFilterBtn");
const geoFilterBadge   = document.getElementById("geoFilterBadge");
const geoFilterOverlay = document.getElementById("geoFilterOverlay");
const geoFilterModal   = document.getElementById("geoFilterModal");
const geoModalClose    = document.getElementById("geoModalClose");
const geoModalReset    = document.getElementById("geoModalReset");
const geoModalApply    = document.getElementById("geoModalApply");

const GEO_TYPE_LABELS = { regione: "Regione", provincia: "Provincia", comune: "Comune" };
let GEO_SUGGESTIONS = [];

function buildGeoSuggestions() {
  const items = [];
  for (const r of geo.regioni) {
    items.push({ type: "regione", label: r.nome, value: r.cod });
  }
  for (const p of geo.province) {
    const rNome = geo.regioni.find((r) => r.cod === p.cod_reg)?.nome ?? "";
    items.push({ type: "provincia", label: `${p.nome} (${p.sigla})`, sub: rNome, value: p.cod, regCod: p.cod_reg });
  }
  for (const [id, [codReg, codProv]] of Object.entries(geo.comuni)) {
    items.push({ type: "comune", label: nomeComune(Number(id)), value: Number(id), regCod: codReg, provCod: codProv });
  }
  GEO_SUGGESTIONS = items;
}

function geoHighlight(text, query) {
  const safe = esc(text);
  if (!query) return safe;
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return safe.replace(re, "<mark>$1</mark>");
}

function renderGeoDD(query) {
  const q = query.trim().toLowerCase();
  const matches = q.length === 0 ? [] : GEO_SUGGESTIONS
    .filter((s) => s.label.toLowerCase().includes(q))
    .sort((a, b) => a.label.toLowerCase().indexOf(q) - b.label.toLowerCase().indexOf(q))
    .slice(0, 12);

  if (matches.length === 0) {
    geoSearchDD.innerHTML = q.length > 0
      ? `<div class="geo-dd-empty">Nessun risultato per &ldquo;${esc(q)}&rdquo;</div>`
      : "";
    geoSearchDD.classList.toggle("open", q.length > 0);
    return;
  }

  let html = "";
  let lastType = null;
  matches.forEach((m, i) => {
    if (m.type !== lastType) {
      html += `<div class="geo-dd-cat">${GEO_TYPE_LABELS[m.type]}</div>`;
      lastType = m.type;
    }
    html += `<div class="geo-dd-item" data-idx="${i}">
               <span>${geoHighlight(m.label, query.trim())}${m.sub ? ` <span style="color:#999">· ${esc(m.sub)}</span>` : ""}</span>
               <span class="geo-dd-badge">${esc(GEO_TYPE_LABELS[m.type])}</span>
             </div>`;
  });
  geoSearchDD.innerHTML = html;
  geoSearchDD.classList.add("open");

  geoSearchDD.querySelectorAll(".geo-dd-item").forEach((el, i) => {
    el.addEventListener("click", () => selectGeoSuggestion(matches[i]));
  });
}

function selectGeoSuggestion(item) {
  if (item.type === "regione") {
    filterRegione.value = String(item.value);
    filterRegione.dispatchEvent(new Event("change"));
  } else if (item.type === "provincia") {
    filterRegione.value = String(item.regCod);
    filterRegione.dispatchEvent(new Event("change"));
    filterProvincia.value = String(item.value);
    filterProvincia.dispatchEvent(new Event("change"));
  } else if (item.type === "comune") {
    filterRegione.value = String(item.regCod);
    filterRegione.dispatchEvent(new Event("change"));
    filterProvincia.value = String(item.provCod);
    filterProvincia.dispatchEvent(new Event("change"));
    filterComune.value = String(item.value);
    filterComune.dispatchEvent(new Event("change"));
  }
  geoSearchInput.value = "";
  geoSearchClear.style.display = "none";
  geoSearchDD.classList.remove("open");
}

function updateChips() {
  const active = [];
  if (filterRegione.value) {
    const r = geo.regioni.find((x) => x.cod === Number(filterRegione.value));
    active.push({ label: r ? r.nome : filterRegione.value, clear: "regione" });
  }
  if (filterProvincia.value) {
    const p = geo.province.find((x) => x.cod === Number(filterProvincia.value));
    active.push({ label: p ? `${p.nome} (${p.sigla})` : filterProvincia.value, clear: "provincia" });
  }
  if (filterComune.value) {
    active.push({ label: nomeComune(Number(filterComune.value)), clear: "comune" });
  }

  geoChips.style.display = active.length ? "flex" : "none";
  geoFilterBadge.style.display = active.length ? "flex" : "none";
  geoFilterBadge.textContent = active.length;
  geoFilterBtn.classList.toggle("active", active.length > 0);

  let html = active
    .map((f) => `<span class="geo-chip">${esc(f.label)}<button class="geo-chip-close" data-clear="${esc(f.clear)}">✕</button></span>`)
    .join("");
  if (active.length > 1) {
    html += `<button class="geo-chip geo-chip-resetall" id="geoChipsResetAll">✕ tutti</button>`;
  }
  geoChips.innerHTML = html;

  geoChips.querySelectorAll(".geo-chip-close").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = btn.dataset.clear;
      if (c === "regione") { filterRegione.value = ""; filterRegione.dispatchEvent(new Event("change")); }
      if (c === "provincia") { filterProvincia.value = ""; filterProvincia.dispatchEvent(new Event("change")); }
      if (c === "comune") { filterComune.value = ""; filterComune.dispatchEvent(new Event("change")); }
    });
  });
  const ra = document.getElementById("geoChipsResetAll");
  if (ra) ra.addEventListener("click", () => {
    filterRegione.value = "";
    filterRegione.dispatchEvent(new Event("change"));
  });
}

geoSearchInput.addEventListener("input", () => {
  geoSearchClear.style.display = geoSearchInput.value ? "" : "none";
  renderGeoDD(geoSearchInput.value);
});
geoSearchClear.addEventListener("click", () => {
  geoSearchInput.value = "";
  geoSearchClear.style.display = "none";
  geoSearchDD.classList.remove("open");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#geoSearchbar")) geoSearchDD.classList.remove("open");
});

function closeGeoFilterModal() {
  geoFilterModal.classList.remove("open");
  geoFilterOverlay.classList.remove("open");
}
geoFilterBtn.addEventListener("click", () => {
  geoFilterModal.classList.add("open");
  geoFilterOverlay.classList.add("open");
});
geoModalClose.addEventListener("click", closeGeoFilterModal);
geoFilterOverlay.addEventListener("click", closeGeoFilterModal);
geoModalReset.addEventListener("click", () => {
  filterRegione.value = "";
  filterRegione.dispatchEvent(new Event("change"));
  closeGeoFilterModal();
});
geoModalApply.addEventListener("click", closeGeoFilterModal);

function comuniInRegione(codReg) {
  return Object.entries(geo.comuni).filter(([, g]) => g[0] === codReg).map(([id]) => Number(id));
}

function comuniInProvincia(codProv) {
  return Object.entries(geo.comuni).filter(([, g]) => g[1] === codProv).map(([id]) => Number(id));
}

function updateFlowView() {
  const scope = currentScope();
  if (scope.type === "comune") {
    selectedProCom = scope.id;
    map.setFilter("comuni-selected", ["==", ["get", "pro_com"], scope.id]);
    renderArcs(scope.id);
    renderPanel(scope.id, nomeComune(scope.id));
    return;
  }
  if (scope.type === "provincia") {
    const ids = comuniInProvincia(scope.id);
    map.setFilter("comuni-selected", ["in", ["get", "pro_com"], ["literal", ids]]);
    renderScopeFlows(ids, 1);
    const p = geo.province.find((x) => x.cod === scope.id);
    renderScopePanel(ids, p ? `Provincia di ${p.nome}` : "Provincia", "provincia");
    return;
  }
  if (scope.type === "regione") {
    const ids = comuniInRegione(scope.id);
    map.setFilter("comuni-selected", ["in", ["get", "pro_com"], ["literal", ids]]);
    renderScopeFlows(ids, 10);
    const r = geo.regioni.find((x) => x.cod === scope.id);
    renderScopePanel(ids, r ? `Regione ${r.nome}` : "Regione", "regione");
    return;
  }
  // nessun filtro geografico: torna alla vista globale/toggle
  map.setFilter("comuni-selected", ["==", ["get", "pro_com"], -1]);
  const hint = `<h2 id="panelTitle">Pendolarismo 2021</h2><p id="panelSubtitle">Matrice di pendolarismo per lavoro - istat.it</p>`;
  renderAllFlows();
  document.getElementById("panelBody").innerHTML = `
    ${hint}
    ${nationalStatsHtml()}
    <h3>Saldo pendolari per regione (entrata − uscita)</h3>
    <p class="hint">Positivo = regione attrattiva (più occupati in entrata); negativo = regione che esporta forza lavoro.</p>
    ${divergingHtml(saldoPerRegione(), nomeRegione)}
  `;
}

// Stesse card statTiles/numRow del pannello comune/area, aggregate su tutta Italia.
function nationalStatsHtml() {
  let self = 0, out = 0, inn = 0;
  for (const t of flowIndex.totals.values()) {
    self += t.self;
    out += t.out;
    inn += t.in;
  }
  const totResidenti = self + out;
  const totPostiLavoro = self + inn;
  const saldo = inn - out;
  return statBlockHtml(
    [
      { val: pct(self, totResidenti), label: "Vive e lavora nello stesso comune" },
      { val: pct(out, totResidenti), label: "Pendola verso un altro comune" },
      { val: pct(inn, totPostiLavoro), label: "Posti coperti da pendolari" },
    ],
    [
      { val: fmt(totResidenti), label: "Popolazione attiva" },
      { val: fmt(totPostiLavoro), label: "Posti di lavoro" },
      { val: `${saldo >= 0 ? "+" : ""}${fmt(saldo)}`, label: "Saldo netto", cls: saldo >= 0 ? "pos" : "neg" },
    ]
  );
}

// Righe { id, saldo } → barra divergente (blu = entrata netta, arancio = uscita netta).
function divergingHtml(list, labelFn) {
  const maxAbs = Math.max(1, ...list.map((d) => Math.abs(d.saldo)));
  return list
    .map((d) => {
      const width = ((Math.abs(d.saldo) / maxAbs) * 50).toFixed(1);
      const cls = d.saldo >= 0 ? "pos" : "neg";
      const side = d.saldo >= 0 ? `left:50%;width:${width}%` : `right:50%;width:${width}%`;
      return `<div class="dest">
        <div class="top"><span>${esc(labelFn(d.id))}</span><span class="pct">${d.saldo >= 0 ? "+" : ""}${fmt(d.saldo)}</span></div>
        <div class="divbar"><i class="${cls}" style="${side}"></i></div>
      </div>`;
    })
    .join("");
}

function nomeRegione(cod) {
  return geo.regioni.find((r) => r.cod === cod)?.nome ?? String(cod);
}

// Saldo pendolari (entrata - uscita) aggregato per regione, su tutti i flussi interregionali.
function saldoPerRegione() {
  const acc = new Map();
  const ensure = (id) => {
    if (!acc.has(id)) acc.set(id, { out: 0, in: 0 });
    return acc.get(id);
  };
  for (const [res, edges] of flowIndex.byOrigin) {
    const rReg = geo.comuni[res]?.[0];
    if (rReg == null) continue;
    for (const { other, val } of edges) {
      const oReg = geo.comuni[other]?.[0];
      if (oReg == null || oReg === rReg) continue;
      ensure(rReg).out += val;
      ensure(oReg).in += val;
    }
  }
  return [...acc.entries()]
    .map(([id, v]) => ({ id, saldo: v.in - v.out }))
    .sort((a, b) => b.saldo - a.saldo);
}

// Residenti occupati + flussi interregionali (in/out/saldo) per regione, per la tab Analisi.
function analisiPerRegione() {
  const acc = new Map();
  const ensure = (id) => {
    if (!acc.has(id)) acc.set(id, { residenti: 0, out: 0, in: 0 });
    return acc.get(id);
  };
  for (const [idStr, reg] of Object.entries(geo.comuni)) {
    const t = flowIndex.totals.get(Number(idStr));
    if (t) ensure(reg[0]).residenti += t.self + t.out;
  }
  for (const [res, edges] of flowIndex.byOrigin) {
    const rReg = geo.comuni[res]?.[0];
    if (rReg == null) continue;
    for (const { other, val } of edges) {
      const oReg = geo.comuni[other]?.[0];
      if (oReg == null || oReg === rReg) continue;
      ensure(rReg).out += val;
      ensure(oReg).in += val;
    }
  }
  return [...acc.entries()].map(([id, v]) => ({
    id,
    residenti: v.residenti,
    in: v.in,
    out: v.out,
    saldo: v.in - v.out,
  }));
}

function renderAnalisiRegioni() {
  const tableEl = document.getElementById("analisiRegioniTable");
  const chartEl = document.getElementById("analisiRegioniChart");
  if (!tableEl && !chartEl) return;

  const rows = analisiPerRegione();

  if (tableEl) {
    const body = [...rows]
      .sort((a, b) => b.residenti - a.residenti)
      .map((r) => {
        const cls = r.saldo >= 0 ? "pos" : "neg";
        return `<tr>
          <td>${esc(nomeRegione(r.id))}</td>
          <td>${fmt(r.residenti)}</td>
          <td>${fmt(r.in)}</td>
          <td>${fmt(r.out)}</td>
          <td class="${cls}">${r.saldo >= 0 ? "+" : ""}${fmt(r.saldo)}</td>
        </tr>`;
      })
      .join("");
    tableEl.innerHTML = `<table class="analisi-table">
      <thead><tr><th>Regione</th><th>Residenti occupati</th><th>Entrata</th><th>Uscita</th><th>Saldo</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  if (chartEl) {
    const chartRows = [...rows].sort((a, b) => b.saldo - a.saldo);
    chartEl.innerHTML = divergingHtml(chartRows, nomeRegione);
  }
}

function renderScopePanel(ids, title, scopeType) {
  const idSet = new Set(ids);
  let self = 0, internal = 0, externalOut = 0, externalIn = 0;
  const perComune = new Map(); // id -> { out, in } (solo flussi verso/da fuori area)

  for (const id of idSet) {
    self += (flowIndex.totals.get(id) ?? { self: 0 }).self;
    let cOut = 0, cIn = 0;
    for (const { other, val } of flowIndex.byOrigin.get(id) ?? []) {
      if (idSet.has(other)) internal += val;
      else { externalOut += val; cOut += val; }
    }
    for (const { other, val } of flowIndex.byDest.get(id) ?? []) {
      if (!idSet.has(other)) { externalIn += val; cIn += val; }
    }
    perComune.set(id, { out: cOut, in: cIn });
  }

  const ranking = (key) =>
    [...perComune.entries()]
      .filter(([, v]) => v[key] > 0)
      .sort((a, b) => b[1][key] - a[1][key])
      .slice(0, 10);

  const rankingHtml = (list, total, key, kindClass) =>
    list
      .map(([id, v]) => {
        const val = v[key];
        const share = total > 0 ? (val / total) * 100 : 0;
        return `<div class="dest">
          <div class="top"><span>${esc(nomeComune(id))}</span><span class="pct">${fmt(val)} (${pct(val, total)})</span></div>
          <div class="bar"><i class="${kindClass}" style="width:${share.toFixed(1)}%"></i></div>
        </div>`;
      })
      .join("");

  const saldoRanking = () =>
    [...perComune.entries()]
      .map(([id, v]) => ({ id, saldo: v.in - v.out }))
      .filter((d) => d.saldo !== 0)
      .sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo))
      .slice(0, 10)
      .sort((a, b) => b.saldo - a.saldo);

  const altre = scopeType === "regione" ? "altre regioni" : "altre province";
  const totResidentiArea = self + internal + externalOut;
  const totPostiLavoroArea = self + internal + externalIn;
  const saldoArea = externalIn - externalOut;
  const statsHtml = statBlockHtml(
    [
      { val: pct(self + internal, totResidentiArea), label: "Vive e lavora nell'area" },
      { val: pct(externalOut, totResidentiArea), label: `Esce verso ${altre}` },
      { val: pct(externalIn, totPostiLavoroArea), label: "Posti coperti da fuori area" },
    ],
    [
      { val: fmt(totResidentiArea), label: "Popolazione attiva" },
      { val: fmt(totPostiLavoroArea), label: "Posti di lavoro" },
      { val: `${saldoArea >= 0 ? "+" : ""}${fmt(saldoArea)}`, label: "Saldo netto", cls: saldoArea >= 0 ? "pos" : "neg" },
    ]
  );
  document.getElementById("panelBody").innerHTML = `
    <h2>${esc(title)}</h2>
    <p>Comuni inclusi: ${fmt(idSet.size)}</p>
    ${statsHtml}
    <h3>Saldo pendolari (entrata − uscita verso ${altre})</h3>
    <p class="hint">Positivo = polo lavoro (attrae); negativo = polo residenziale (esporta forza lavoro).</p>
    ${divergingHtml(saldoRanking(), nomeComune)}
    <h3>Classifica comuni per uscita verso ${altre}</h3>
    ${rankingHtml(ranking("out"), externalOut, "out", "out")}
    <h3>Classifica comuni per entrata da ${altre}</h3>
    ${rankingHtml(ranking("in"), externalIn, "in", "in")}
  `;
}

// Archi verso/da/dentro un insieme di comuni (regione o provincia): "out" lascia
// l'area, "in" arriva da fuori, "internal" resta tra comuni dell'area.
function renderScopeFlows(ids, minVal) {
  const idSet = new Set(ids);
  const arcsMap = new Map();
  for (const id of idSet) {
    for (const { other, val } of flowIndex.byOrigin.get(id) ?? []) {
      if (val < minVal) continue;
      arcsMap.set(`${id}>${other}`, { fromId: id, toId: other, val });
    }
    for (const { other, val } of flowIndex.byDest.get(id) ?? []) {
      if (val < minVal) continue;
      arcsMap.set(`${other}>${id}`, { fromId: other, toId: id, val });
    }
  }

  const arcs = [];
  const nodes = new Map();
  for (const { fromId, toId, val } of arcsMap.values()) {
    const from = point(fromId);
    const to = point(toId);
    if (!from || !to) continue;
    const kind = idSet.has(fromId) && idSet.has(toId) ? "internal" : idSet.has(fromId) ? "out" : "in";
    if (!legendFilters[kind]) continue;
    arcs.push({ from, to, val, kind, fromId, toId });
    if (legendFilters.external) {
      if (!idSet.has(fromId)) nodes.set(fromId, { position: from, kind: "external" });
      if (!idSet.has(toId)) nodes.set(toId, { position: to, kind: "external" });
    }
  }

  const maxArcVal = Math.max(1, ...arcs.map((d) => d.val));
  const scopeNodes = [...idSet]
    .map((id) => {
      const pos = point(id);
      const t = flowIndex.totals.get(id) ?? { out: 0, in: 0, self: 0 };
      return pos ? { id, position: pos, radius: bubbleRadius(bubbleValue(id, "out")), saldo: t.in - t.out } : null;
    })
    .filter(Boolean);
  const scopeMaxAbsSaldo = Math.max(1, ...scopeNodes.map((d) => Math.abs(d.saldo)));
  const externalNodes = [...nodes.values()];

  const arcColor = (kind) => (kind === "out" ? [255, 68, 0] : kind === "in" ? [251, 235, 124] : [0, 0, 221]);

  setBaseLayers([
      new deck.ArcLayer({
        id: "flows-scope",
        data: arcs,
        pickable: true,
        visible: showAllFlows,
        getSourcePosition: (d) => d.from,
        getTargetPosition: (d) => d.to,
        getSourceColor: (d) => arcColor(d.kind),
        getTargetColor: (d) => arcColor(d.kind),
        getWidth: (d) => 0.75 + 2.5 * Math.sqrt(d.val / maxArcVal),
        onClick: (info) => {
          if (!info.object) return false;
          const d = info.object;
          showPopup(info.coordinate, `
            <strong>${esc(nomeComune(d.fromId))} &rarr; ${esc(nomeComune(d.toId))}</strong>
            <p>Pendolari: ${fmt(d.val)}</p>
          `);
          return true;
        },
      }),
      new deck.ScatterplotLayer({
        id: "nodes-scope",
        data: scopeNodes,
        pickable: true,
        visible: showNodes,
        getPosition: (d) => d.position,
        getRadius: (d) => d.radius,
        getFillColor: (d) => saldoColor(d.saldo, scopeMaxAbsSaldo),
        stroked: false,
        radiusUnits: "pixels",
        onClick: (info) => {
          if (!info.object) return false;
          const d = info.object;
          showPopup(info.coordinate, `<strong>${esc(nomeComune(d.id))}</strong><p>Saldo: ${d.saldo >= 0 ? "+" : ""}${fmt(d.saldo)}</p>`);
          return true;
        },
      }),
      new deck.ScatterplotLayer({
        id: "nodes-scope-external",
        data: externalNodes,
        visible: showNodes,
        getPosition: (d) => d.position,
        getRadius: 3,
        getFillColor: [180, 180, 180, 180],
        stroked: false,
        radiusUnits: "pixels",
      }),
  ]);
}

function syncFiltersToComune(proCom) {
  const g = geo.comuni[proCom];
  if (!g) return;
  const [codReg, codProv] = g;
  if (Number(filterRegione.value) !== codReg) {
    filterRegione.value = String(codReg);
    populateProvince(codReg);
  }
  if (Number(filterProvincia.value) !== codProv) {
    filterProvincia.value = String(codProv);
    populateComuni(codProv);
  }
  filterComune.value = String(proCom);
  updateChips();
}

function point(id) {
  const c = centroidi[id] ?? centroidi[String(id)];
  return c ? [c.lon, c.lat] : null;
}

function nomeComune(id) {
  const c = centroidi[id] ?? centroidi[String(id)];
  return c ? c.nome : String(id);
}

// Dimensione bubble in pixel, indipendente dalla selezione corrente: si basa sulla
// grandezza "propria" del comune (popolazione attiva o posti di lavoro), come nel
// sito di riferimento (nodeRadius: sizeScale * (1.5 + sqrt(v) / radiusPx)).
const BUBBLE_RADIUS_PX = 40;

function bubbleValue(proComId, kind) {
  const t = flowIndex.totals.get(proComId) ?? { out: 0, in: 0, self: 0 };
  // out: popolazione attiva residente (esce + resta); in: posti di lavoro (entra + resta)
  return kind === "in" ? t.in + t.self : t.out + t.self;
}

function bubbleRadius(v) {
  return 1.5 + Math.sqrt(Math.max(v, 1)) / BUBBLE_RADIUS_PX;
}

// Saldo pendolari del comune: positivo = polo lavoro (entrano più occupati di quanti
// residenti escono), negativo = polo residenziale (escono più residenti di quanti occupati entrano).
// Stessa logica/palette del bar divergente (blu #3d7fff pos, arancio #ff4400 neg).
function saldoValue(proComId) {
  const t = flowIndex.totals.get(proComId) ?? { out: 0, in: 0, self: 0 };
  return t.in - t.out;
}

function saldoColor(saldo, maxAbs) {
  const t = maxAbs > 0 ? Math.min(1, Math.abs(saldo) / maxAbs) : 0;
  const alpha = Math.round(90 + t * 140);
  return saldo >= 0 ? [61, 127, 255, alpha] : [255, 68, 0, alpha];
}

function renderArcs(proCom) {
  const origin = point(proCom);
  if (!origin) return;

  const totals = flowIndex.totals.get(proCom) ?? { out: 0, in: 0, self: 0 };
  const arcs = [];
  const nodes = new Map(); // pro_com altro -> { position, kind }
  const linkOpts = showAllComuneLinks ? { minShare: 0, max: Infinity } : {};

  if (direction === "out" || direction === "both") {
    const list = topFlows(flowIndex.byOrigin.get(proCom) ?? [], { totalForShare: totals.out || 1, ...linkOpts });
    for (const { other, val } of list) {
      const dest = point(other);
      if (dest) {
        arcs.push({ from: origin, to: dest, val, kind: "out", fromId: proCom, toId: other });
        nodes.set(other, { position: dest, kind: "out" });
      }
    }
  }
  if (direction === "in" || direction === "both") {
    const list = topFlows(flowIndex.byDest.get(proCom) ?? [], { totalForShare: totals.in || 1, ...linkOpts });
    for (const { other, val } of list) {
      const src = point(other);
      if (src) {
        arcs.push({ from: src, to: origin, val, kind: "in", fromId: other, toId: proCom });
        const existing = nodes.get(other);
        nodes.set(other, { position: src, kind: existing ? "both" : "in" });
      }
    }
  }

  const visibleArcs = arcs.filter((d) => legendFilters[d.kind]);
  const maxArcVal = Math.max(1, ...visibleArcs.map((d) => d.val));
  const nodeList = [...nodes.entries()]
    .filter(([, d]) => legendFilters[d.kind === "both" ? "internal" : d.kind])
    .map(([proComOther, d]) => ({
      ...d,
      radius: bubbleRadius(bubbleValue(proComOther, d.kind === "both" ? "out" : d.kind)),
    }));

  setBaseLayers([
      new deck.ArcLayer({
        id: "flows",
        data: visibleArcs,
        pickable: true,
        visible: showAllFlows,
        getSourcePosition: (d) => d.from,
        getTargetPosition: (d) => d.to,
        getSourceColor: (d) => (d.kind === "out" ? [255, 68, 0] : [251, 235, 124]),
        getTargetColor: (d) => (d.kind === "out" ? [255, 68, 0] : [251, 235, 124]),
        getWidth: (d) => 1 + 2.5 * Math.sqrt(d.val / maxArcVal),
        onClick: (info) => {
          if (!info.object) return false;
          const d = info.object;
          showPopup(info.coordinate, `
            <strong>${esc(nomeComune(d.fromId))} &rarr; ${esc(nomeComune(d.toId))}</strong>
            <p>Pendolari: ${fmt(d.val)}</p>
          `);
          return true;
        },
      }),
      new deck.ScatterplotLayer({
        id: "nodes",
        data: nodeList,
        pickable: true,
        visible: showNodes,
        getPosition: (d) => d.position,
        getRadius: (d) => d.radius,
        getFillColor: (d) => (d.kind === "out" ? [255, 68, 0, 180] : d.kind === "in" ? [251, 235, 124, 180] : [0, 0, 221, 180]),
        stroked: false,
        radiusUnits: "pixels",
      }),
      new deck.ScatterplotLayer({
        id: "origin-node",
        data: [{ position: origin, radius: bubbleRadius(bubbleValue(proCom, "out")) }],
        visible: showNodes,
        getPosition: (d) => d.position,
        getRadius: (d) => Math.max(d.radius, 4),
        getFillColor: [61, 127, 255, 180],
        stroked: false,
        radiusUnits: "pixels",
      }),
  ]);
}

// Con ~524k coppie comune-comune, mostrare tutti i collegamenti richiede una
// soglia minima altrimenti la mappa diventa illeggibile e il frame rate crolla.
const ALL_FLOWS_MIN_VAL = 50;

function renderAllFlows() {
  const arcs = [];
  for (const [res, list] of flowIndex.byOrigin) {
    const origin = point(res);
    if (!origin) continue;
    for (const { other, val } of list) {
      if (val < ALL_FLOWS_MIN_VAL) continue;
      const dest = point(other);
      if (!dest) continue;
      arcs.push({ from: origin, to: dest, val, fromId: res, toId: other });
    }
  }

  const maxArcVal = Math.max(1, ...arcs.map((d) => d.val));
  const nodeList = [...flowIndex.totals.entries()]
    .map(([id, t]) => {
      const pos = point(id);
      return pos ? { id, position: pos, radius: bubbleRadius(bubbleValue(id, "out")), saldo: t.in - t.out } : null;
    })
    .filter(Boolean);
  const maxAbsSaldo = Math.max(1, ...nodeList.map((d) => Math.abs(d.saldo)));

  setBaseLayers([
      new deck.ArcLayer({
        id: "flows-all",
        data: arcs,
        pickable: true,
        visible: showAllFlows,
        getSourcePosition: (d) => d.from,
        getTargetPosition: (d) => d.to,
        getSourceColor: [255, 68, 0, 110],
        getTargetColor: [251, 235, 124, 110],
        getWidth: (d) => 0.5 + 2 * Math.sqrt(d.val / maxArcVal),
        onClick: (info) => {
          if (!info.object) return false;
          const d = info.object;
          showPopup(info.coordinate, `
            <strong>${esc(nomeComune(d.fromId))} &rarr; ${esc(nomeComune(d.toId))}</strong>
            <p>Pendolari: ${fmt(d.val)}</p>
          `);
          return true;
        },
      }),
      new deck.ScatterplotLayer({
        id: "nodes-all",
        data: nodeList,
        pickable: true,
        visible: showNodes,
        getPosition: (d) => d.position,
        getRadius: (d) => d.radius,
        getFillColor: (d) => saldoColor(d.saldo, maxAbsSaldo),
        stroked: false,
        radiusUnits: "pixels",
        onClick: (info) => {
          if (!info.object) return false;
          const d = info.object;
          showPopup(info.coordinate, `<strong>${esc(nomeComune(d.id))}</strong><p>Saldo: ${d.saldo >= 0 ? "+" : ""}${fmt(d.saldo)}</p>`);
          return true;
        },
      }),
  ]);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function fmt(n) {
  return n.toLocaleString("it-IT");
}

function pct(n, total) {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0%";
}

// Riga di 3 tile (quote %) + riga di 3 numeri chiave: stesso blocco per comune e per scope area.
function statBlockHtml(tiles, nums) {
  const tilesHtml = tiles
    .map((t) => `<div class="statTile"><div class="val">${t.val}</div><div class="lbl">${esc(t.label)}</div></div>`)
    .join("");
  const numsHtml = nums
    .map((n) => `<div class="numCell"><div class="val${n.cls ? " " + n.cls : ""}">${n.val}</div><div class="lbl">${esc(n.label)}</div></div>`)
    .join("");
  return `<div class="statTiles">${tilesHtml}</div><div class="numRow">${numsHtml}</div>`;
}

function renderPanel(proCom, comuneName) {
  const totals = flowIndex.totals.get(proCom) ?? { out: 0, in: 0, self: 0 };
  const totResidenti = totals.out + totals.self;
  const totPostiLavoro = totals.self + totals.in;
  const saldo = totals.in - totals.out;
  const statsHtml = statBlockHtml(
    [
      { val: pct(totals.self, totResidenti), label: "Vive e lavora qui" },
      { val: pct(totals.out, totResidenti), label: "Lavora altrove" },
      { val: pct(totals.in, totPostiLavoro), label: "Posti coperti da pendolari" },
    ],
    [
      { val: fmt(totResidenti), label: "Popolazione attiva" },
      { val: fmt(totPostiLavoro), label: "Posti di lavoro" },
      { val: `${saldo >= 0 ? "+" : ""}${fmt(saldo)}`, label: "Saldo netto", cls: saldo >= 0 ? "pos" : "neg" },
    ]
  );

  const topOut = topFlows(flowIndex.byOrigin.get(proCom) ?? [], { totalForShare: totals.out || 1 });
  const topIn = topFlows(flowIndex.byDest.get(proCom) ?? [], { totalForShare: totals.in || 1 });

  const listHtml = (list, total, kind) =>
    list
      .map((d) => {
        const share = total > 0 ? (d.val / total) * 100 : 0;
        return `<div class="dest">
          <div class="top"><span>${esc(nomeComune(d.other))}</span><span class="pct">${fmt(d.val)} (${pct(d.val, total)})</span></div>
          <div class="bar"><i class="${kind}" style="width:${share.toFixed(1)}%"></i></div>
        </div>`;
      })
      .join("");

  document.getElementById("panelBody").innerHTML = `
    <h2>${esc(comuneName)}</h2>
    ${statsHtml}
    <p class="hint">Mostrati i primi 25 collegamenti (quota &ge; 1%). Attiva "Mostra tutti i collegamenti del comune" per vederli tutti sulla mappa.</p>
    <h3>Top destinazioni (uscita)</h3>
    ${listHtml(topOut, totals.out, "out")}
    <h3>Top origini (entrata)</h3>
    ${listHtml(topIn, totals.in, "in")}
  `;
}

// Righe entrata/uscita/saldo per ogni comune collegato al comune selezionato,
// unendo byOrigin (uscita) e byDest (entrata) per lo stesso "other".
function comuneFlowsRows(proCom) {
  const rows = new Map(); // other -> { entrata, uscita }
  const ensure = (id) => {
    if (!rows.has(id)) rows.set(id, { entrata: 0, uscita: 0 });
    return rows.get(id);
  };
  for (const { other, val } of flowIndex.byOrigin.get(proCom) ?? []) ensure(other).uscita += val;
  for (const { other, val } of flowIndex.byDest.get(proCom) ?? []) ensure(other).entrata += val;

  const collegati = [...rows.entries()]
    .map(([id, v]) => ({ id, nome: nomeComune(id), entrata: v.entrata, uscita: v.uscita, saldo: v.entrata - v.uscita, self: false }))
    .sort((a, b) => b.saldo - a.saldo);

  const self = flowIndex.totals.get(proCom)?.self ?? 0;
  const selfRow = { id: proCom, nome: nomeComune(proCom), entrata: self, uscita: self, saldo: 0, self: true };
  return [selfRow, ...collegati];
}

// Codice ISTAT comune a 6 cifre (pro_com con zero-padding a sinistra).
function istatCode(id) {
  return String(id).padStart(6, "0");
}

let flowsTableData = null; // { comuneName, rows } correnti, per l'export

function renderFlowsTable(proCom, comuneName) {
  const bodyEl = document.getElementById("flowsTableBody");
  const titleEl = document.getElementById("flowsTableTitleText");
  if (!bodyEl) return;

  if (proCom == null) {
    flowsTableData = null;
    titleEl.textContent = "Tabella flussi";
    bodyEl.innerHTML = `<p class="hint" style="padding:14px 16px">Seleziona un comune sulla mappa.</p>`;
    return;
  }

  const rows = comuneFlowsRows(proCom);
  flowsTableData = { comuneName, rows };
  titleEl.textContent = `Tabella flussi — ${comuneName}`;

  const body = rows
    .map((r) => {
      const cls = r.saldo >= 0 ? "pos" : "neg";
      const label = r.self ? `${esc(r.nome)} <span class="hint">(vive e lavora qui)</span>` : esc(r.nome);
      return `<tr${r.self ? ' class="flows-self-row"' : ""}>
        <td>${label}</td>
        <td>${istatCode(r.id)}</td>
        <td>${fmt(r.entrata)}</td>
        <td>${fmt(r.uscita)}</td>
        <td class="${cls}">${r.saldo >= 0 ? "+" : ""}${fmt(r.saldo)}</td>
      </tr>`;
    })
    .join("");

  bodyEl.innerHTML = `
    <div class="flows-export-bar">
      <button id="flowsExportCsv" class="flows-export-btn">Scarica CSV</button>
      <button id="flowsExportJson" class="flows-export-btn">Scarica JSON</button>
    </div>
    <div class="info-section">
      <p class="info-text">${rows.length - 1} comuni collegati a <strong>${esc(comuneName)}</strong>, più la quota di chi vive e lavora nello stesso comune. Entrata = pendolari che arrivano da quel comune, Uscita = pendolari che vi si recano, Saldo = entrata − uscita.</p>
      <div class="analisi-table-wrap">
        <table class="analisi-table">
          <thead><tr><th>Comune</th><th>Cod. ISTAT</th><th>Entrata</th><th>Uscita</th><th>Saldo</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById("flowsExportCsv").addEventListener("click", () => exportFlowsTable("csv"));
  document.getElementById("flowsExportJson").addEventListener("click", () => exportFlowsTable("json"));
}

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvField(v) {
  const s = String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportFlowsTable(kind) {
  if (!flowsTableData) return;
  const { comuneName, rows } = flowsTableData;
  const safeName = comuneName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  if (kind === "csv") {
    const header = ["comune", "cod_istat", "entrata", "uscita", "saldo", "stesso_comune"].join(";");
    const lines = rows.map((r) =>
      [csvField(r.nome), istatCode(r.id), r.entrata, r.uscita, r.saldo, r.self ? "1" : "0"].join(";")
    );
    downloadBlob(`flussi-${safeName}.csv`, [header, ...lines].join("\n"), "text/csv;charset=utf-8");
  } else {
    const data = rows.map((r) => ({
      comune: r.nome,
      cod_istat: istatCode(r.id),
      entrata: r.entrata,
      uscita: r.uscita,
      saldo: r.saldo,
      stesso_comune: r.self,
    }));
    downloadBlob(`flussi-${safeName}.json`, JSON.stringify({ comune: comuneName, flussi: data }, null, 2), "application/json");
  }
}

let popup = null;

function showPopup(lngLat, html) {
  if (popup) popup.remove();
  popup = new maplibregl.Popup({ closeButton: true, className: "flow-popup" })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);
}

function onComuneClick(proCom, comuneName, lngLat) {
  selectedProCom = proCom;
  map.setFilter("comuni-selected", ["==", ["get", "pro_com"], proCom]);
  renderArcs(proCom);
  renderPanel(proCom, comuneName);
  syncFiltersToComune(proCom);
  if (document.getElementById("flowsTableWrap").classList.contains("open")) {
    renderFlowsTable(proCom, comuneName);
  }

  const totals = flowIndex.totals.get(proCom) ?? { out: 0, in: 0, self: 0 };
  const saldo = totals.in - totals.out;
  const saldoCls = saldo >= 0 ? "pos" : "neg";
  const saldoLabel = saldo >= 0 ? "Polo lavoro" : "Polo residenziale";
  showPopup(lngLat, `
    <strong>${esc(comuneName)}</strong>
    <p>Pendolari in uscita: ${fmt(totals.out)}</p>
    <p>Pendolari in entrata: ${fmt(totals.in)}</p>
    <p class="${saldoCls}">Saldo: ${saldo >= 0 ? "+" : ""}${fmt(saldo)} &mdash; ${saldoLabel}</p>
  `);
}

const hoverTooltip = document.createElement("div");
hoverTooltip.className = "comune-hover-tooltip";
hoverTooltip.style.display = "none";
document.getElementById("map").appendChild(hoverTooltip);

map.on("load", () => {
  map.on("mousemove", "comuni-fill", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const f = e.features[0];
    const proCom = f.properties.pro_com;
    updateHoverTooltip(e.point, proCom, f.properties.comune);
    const nextHovered = hoverArcsAllowed() ? proCom : null;
    if (nextHovered !== hoveredProCom) {
      hoveredProCom = nextHovered;
      applyLayers();
      if (activePanelTab === "flussi") {
        if (hoveredProCom !== null) renderPanel(hoveredProCom, f.properties.comune);
        else updateFlowView();
      }
    }
  });
  map.on("mouseleave", "comuni-fill", () => {
    map.getCanvas().style.cursor = "";
    hoverTooltip.style.display = "none";
    hoverTooltip.classList.remove("coro");
    if (hoveredProCom !== null) {
      hoveredProCom = null;
      applyLayers();
      if (activePanelTab === "flussi") updateFlowView();
    }
  });
  map.on("click", "comuni-fill", (e) => {
    const f = e.features[0];
    if (activePanelTab === "coro" || activePanelTab === "bivariate") {
      showCoroPopup(f.properties.pro_com, f.properties.comune, e.lngLat);
    } else {
      onComuneClick(f.properties.pro_com, f.properties.comune, e.lngLat);
    }
  });
  mapLoaded = true;
  tryInitialRender();
  applyCoroFeatureState();
});

// ── Info modal (slide dal basso) ───────────────────────────────────────
(function initInfoModal() {
  const overlay = document.getElementById("infoOverlay");
  const wrap = document.getElementById("infoModalWrap");
  const modal = document.getElementById("infoModal");
  const tabBtn = document.getElementById("infoModalTab");

  function open() { overlay.classList.add("open"); wrap.classList.add("open"); tabBtn.classList.add("open"); }
  function close() { overlay.classList.remove("open"); wrap.classList.remove("open"); tabBtn.classList.remove("open"); }
  function toggle() { wrap.classList.contains("open") ? close() : open(); }

  tabBtn.addEventListener("click", toggle);
  overlay.addEventListener("click", close);
  document.getElementById("infoClose").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  const totop = document.getElementById("infoTotop");
  function activePanel() { return modal.querySelector(".info-panel.active"); }
  function updateTotop() {
    const p = activePanel();
    totop.classList.toggle("visible", !!p && p.scrollTop > 120);
  }
  modal.querySelectorAll(".info-panel").forEach((p) => {
    p.addEventListener("scroll", updateTotop, { passive: true });
  });
  totop.addEventListener("click", () => {
    const p = activePanel();
    if (p) p.scrollTo({ top: 0, behavior: "smooth" });
  });

  modal.querySelectorAll(".info-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      modal.querySelectorAll(".info-tab").forEach((t) => t.classList.remove("active"));
      modal.querySelectorAll(".info-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("itab-" + tab.dataset.itab).classList.add("active");
      updateTotop();
    });
  });
})();

// ── Modale tabella flussi comune ───────────────────────────────────────
(function initFlowsTableModal() {
  const overlay = document.getElementById("flowsTableOverlay");
  const wrap = document.getElementById("flowsTableWrap");
  const tabBtn = document.getElementById("btnFlowsTable");

  function open() {
    overlay.classList.add("open");
    wrap.classList.add("open");
    renderFlowsTable(selectedProCom, selectedProCom != null ? nomeComune(selectedProCom) : null);
  }
  function close() { overlay.classList.remove("open"); wrap.classList.remove("open"); }
  function toggle() { wrap.classList.contains("open") ? close() : open(); }

  tabBtn.addEventListener("click", toggle);
  overlay.addEventListener("click", close);
  document.getElementById("flowsTableClose").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
})();

// ── Tab Coroplettiche ────────────────────────────────────────────────────
let activePanelTab = "flussi";
let activeMetric = "autocontenimento";
let activeBivMetric = "saldo_densita";

// Metrica in uso per il layer mappa/legenda/tooltip: dipende dal tab pannello attivo.
function currentCoroMetric() {
  return activePanelTab === "bivariate" ? activeBivMetric : activeMetric;
}
let coroFeatureStateApplied = false;

const AUTOCONT_COLORS = ["#fef0d9", "#fdcc8a", "#fc8d59", "#e34a33", "#b30000"];
const INTENSITA_COLORS = ["#ffffcc", "#c2e699", "#78c679", "#31a354", "#006837"];
const SALDO_COLORS = ["#ff4400", "#ff9d70", "#8a8a94", "#7aa8ff", "#3d7fff"];
const NODATA_COLOR = "#3a3a42";

const METRIC_DEFS = {
  autocontenimento: {
    label: "Autocontenimento lavorativo",
    unit: "% occupati residenti che lavorano nello stesso comune",
    description: "Quanto un comune trattiene i propri occupati: colori scuri = la maggior parte lavora sul posto (poca uscita), colori chiari = molti si spostano altrove per lavoro.",
    colors: AUTOCONT_COLORS,
    breaksKey: "autocontBreaks",
    featureStateKey: "acCls",
    format: (v) => `${v.toFixed(1)}%`,
  },
  saldo: {
    label: "Saldo pendolarismo",
    unit: "Entrate − uscite (pendolari)",
    description: "Se il comune attrae più pendolari di quanti ne perde: blu = polo lavoro (entrate > uscite), arancio = polo residenziale/dormitorio (uscite > entrate).",
    colors: SALDO_COLORS,
    breaksKey: "saldoBreaks",
    featureStateKey: "saldoCls",
    format: (v) => `${v >= 0 ? "+" : ""}${fmt(v)}`,
  },
  intensita: {
    label: "Intensità pendolarismo",
    unit: "% pop. residente che esce per lavoro",
    description: "Quanto pendolarismo in uscita genera un comune rispetto alla sua popolazione: colori scuri = quota alta di residenti che si sposta fuori per lavoro.",
    colors: INTENSITA_COLORS,
    breaksKey: "intensitaBreaks",
    featureStateKey: "intCls",
    format: (v) => `${v.toFixed(1)}%`,
  },
};

// Palette bivariata 3x3 classica (Joshua Stevens): grigio-teal per l'asse X,
// magenta-blu per l'asse Y. colors[xCls*3 + yCls], xCls/yCls in 0..2 (tercili).
const BIVAR_COLORS = [
  "#e8e8e8", "#dfb0d6", "#be64ac", // x basso: y basso, medio, alto
  "#ace4e4", "#a5add3", "#8c62aa", // x medio
  "#5ac8c8", "#5698b9", "#3b4994", // x alto
];
const TERCILE_LABELS = ["basso", "medio", "alto"];
const TERCILE_LABELS_UP = ["BASSA", "MEDIA", "ALTA"];

const BIVAR_DEFS = {
  saldo_densita: {
    label: "Saldo × Densità popolazione",
    metricX: "saldo",
    metricY: "densita",
    breaksXKey: "saldoBreaks3",
    breaksYKey: "densitaBreaks3",
    ranksXKey: "saldoRanks",
    ranksYKey: "densitaRanks",
    labelX: "Saldo pendolarismo",
    labelY: "Densità popolazione",
    formatX: (v) => `${v >= 0 ? "+" : ""}${fmt(v)}`,
    formatY: (v) => `${v.toFixed(0)} ab/km²`,
    colors: BIVAR_COLORS,
    featureStateKey: "svCls",
    description: "Incrocia il saldo pendolari (entrate − uscite) con la densità abitativa. Angolo rosa in alto: saldo negativo + densità alta = comuni \"dormitorio densi\" (satelliti di aree metropolitane). Angolo verde acqua in basso: saldo positivo + densità bassa = \"poli attrattori radi\" (piccoli centri industriali/produttivi che polarizzano il lavoro di un territorio esteso).",
    corners: [
      { xCls: 0, yCls: 2, title: "Dormitorio densi", hint: "saldo basso + densità alta" },
      { xCls: 2, yCls: 0, title: "Poli attrattori radi", hint: "saldo alto + densità bassa" },
    ],
  },
  autocont_distanza: {
    label: "Autocontenimento × Distanza dal capoluogo",
    metricX: "autocontenimento",
    metricY: "distanzaCapoluogo",
    breaksXKey: "autocontBreaks3",
    breaksYKey: "distCapBreaks3",
    ranksXKey: "autocontRanks",
    ranksYKey: "distCapRanks",
    labelX: "Autocontenimento lavorativo",
    labelY: "Distanza dal capoluogo di provincia",
    formatX: (v) => `${v.toFixed(1)}%`,
    formatY: (v) => `${v.toFixed(0)} km`,
    colors: BIVAR_COLORS,
    featureStateKey: "adCls",
    description: "Incrocia l'autocontenimento lavorativo con la distanza dal capoluogo di provincia: mostra l'effetto gravitazionale del capoluogo sui comuni limitrofi. Angolo grigio chiaro in basso a sinistra: vicini al capoluogo e poco autonomi (satelliti attratti). Angolo blu scuro in alto a destra: lontani e autonomi (poli locali indipendenti).",
    corners: [
      { xCls: 0, yCls: 0, title: "Satelliti del capoluogo", hint: "vicini + poco autonomi" },
      { xCls: 2, yCls: 2, title: "Poli locali indipendenti", hint: "lontani + molto autonomi" },
    ],
  },
};

function getDef(metric) {
  return METRIC_DEFS[metric] ?? BIVAR_DEFS[metric];
}
function isBivariate(metric) {
  return metric in BIVAR_DEFS;
}

// Classe combinata 0..8 (xCls*3 + yCls) o -1 se uno dei due valori manca.
function bivariateClass(def, m) {
  const x = m[def.metricX];
  const y = m[def.metricY];
  if (x === null || y === null) return -1;
  const xCls = classify(x, coroData[def.breaksXKey]);
  const yCls = classify(y, coroData[def.breaksYKey]);
  return xCls * 3 + yCls;
}

// Assegna a ogni comune la classe (0..4, o 0..8 per le bivariate) o -1 (nessun
// dato) per ciascuna metrica/coppia, come feature-state sul layer comuni-fill.
// Va rifatto solo una volta: cambiare metrica attiva aggiorna solo il paint.
function applyCoroFeatureState() {
  if (coroFeatureStateApplied || !mapLoaded || !coroData) return;
  for (const [id, m] of coroData.metrics) {
    const state = {
      acCls: m.autocontenimento === null ? -1 : classify(m.autocontenimento, coroData.autocontBreaks),
      saldoCls: classify(m.saldo, coroData.saldoBreaks),
      intCls: m.intensita === null ? -1 : classify(m.intensita, coroData.intensitaBreaks),
      svCls: bivariateClass(BIVAR_DEFS.saldo_densita, m),
      adCls: bivariateClass(BIVAR_DEFS.autocont_distanza, m),
    };
    map.setFeatureState({ source: "comuni", sourceLayer: "comuni", id }, state);
  }
  coroFeatureStateApplied = true;
}

function coroPaintExpression(metric) {
  const def = getDef(metric);
  const expr = ["match", ["feature-state", def.featureStateKey]];
  def.colors.forEach((color, i) => expr.push(i, color));
  expr.push(NODATA_COLOR);
  return expr;
}

// La legenda coropletica funge da filtro per classe, interconnesso con la
// mappa, il donut e il ranking: disattivare una classe la attenua ovunque.
// Si azzera a ogni cambio di metrica (le classi non sono confrontabili tra metriche).
// Nessuna classe selezionata = mostra tutto. Appena selezioni ≥1 classe,
// si vede solo quella selezione (isolamento, non esclusione).
let coroSelectedClasses = new Set();

function resetCoroClassFilters() {
  coroSelectedClasses = new Set();
}

function coroClassVisible(key) {
  return coroSelectedClasses.size === 0 || coroSelectedClasses.has(key);
}

function coroOpacityExpression(metric) {
  const def = getDef(metric);
  const expr = ["match", ["feature-state", def.featureStateKey]];
  def.colors.forEach((color, i) => expr.push(i, coroClassVisible(i) ? 0.78 : 0.06));
  expr.push(coroClassVisible("nodata") ? 0.78 : 0.06);
  return expr;
}

function applyCoroLayer(metric) {
  map.setPaintProperty("comuni-fill", "fill-color", coroPaintExpression(metric));
  map.setPaintProperty("comuni-fill", "fill-opacity", coroOpacityExpression(metric));
}

function clearCoroLayer() {
  map.setPaintProperty("comuni-fill", "fill-opacity", 0);
}

// Etichette min/max per ciascuna delle 5 classi, dai breakpoint + range dei dati.
function coroLegendRanges(metric) {
  const def = METRIC_DEFS[metric];
  const breaks = coroData[def.breaksKey];
  const values = [...coroData.metrics.values()].map((m) => m[metric]).filter((v) => v !== null);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const edges = [min, ...breaks, max];
  const ranges = [];
  for (let i = 0; i < edges.length - 1; i++) ranges.push([edges[i], edges[i + 1]]);
  return ranges;
}

function coroLegendHtml(metric) {
  const def = METRIC_DEFS[metric];
  const ranges = coroLegendRanges(metric); // 5 bande ascendenti [[e0,e1],[e1,e2],...,[e4,e5]]
  const edges = [ranges[0][0], ...ranges.map(([, hi]) => hi)]; // 6 confini, dal minimo al massimo
  const nodataCount = [...coroData.metrics.values()].filter((m) => m[metric] === null).length;
  // colors[0] = valore più basso: la barra va letta dall'alto (basso) verso il basso (alto),
  // le 6 etichette (spaziate con justify-content:space-between) segnano i confini delle 5 bande.
  // Ogni banda è cliccabile: funge da filtro di classe interconnesso con mappa/donut/ranking.
  const barHtml = def.colors
    .map((c, i) => `<div data-cls="${i}" class="${coroClassVisible(i) ? "" : "off"}" style="background:${c}" title="Classe ${i + 1}: clic per isolare"></div>`)
    .join("");
  const labelsHtml = edges.map((v) => `<span>${def.format(v)}</span>`).join("");
  return `
    <div class="coro-leg-title">${esc(def.label)}</div>
    <div class="coro-leg-unit">${esc(def.unit)}</div>
    <div class="coro-leg-scale">
      <div class="coro-leg-bar">${barHtml}</div>
      <div class="coro-leg-labels">${labelsHtml}</div>
    </div>
    <div class="coro-leg-nodata${coroClassVisible("nodata") ? "" : " off"}" data-cls="nodata" title="Nessun dato: clic per isolare"><i></i> Nessun dato (${fmt(nodataCount)} comuni)</div>
  `;
}

// Griglia 3x3 cliccabile (stessa logica di filtro/isolamento classe della
// legenda mono-metrica): righe = asse Y (dal basso in alto = valore crescente),
// colonne = asse X (da sinistra a destra = valore crescente).
function bivariateLegendHtml(metric) {
  const def = BIVAR_DEFS[metric];
  const nodataCount = [...coroData.metrics.values()].filter((m) => bivariateClass(def, m) === -1).length;
  const colHeadsHtml = TERCILE_LABELS_UP.map((t) => `<div class="coro-biv-colhead">${t}</div>`).join("");
  const rowsHtml = [2, 1, 0]
    .map((yCls) => {
      const cellsHtml = [0, 1, 2]
        .map((xCls) => {
          const cls = xCls * 3 + yCls;
          const color = BIVAR_COLORS[cls];
          return `<div class="coro-biv-cell${coroClassVisible(cls) ? "" : " off"}" data-cls="${cls}" style="background:${color}" title="${esc(def.labelX)}: ${TERCILE_LABELS[xCls]} · ${esc(def.labelY)}: ${TERCILE_LABELS[yCls]}"></div>`;
        })
        .join("");
      return `<div class="coro-biv-rowhead">${TERCILE_LABELS_UP[yCls]}</div>${cellsHtml}`;
    })
    .join("");
  return `
    <div class="coro-leg-title">${esc(def.label)}</div>
    <div class="coro-leg-hint">Click cella &rarr; filtra per classe</div>
    <div class="coro-biv-wrap">
      <div class="coro-biv-axis-y">${esc(def.labelY)} &uarr;</div>
      <div class="coro-biv-grid">
        <div class="coro-biv-corner"></div>${colHeadsHtml}
        ${rowsHtml}
      </div>
    </div>
    <div class="coro-biv-axis-x">${esc(def.labelX)} &rarr;</div>
    <div class="coro-leg-nodata${coroClassVisible("nodata") ? "" : " off"}" data-cls="nodata" title="Nessun dato: clic per isolare"><i></i> Nessun dato (${fmt(nodataCount)} comuni)</div>
  `;
}

function renderCoroLegend(metric) {
  document.getElementById("coroMapLegend").innerHTML = isBivariate(metric)
    ? bivariateLegendHtml(metric)
    : coroLegendHtml(metric);
}

document.getElementById("coroMapLegend").addEventListener("click", (e) => {
  const el = e.target.closest("[data-cls]");
  if (!el || !coroData) return;
  const key = el.dataset.cls === "nodata" ? "nodata" : Number(el.dataset.cls);
  if (coroSelectedClasses.has(key)) coroSelectedClasses.delete(key);
  else coroSelectedClasses.add(key);
  const metric = currentCoroMetric();
  applyCoroLayer(metric);
  renderCoroLegend(metric);
  if (isBivariate(metric)) {
    renderBivariateDonut(metric);
    renderBivariateCorners(metric);
  } else {
    renderCoroDonut(metric);
    renderCoroRanking(metric);
  }
});

// Coordinate (x,y) di un punto a distanza `radius` dal centro (cx,cy), all'angolo dato.
function arcPoint(cx, cy, radius, angle) {
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

// Path SVG di una "fetta" di donut (anello, non spicchio pieno) tra due raggi.
function donutArcPath(cx, cy, outerR, innerR, start, sweep) {
  const end = start + sweep;
  const [x1, y1] = arcPoint(cx, cy, outerR, start);
  const [x2, y2] = arcPoint(cx, cy, outerR, end);
  const [x3, y3] = arcPoint(cx, cy, innerR, end);
  const [x4, y4] = arcPoint(cx, cy, innerR, start);
  const largeArc = sweep > Math.PI ? 1 : 0;
  return `M${x1},${y1} A${outerR},${outerR} 0 ${largeArc},1 ${x2},${y2} L${x3},${y3} A${innerR},${innerR} 0 ${largeArc},0 ${x4},${y4} Z`;
}

const DONUT_CLASS_LABELS = ["Classe 1 (bassa)", "Classe 2", "Classe 3", "Classe 4", "Classe 5 (alta)", "Nessun dato"];

// Card donut generica: conteggi/colori/etichette allineati per indice, ultimo
// elemento sempre "nessun dato". Riusata da mono-metrica e bivariate.
function donutCardHtml(allCounts, allColors, allLabels) {
  const total = allCounts.reduce((a, b) => a + b, 0);
  const segments = donutSegments(allCounts);
  const R = 45, r = 28, cx = 65, cy = 65;

  const pathsHtml = segments
    .map((seg, i) => (allCounts[i] > 0 ? `<path d="${donutArcPath(cx, cy, R, r, seg.start, seg.sweep)}" fill="${allColors[i]}" opacity="0.92"/>` : ""))
    .join("");

  const legRowsHtml = allCounts
    .map((n, i) => {
      if (n === 0) return "";
      const pct = total > 0 ? ((n / total) * 100).toFixed(0) : "0";
      const barW = total > 0 ? Math.round((n / total) * 40) : 0;
      return `<div class="coro-donut-leg-row">
        <div class="coro-donut-dot" style="background:${allColors[i]}"></div>
        <span class="coro-donut-leg-label">${esc(allLabels[i])}</span>
        <div class="coro-donut-leg-bar-wrap"><div class="coro-donut-leg-bar" style="width:${barW}px;background:${allColors[i]}"></div></div>
        <span class="coro-donut-leg-count">${fmt(n)}</span>
        <span class="coro-donut-leg-pct">${pct}%</span>
      </div>`;
    })
    .join("");

  return `
    <div class="coro-donut-card">
      <div class="coro-donut-svg-wrap">
        <svg class="coro-donut-svg" viewBox="0 0 130 130">
          ${pathsHtml}
          <text x="${cx}" y="${cy - 5}" text-anchor="middle" class="coro-donut-total">${fmt(total)}</text>
          <text x="${cx}" y="${cy + 11}" text-anchor="middle" class="coro-donut-sublabel">comuni</text>
        </svg>
      </div>
      <div class="coro-donut-legend">${legRowsHtml}</div>
    </div>
  `;
}

// Grafico a ciambella: quanti comuni ricadono in ciascuna delle 5 classi
// (+ "nessun dato"), per vedere a colpo d'occhio se la distribuzione è
// bilanciata (i quantili la rendono ~uguale per costruzione) o sbilanciata.
function renderCoroDonut(metric) {
  const def = METRIC_DEFS[metric];
  const breaks = coroData[def.breaksKey];
  // Le classi disattivate dalla legenda escono dal conteggio: donut interconnesso al filtro.
  const counts = classCounts(coroData.metrics, metric, breaks).map((n, i) => (coroClassVisible(i) ? n : 0));
  const nodataCount = coroClassVisible("nodata") ? [...coroData.metrics.values()].filter((m) => m[metric] === null).length : 0;
  document.getElementById("coroDonut").innerHTML = donutCardHtml(
    [...counts, nodataCount],
    [...def.colors, NODATA_COLOR],
    DONUT_CLASS_LABELS
  );
}

// Donut bivariata: 9 classi (griglia 3x3) + "nessun dato".
function renderBivariateDonut(metric) {
  const def = BIVAR_DEFS[metric];
  const counts = new Array(9).fill(0);
  let nodataCount = 0;
  for (const m of coroData.metrics.values()) {
    const cls = bivariateClass(def, m);
    if (cls === -1) nodataCount++;
    else counts[cls]++;
  }
  const filteredCounts = counts.map((n, i) => (coroClassVisible(i) ? n : 0));
  const finalNodata = coroClassVisible("nodata") ? nodataCount : 0;
  const labels = [];
  for (let xCls = 0; xCls < 3; xCls++) {
    for (let yCls = 0; yCls < 3; yCls++) {
      labels.push(`${def.labelX} ${TERCILE_LABELS[xCls]} · ${def.labelY} ${TERCILE_LABELS[yCls]}`);
    }
  }
  labels.push("Nessun dato");
  document.getElementById("bivDonut").innerHTML = donutCardHtml(
    [...filteredCounts, finalNodata],
    [...def.colors, NODATA_COLOR],
    labels
  );
}

// Righe cliccabili: click centra la mappa sul comune (stesso flyTo usato dalla
// ricerca geografica) e apre il popup con il valore della metrica attiva.
function coroRankRowsHtml(list, def) {
  const maxAbs = Math.max(...list.map((d) => Math.abs(d.value)), 1);
  return list
    .map((d, i) => {
      const share = (Math.abs(d.value) / maxAbs) * 100;
      const barCls = d.value < 0 ? "neg" : "";
      return `<div class="coro-rank-row" data-procom="${d.id}">
        <div class="rank-top">
          <span class="rank-idx">${i + 1}</span>
          <span class="rank-name">${esc(nomeComune(d.id))}</span>
          <span class="rank-val">${def.format(d.value)}</span>
        </div>
        <div class="bar"><i class="${barCls}" style="width:${share.toFixed(1)}%"></i></div>
      </div>`;
    })
    .join("");
}

// Righe di un angolo bivariato: ordina i comuni della classe combinata per
// "estremità" (quanto il comune è tipico dell'angolo, non solo dentro la classe),
// usando i ranghi percentile sui due assi. Mostra entrambi i valori X e Y.
function bivariateCornerRowsHtml(list, def) {
  return list
    .map((d, i) => `<div class="coro-rank-row" data-procom="${d.id}">
        <div class="rank-top">
          <span class="rank-idx">${i + 1}</span>
          <span class="rank-name">${esc(nomeComune(d.id))}</span>
        </div>
        <div class="coro-biv-rank-vals">
          <span>${esc(def.labelX)}: ${def.formatX(d.x)}</span>
          <span>${esc(def.labelY)}: ${def.formatY(d.y)}</span>
        </div>
        <div class="bar"><i style="width:${((d.score / 2) * 100).toFixed(1)}%"></i></div>
      </div>`)
    .join("");
}

function renderBivariateCorners(metric) {
  const def = BIVAR_DEFS[metric];
  const xRanks = coroData[def.ranksXKey];
  const yRanks = coroData[def.ranksYKey];

  const cornerList = ({ xCls, yCls }) => {
    const cls = xCls * 3 + yCls;
    if (!coroClassVisible(cls)) return [];
    const items = [];
    for (const [id, m] of coroData.metrics) {
      if (bivariateClass(def, m) !== cls) continue;
      const xr = xRanks.get(id) ?? 0.5;
      const yr = yRanks.get(id) ?? 0.5;
      // Punteggio di "estremità" verso l'angolo: premia rango alto sul lato
      // "alto" dell'angolo e rango basso sul lato "basso".
      const score = (xCls === 2 ? xr : 1 - xr) + (yCls === 2 ? yr : 1 - yr);
      items.push({ id, x: m[def.metricX], y: m[def.metricY], score });
    }
    return items.sort((a, b) => b.score - a.score).slice(0, 10);
  };

  document.getElementById("bivRanking").innerHTML = def.corners
    .map(({ xCls, yCls, title, hint }) => `
      <div class="coro-rank-section">
        <h4>${esc(title)} <span class="hint">(${esc(hint)})</span></h4>
        ${bivariateCornerRowsHtml(cornerList({ xCls, yCls }), def)}
      </div>
    `)
    .join("");

  document.querySelectorAll("#bivRanking .coro-rank-row").forEach((row) => {
    row.addEventListener("click", () => {
      const proCom = Number(row.dataset.procom);
      const pos = point(proCom);
      if (!pos) return;
      map.flyTo({ center: pos, zoom: Math.max(map.getZoom(), 10) });
      showCoroPopup(proCom, nomeComune(proCom), pos);
    });
  });
}

function renderCoroRanking(metric) {
  const def = METRIC_DEFS[metric];
  const breaks = coroData[def.breaksKey];
  // Ranking interconnesso al filtro di classe: i comuni delle classi disattivate non compaiono.
  const filteredMetrics = new Map(
    [...coroData.metrics].filter(([, m]) => m[metric] !== null && coroClassVisible(classify(m[metric], breaks)))
  );
  const { top, bottom } = topBottom(filteredMetrics, metric, 10);
  document.getElementById("coroRanking").innerHTML = `
    <div class="coro-rank-section">
      <h4>Top 10 — valore più alto</h4>
      ${coroRankRowsHtml(top, def)}
    </div>
    <div class="coro-rank-section">
      <h4>Top 10 — valore più basso</h4>
      ${coroRankRowsHtml(bottom, def)}
    </div>
  `;
  document.querySelectorAll("#coroRanking .coro-rank-row").forEach((row) => {
    row.addEventListener("click", () => {
      const proCom = Number(row.dataset.procom);
      const pos = point(proCom);
      if (!pos) return;
      map.flyTo({ center: pos, zoom: Math.max(map.getZoom(), 10) });
      showCoroPopup(proCom, nomeComune(proCom), pos);
    });
  });
}

function renderCoroMetricDesc(metric) {
  document.getElementById("coroMetricDesc").textContent = METRIC_DEFS[metric].description;
}

function renderBivMetricDesc(metric) {
  document.getElementById("bivMetricDesc").textContent = BIVAR_DEFS[metric].description;
}

function setActiveMetric(metric) {
  activeMetric = metric;
  resetCoroClassFilters();
  document.querySelectorAll("#coroLayerBtns .layer-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.metric === metric);
  });
  applyCoroLayer(metric);
  renderCoroLegend(metric);
  renderCoroMetricDesc(metric);
  renderCoroDonut(metric);
  renderCoroRanking(metric);
}

function setActiveBivMetric(metric) {
  activeBivMetric = metric;
  resetCoroClassFilters();
  document.querySelectorAll("#coroBivBtns .layer-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.metric === metric);
  });
  applyCoroLayer(metric);
  renderCoroLegend(metric);
  renderBivMetricDesc(metric);
  renderBivariateDonut(metric);
  renderBivariateCorners(metric);
}

function setActivePanelTab(tab) {
  activePanelTab = tab;
  document.getElementById("panelTabFlussi").classList.toggle("active", tab === "flussi");
  document.getElementById("panelTabBivariate").classList.toggle("active", tab === "bivariate");
  document.getElementById("panelTabCoro").classList.toggle("active", tab === "coro");
  document.getElementById("panel-view-flussi").classList.toggle("active", tab === "flussi");
  document.getElementById("panel-view-bivariate").classList.toggle("active", tab === "bivariate");
  document.getElementById("panel-view-coro").classList.toggle("active", tab === "coro");
  document.getElementById("legend").style.display = tab === "flussi" ? "" : "none";
  document.getElementById("coroMapLegend").style.display = tab === "flussi" ? "none" : "";
  if (!mapLoaded) return; // il tab può essere cliccato prima che la mappa/i dati siano pronti
  if (tab === "coro") {
    setBaseLayers([]);
    applyCoroFeatureState();
    renderCoroMetricDesc(activeMetric);
    if (coroData) {
      applyCoroLayer(activeMetric);
      renderCoroLegend(activeMetric);
      renderCoroDonut(activeMetric);
      renderCoroRanking(activeMetric);
    }
  } else if (tab === "bivariate") {
    setBaseLayers([]);
    applyCoroFeatureState();
    renderBivMetricDesc(activeBivMetric);
    if (coroData) {
      applyCoroLayer(activeBivMetric);
      renderCoroLegend(activeBivMetric);
      renderBivariateDonut(activeBivMetric);
      renderBivariateCorners(activeBivMetric);
    }
  } else {
    clearCoroLayer();
    if (dataLoaded) updateFlowView();
  }
  setMapRotationPitchLock(tab === "coro" || tab === "bivariate");
}

function setMapRotationPitchLock(locked) {
  if (locked) {
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    if (map.getPitch() !== 0) map.easeTo({ pitch: 0, bearing: 0, duration: 300 });
  } else {
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.keyboard.enableRotation();
  }
}

document.getElementById("panelTabFlussi").addEventListener("click", () => setActivePanelTab("flussi"));
document.getElementById("panelTabBivariate").addEventListener("click", () => setActivePanelTab("bivariate"));
document.getElementById("panelTabCoro").addEventListener("click", () => setActivePanelTab("coro"));
document.querySelectorAll("#coroLayerBtns .layer-btn").forEach((btn) => {
  btn.addEventListener("click", () => setActiveMetric(btn.dataset.metric));
});
document.querySelectorAll("#coroBivBtns .layer-btn").forEach((btn) => {
  btn.addEventListener("click", () => setActiveBivMetric(btn.dataset.metric));
});

// Tooltip hover: nome comune + valore della metrica attiva quando il tab
// Coroplettiche è aperto, altrimenti solo il nome (comportamento invariato).
function coroValueHtml(m, metric) {
  const def = getDef(metric);
  if (isBivariate(metric)) {
    const x = m ? m[def.metricX] : null;
    const y = m ? m[def.metricY] : null;
    if (x === null || y === null) return `${def.label}: nessun dato`;
    return `${def.labelX}: ${def.formatX(x)} · ${def.labelY}: ${def.formatY(y)}`;
  }
  const val = m ? m[metric] : null;
  return `${def.label}: ${val === null ? "nessun dato" : def.format(val)}`;
}

function updateHoverTooltip(point, proCom, comuneName) {
  if ((activePanelTab === "coro" || activePanelTab === "bivariate") && coroData) {
    const m = coroData.metrics.get(proCom);
    hoverTooltip.classList.add("coro");
    hoverTooltip.innerHTML = `${esc(comuneName)}<span class="coro-val">${coroValueHtml(m, currentCoroMetric())}</span>`;
  } else {
    hoverTooltip.classList.remove("coro");
    hoverTooltip.textContent = comuneName;
  }
  hoverTooltip.style.left = `${point.x}px`;
  hoverTooltip.style.top = `${point.y}px`;
  hoverTooltip.style.display = "block";
}

function showCoroPopup(proCom, comuneName, lngLat) {
  const m = coroData.metrics.get(proCom);
  showPopup(lngLat, `
    <strong>${esc(comuneName)}</strong>
    <p>${coroValueHtml(m, currentCoroMetric())}</p>
  `);
}
