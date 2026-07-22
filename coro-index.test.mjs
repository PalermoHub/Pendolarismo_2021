import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, quantileBreaks, classify, classCounts, topBottom, donutSegments } from "./js/coro-index.js";

test("computeMetrics: autocontenimento, saldo, intensita per comune", () => {
  const totals = new Map([
    [1, { out: 40, in: 10, self: 60 }],   // residenti = 100, autocont = 60%
    [2, { out: 5, in: 30, self: 0 }],     // residenti = 5, autocont = 0%
  ]);
  const popRes = { "1": 1000, "2": 500 };
  const result = computeMetrics(totals, popRes);

  assert.equal(result.get(1).autocontenimento, 60);
  assert.equal(result.get(1).saldo, 10 - 40);
  assert.equal(result.get(1).intensita, (40 / 1000) * 100);

  assert.equal(result.get(2).autocontenimento, 0);
  assert.equal(result.get(2).saldo, 30 - 5);
  assert.equal(result.get(2).intensita, (5 / 500) * 100);
});

test("computeMetrics: nessun dato quando residenti=0 o popRes assente", () => {
  const totals = new Map([
    [3, { out: 0, in: 20, self: 0 }],   // residenti = 0 -> autocontenimento null
    [4, { out: 8, in: 0, self: 2 }],    // popRes assente -> intensita null
  ]);
  const popRes = { "3": 200 };
  const result = computeMetrics(totals, popRes);

  assert.equal(result.get(3).autocontenimento, null);
  assert.equal(result.get(4).intensita, null);
});

test("quantileBreaks: 5 classi su 10 valori ordinati", () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const breaks = quantileBreaks(values, 5);
  assert.deepEqual(breaks, [30, 50, 70, 90]);
});

test("classify: assegna la classe in base ai breakpoint", () => {
  const breaks = [30, 50, 70, 90];
  assert.equal(classify(10, breaks), 0);
  assert.equal(classify(30, breaks), 1);
  assert.equal(classify(49, breaks), 1);
  assert.equal(classify(90, breaks), 4);
  assert.equal(classify(150, breaks), 4);
});

test("classCounts: conta i comuni per ciascuna delle 5 classi, ignora i null", () => {
  const metrics = new Map([
    [1, { autocontenimento: 10 }],
    [2, { autocontenimento: 35 }],
    [3, { autocontenimento: 35 }],
    [4, { autocontenimento: null }],
    [5, { autocontenimento: 95 }],
  ]);
  const breaks = [30, 50, 70, 90];
  const counts = classCounts(metrics, "autocontenimento", breaks);
  assert.deepEqual(counts, [1, 2, 0, 0, 1]);
});

test("topBottom: prime e ultime N per valore, esclude i null", () => {
  const metrics = new Map([
    [1, { saldo: 100 }],
    [2, { saldo: -50 }],
    [3, { saldo: null }],
    [4, { saldo: 0 }],
    [5, { saldo: 40 }],
  ]);
  const { top, bottom } = topBottom(metrics, "saldo", 2);
  assert.deepEqual(top, [{ id: 1, value: 100 }, { id: 5, value: 40 }]);
  assert.deepEqual(bottom, [{ id: 2, value: -50 }, { id: 4, value: 0 }]);
});

test("donutSegments: angoli proporzionali ai conteggi, partono da -PI/2 in senso orario", () => {
  const segments = donutSegments([1, 1, 2]); // totale 4: 1/4, 1/4, 1/2 di giro
  assert.equal(segments[0].start, -Math.PI / 2);
  assert.ok(Math.abs(segments[0].sweep - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(segments[1].start - 0) < 1e-9);
  assert.ok(Math.abs(segments[1].sweep - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(segments[2].start - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(segments[2].sweep - Math.PI) < 1e-9);
});

test("donutSegments: totale zero produce sweep tutti nulli, nessun crash", () => {
  const segments = donutSegments([0, 0, 0]);
  assert.deepEqual(segments.map((s) => s.sweep), [0, 0, 0]);
});
