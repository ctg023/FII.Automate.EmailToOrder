// Scoring for Step 3: predicted label vs. the answer key's classification.
// Ground-truth "ambiguous" maps to the model's "unsure".
const LABELS = ["order", "not_order", "unsure"];

export function truthLabel(answerKey) {
  const c = answerKey?.classification;
  return c === "ambiguous" ? "unsure" : c; // order | not_order | unsure
}

export function scoreOne(answerKey, predicted) {
  const truth = truthLabel(answerKey);
  return { truth, predicted, correct: truth === predicted };
}

export function aggregate(results) {
  const scored = results.filter((r) => r.truth && r.predicted);
  const correct = scored.filter((r) => r.correct).length;

  // Confusion matrix: matrix[truth][predicted]
  const matrix = {};
  for (const t of LABELS) { matrix[t] = {}; for (const p of LABELS) matrix[t][p] = 0; }
  for (const r of scored) if (matrix[r.truth] && r.predicted in matrix[r.truth]) matrix[r.truth][r.predicted]++;

  // Per-class recall (of the true X, how many labeled X)
  const perClass = {};
  for (const t of LABELS) {
    const total = LABELS.reduce((a, p) => a + matrix[t][p], 0);
    perClass[t] = { total, correct: matrix[t][t], recall: total ? matrix[t][t] / total : null };
  }

  // The costly error to watch: a real order mislabeled not_order (a dropped order).
  const missedOrders = scored.filter((r) => r.truth === "order" && r.predicted === "not_order").length;

  return {
    count: scored.length,
    correct,
    accuracy: scored.length ? correct / scored.length : 0,
    matrix, perClass, missedOrders, labels: LABELS,
  };
}

export function printMatrix(matrix, labels) {
  const head = "truth\\pred".padEnd(11) + labels.map((l) => l.padStart(10)).join("");
  const rows = labels.map((t) => t.padEnd(11) + labels.map((p) => String(matrix[t][p]).padStart(10)).join(""));
  return [head, ...rows].join("\n");
}
