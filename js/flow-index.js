export function buildIndex(flows) {
  const byOrigin = new Map();
  const byDest = new Map();
  const totals = new Map();

  const ensureTotal = (id) => {
    if (!totals.has(id)) totals.set(id, { out: 0, in: 0, self: 0 });
    return totals.get(id);
  };

  for (const [res, lav, val] of flows) {
    if (res === lav) {
      ensureTotal(res).self += val;
      continue;
    }
    if (!byOrigin.has(res)) byOrigin.set(res, []);
    byOrigin.get(res).push({ other: lav, val });
    ensureTotal(res).out += val;

    if (!byDest.has(lav)) byDest.set(lav, []);
    byDest.get(lav).push({ other: res, val });
    ensureTotal(lav).in += val;
  }

  return { byOrigin, byDest, totals };
}

export function topFlows(list, { totalForShare, minShare = 0.01, max = 25 }) {
  return list
    .filter((d) => d.val / totalForShare >= minShare)
    .sort((a, b) => b.val - a.val)
    .slice(0, max);
}
