import { buildIndex, topFlows } from "./flow-index.js";

let flowIndex = null;
let centroidi = null;
let geo = null;
let dataLoaded = false;
let mapLoaded = false;

async function loadData() {
  const [flows, centroidiData, geoData] = await Promise.all([
    fetch("data/flows.json").then((r) => {
      if (!r.ok) throw new Error(`flows.json: HTTP ${r.status}`);
      return r.json();
    }),
    fetch("data/centroidi.json").then((r) => {
      if (!r.ok) throw new Error(`centroidi.json: HTTP ${r.status}`);
      return r.json();
    }),
    fetch("data/geo.json").then((r) => {
      if (!r.ok) throw new Error(`geo.json: HTTP ${r.status}`);
      return r.json();
    }),
  ]);
  flowIndex = buildIndex(flows);
  centroidi = centroidiData;
  geo = geoData;
  dataLoaded = true;
  initGeoFilters();
  buildGeoSuggestions();
  tryInitialRender();
  renderAnalisiRegioni();
}

loadData().catch((err) => {
  document.getElementById("panelEmpty").textContent = `Errore caricamento dati: ${err.message}`;
  console.error(err);
});

const BASE_PADDING = 30;
const panelEl = document.getElementById("panel");

if (window.matchMedia("(max-width: 768px)").matches) {
  panelEl.classList.add("collapsed");
}

function computeMapPadding() {
  const offset = panelEl.classList.contains("collapsed")
    ? 0
    : panelEl.getBoundingClientRect().width;
  return { top: BASE_PADDING, bottom: BASE_PADDING, left: BASE_PADDING, right: offset + BASE_PADDING };
}

function setupPanelToggle() {
  const toggle = document.getElementById("panelToggle");
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

  toggle.textContent = panelEl.classList.contains("collapsed") ? "▶" : "◀";

  toggle.addEventListener("click", () => {
    panelEl.classList.toggle("collapsed");
    toggle.textContent = panelEl.classList.contains("collapsed") ? "▶" : "◀";
    syncOffset(true);
  });

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
  bounds: [
    [5.6, 35.2],
    [19.6, 47.2],
  ],
  fitBoundsOptions: { padding: computeMapPadding() },
  minZoom: 5,
  maxZoom: 12,
  hash: true,
  maxBounds: [
    [4.5, 33.5],
    [20.5, 48.5],
  ],
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
  return selectedProCom === null && !showAllFlows && showNodes;
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

const ITALY_BOUNDS = [
  [5.6, 35.2],
  [19.6, 47.2],
];

document.getElementById("btnHome").addEventListener("click", () => {
  map.fitBounds(ITALY_BOUNDS, { padding: computeMapPadding(), duration: 600 });
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
    <h3>Saldo pendolari per regione (entrata − uscita)</h3>
    <p class="hint">Positivo = regione attrattiva (più occupati in entrata); negativo = regione che esporta forza lavoro.</p>
    ${divergingHtml(saldoPerRegione(), nomeRegione)}
  `;
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
  document.getElementById("panelBody").innerHTML = `
    <h2>${esc(title)}</h2>
    <p>Comuni inclusi: ${fmt(idSet.size)}</p>
    <p>Residenti che lavorano nello stesso comune: ${fmt(self)}</p>
    <p>Spostamenti interni all'area (tra comuni dell'area): ${fmt(internal)}</p>
    <p>Pendolari in uscita verso ${altre}: ${fmt(externalOut)}</p>
    <p>Pendolari in entrata da ${altre}: ${fmt(externalIn)}</p>
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
      return pos ? { id, position: pos, radius: bubbleRadius(t.out + t.in + t.self), saldo: t.in - t.out } : null;
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
      return pos ? { id, position: pos, radius: bubbleRadius(t.out + t.in + t.self), saldo: t.in - t.out } : null;
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

function renderPanel(proCom, comuneName) {
  const totals = flowIndex.totals.get(proCom) ?? { out: 0, in: 0, self: 0 };
  const totResidenti = totals.out + totals.self;

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
    <p>Residenti che lavorano nel comune: ${fmt(totals.self)} (${pct(totals.self, totResidenti)})</p>
    <p>Usciti verso altri comuni: ${fmt(totals.out)}</p>
    <p>Entrati da altri comuni: ${fmt(totals.in)}</p>
    <p class="hint">Mostrati i primi 25 collegamenti (quota &ge; 1%). Attiva "Mostra tutti i collegamenti del comune" per vederli tutti sulla mappa.</p>
    <h3>Top destinazioni (uscita)</h3>
    ${listHtml(topOut, totals.out, "out")}
    <h3>Top origini (entrata)</h3>
    ${listHtml(topIn, totals.in, "in")}
  `;
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
    hoverTooltip.textContent = f.properties.comune;
    hoverTooltip.style.left = `${e.point.x}px`;
    hoverTooltip.style.top = `${e.point.y}px`;
    hoverTooltip.style.display = "block";
    const proCom = f.properties.pro_com;
    const hoverArcsEnabled = selectedProCom === null && !showAllFlows && showNodes;
    const nextHovered = hoverArcsEnabled ? proCom : null;
    if (nextHovered !== hoveredProCom) {
      hoveredProCom = nextHovered;
      applyLayers();
    }
  });
  map.on("mouseleave", "comuni-fill", () => {
    map.getCanvas().style.cursor = "";
    hoverTooltip.style.display = "none";
    if (hoveredProCom !== null) {
      hoveredProCom = null;
      applyLayers();
    }
  });
  map.on("click", "comuni-fill", (e) => {
    const f = e.features[0];
    onComuneClick(f.properties.pro_com, f.properties.comune, e.lngLat);
  });
  mapLoaded = true;
  tryInitialRender();
});

// ── Info modal (slide dal basso) ───────────────────────────────────────
(function initInfoModal() {
  const overlay = document.getElementById("infoOverlay");
  const wrap = document.getElementById("infoModalWrap");
  const modal = document.getElementById("infoModal");
  const tabBtn = document.getElementById("infoModalTab");

  function open() { overlay.classList.add("open"); wrap.classList.add("open"); }
  function close() { overlay.classList.remove("open"); wrap.classList.remove("open"); }
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
