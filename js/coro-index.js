// Metriche per comune derivate da flowIndex.totals ({out, in, self}) e dalla
// popolazione residente 2021. Restituisce null per un comune quando la metrica
// non è calcolabile (residenti=0 per autocontenimento; pop_res assente, es.
// Sardegna, per intensità), mai 0: 0 e "nessun dato" hanno significati diversi.
export function computeMetrics(totals, popRes) {
  const result = new Map();
  for (const [id, t] of totals) {
    const residenti = t.self + t.out;
    const autocontenimento = residenti > 0 ? (t.self / residenti) * 100 : null;
    const saldo = t.in - t.out;
    const pop = popRes[id] ?? popRes[String(id)];
    const intensita = pop > 0 ? (t.out / pop) * 100 : null;
    result.set(id, { autocontenimento, saldo, intensita });
  }
  return result;
}

// Breakpoint per classificazione a quantili: `classes - 1` valori che dividono
// l'array ordinato in `classes` gruppi di numerosità (circa) uguale.
export function quantileBreaks(values, classes = 5) {
  const sorted = [...values].sort((a, b) => a - b);
  const breaks = [];
  for (let k = 1; k < classes; k++) {
    breaks.push(sorted[Math.floor((sorted.length * k) / classes)]);
  }
  return breaks;
}

// Classe 0..breaks.length in base a quanti breakpoint il valore supera o eguaglia.
export function classify(value, breaks) {
  let cls = 0;
  for (const b of breaks) {
    if (value >= b) cls++;
  }
  return cls;
}

// Numero di comuni per ciascuna delle breaks.length+1 classi (i null, cioè
// "nessun dato", non vengono conteggiati qui: si contano a parte).
export function classCounts(metrics, metricKey, breaks) {
  const counts = new Array(breaks.length + 1).fill(0);
  for (const m of metrics.values()) {
    const v = m[metricKey];
    if (v === null) continue;
    counts[classify(v, breaks)]++;
  }
  return counts;
}

// Le n coppie {id, value} con valore più alto e più basso per la metrica data,
// esclusi i comuni senza dato (null).
export function topBottom(metrics, metricKey, n = 10) {
  const entries = [...metrics.entries()]
    .map(([id, m]) => ({ id, value: m[metricKey] }))
    .filter((d) => d.value !== null);
  const sorted = [...entries].sort((a, b) => b.value - a.value);
  return {
    top: sorted.slice(0, n),
    bottom: sorted.slice(-n).reverse(),
  };
}

// Angolo iniziale e ampiezza (in radianti) di ciascuna fetta di un donut chart,
// proporzionale al conteggio, in senso orario a partire da "ore 12" (-PI/2).
// Pura geometria: nessun conteggio -> sweep 0 per tutte le fette (nessuna crash su total=0).
export function donutSegments(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  let start = -Math.PI / 2;
  const segments = [];
  for (const n of counts) {
    const sweep = total > 0 ? (n / total) * 2 * Math.PI : 0;
    segments.push({ start, sweep });
    start += sweep;
  }
  return segments;
}
