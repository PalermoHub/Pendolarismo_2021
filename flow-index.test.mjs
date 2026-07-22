import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, topFlows } from "./js/flow-index.js";

test("buildIndex aggrega uscita, entrata e autocontenimento", () => {
  const flows = [
    [1, 1, 100],
    [1, 2, 50],
    [1, 3, 10],
    [2, 1, 5],
  ];
  const { byOrigin, byDest, totals } = buildIndex(flows);

  assert.deepEqual(byOrigin.get(1), [{ other: 2, val: 50 }, { other: 3, val: 10 }]);
  assert.deepEqual(byDest.get(1), [{ other: 2, val: 5 }]);
  assert.deepEqual(totals.get(1), { out: 60, in: 5, self: 100 });
  assert.deepEqual(totals.get(2), { out: 5, in: 50, self: 0 });
});

test("topFlows ordina desc, filtra per quota minima e limita il numero", () => {
  const list = [
    { other: 10, val: 1 },
    { other: 20, val: 50 },
    { other: 30, val: 49 },
  ];
  const result = topFlows(list, { totalForShare: 100, minShare: 0.1, max: 1 });
  assert.deepEqual(result, [{ other: 20, val: 50 }]);
});
