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
  tryInitialRender();
}

loadData().catch((err) => {
  document.getElementById("panelEmpty").textContent = `Errore caricamento dati: ${err.message}`;
  console.error(err);
});

function setupPanelToggle() {
  const panel = document.getElementById("panel");
  const toggle = document.getElementById("panelToggle");
  const root = document.documentElement;
  const COLLAPSED_OFFSET = 0;

  function syncOffset() {
    const offset = panel.classList.contains("collapsed")
      ? COLLAPSED_OFFSET
      : panel.getBoundingClientRect().width;
    root.style.setProperty("--panel-offset", `${offset}px`);
  }

  toggle.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    toggle.textContent = panel.classList.contains("collapsed") ? "▶" : "◀";
    syncOffset();
  });

  if (window.matchMedia("(max-width: 768px)").matches) {
    panel.classList.add("collapsed");
    toggle.textContent = "▶";
  }

  new ResizeObserver(syncOffset).observe(panel);
  syncOffset();
}

setupPanelToggle();

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
    [6.6, 35.2],
    [18.6, 47.2],
  ],
  fitBoundsOptions: { padding: 20 },
  minZoom: 5,
  maxZoom: 12,
  hash: true,
  maxBounds: [
    [4.5, 33.5],
    [20.5, 48.5],
  ],
});

const overlay = new deck.MapboxOverlay({ layers: [] });
map.addControl(overlay);

let selectedProCom = null;
let direction = "both";
let showAllFlows = true;
let showNodes = true;
let showAllComuneLinks = false;

document.getElementById("showAllComuneLinks").addEventListener("change", (e) => {
  showAllComuneLinks = e.target.checked;
  if (selectedProCom !== null) renderArcs(selectedProCom);
});

document.getElementById("showNodes").addEventListener("change", (e) => {
  showNodes = e.target.checked;
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

document.querySelectorAll('#directionToggle input[name="dir"]').forEach((input) => {
  input.addEventListener("change", (e) => {
    direction = e.target.value;
    if (selectedProCom !== null) renderArcs(selectedProCom);
  });
});

document.getElementById("showAllFlows").addEventListener("change", (e) => {
  showAllFlows = e.target.checked;
  resetGeoFilters();
  selectedProCom = null;
  updateFlowView();
});

function tryInitialRender() {
  if (dataLoaded && mapLoaded) updateFlowView();
}

function resetGeoFilters() {
  filterRegione.value = "";
  populateProvince(null);
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
});

filterComune.addEventListener("change", (e) => {
  if (!e.target.value) {
    selectedProCom = null;
    updateFlowView();
    return;
  }
  const proCom = Number(e.target.value);
  const pos = point(proCom);
  if (!pos) return;
  map.flyTo({ center: pos, zoom: Math.max(map.getZoom(), 10) });
  onComuneClick(proCom, nomeComune(proCom), pos);
});

// Scope attivo determinato dai select: comune > provincia > regione > vista globale (toggle).
function currentScope() {
  if (filterComune.value) return { type: "comune", id: Number(filterComune.value) };
  if (filterProvincia.value) return { type: "provincia", id: Number(filterProvincia.value) };
  if (filterRegione.value) return { type: "regione", id: Number(filterRegione.value) };
  return { type: "all" };
}

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
  const hint = showAllFlows ? "Clicca un comune per i dettagli." : "Clicca un comune sulla mappa.";
  if (showAllFlows) {
    renderAllFlows();
  } else {
    overlay.setProps({ layers: [] });
  }
  document.getElementById("panelBody").innerHTML = `
    <p id="panelEmpty">${hint}</p>
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
    <p class="hint">Positivo = polo lavoro (attrae); negativo = dormitorio (esporta forza lavoro).</p>
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
      return pos ? { position: pos, radius: bubbleRadius(t.out + t.in + t.self) } : null;
    })
    .filter(Boolean);
  const externalNodes = [...nodes.values()];

  const arcColor = (kind) => (kind === "out" ? [255, 68, 0] : kind === "in" ? [251, 235, 124] : [0, 0, 221]);

  overlay.setProps({
    layers: [
      new deck.ArcLayer({
        id: "flows-scope",
        data: arcs,
        pickable: true,
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
        visible: showNodes,
        getPosition: (d) => d.position,
        getRadius: (d) => d.radius,
        getFillColor: [61, 127, 255, 180],
        stroked: false,
        radiusUnits: "pixels",
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
    ],
  });
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

  overlay.setProps({
    layers: [
      new deck.ArcLayer({
        id: "flows",
        data: visibleArcs,
        pickable: true,
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
    ],
  });
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
      return pos ? { position: pos, radius: bubbleRadius(t.out + t.in + t.self) } : null;
    })
    .filter(Boolean);

  overlay.setProps({
    layers: [
      new deck.ArcLayer({
        id: "flows-all",
        data: arcs,
        pickable: true,
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
        visible: showNodes,
        getPosition: (d) => d.position,
        getRadius: (d) => d.radius,
        getFillColor: [61, 127, 255, 180],
        stroked: false,
        radiusUnits: "pixels",
      }),
    ],
  });
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
  showPopup(lngLat, `
    <strong>${esc(comuneName)}</strong>
    <p>Pendolari in uscita: ${fmt(totals.out)}</p>
    <p>Pendolari in entrata: ${fmt(totals.in)}</p>
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
  });
  map.on("mouseleave", "comuni-fill", () => {
    map.getCanvas().style.cursor = "";
    hoverTooltip.style.display = "none";
  });
  map.on("click", "comuni-fill", (e) => {
    const f = e.features[0];
    onComuneClick(f.properties.pro_com, f.properties.comune, e.lngLat);
  });
  mapLoaded = true;
  tryInitialRender();
});
