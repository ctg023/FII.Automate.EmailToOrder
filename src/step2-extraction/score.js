// Transparent, field-level scoring of extracted output vs. a hand-drafted answer
// key. v1 focuses on the fields that matter for creating a BC order: PO number,
// customer, and per-line part / quantity / unit price. The report shows exactly
// what differed so we can improve the prompt — the number is a means, not the point.

const norm = (s) =>
  (s == null ? "" : String(s)).trim().toLowerCase().replace(/\s+/g, " ");

const strEq = (a, b) => norm(a) === norm(b);

// Identifier match (PO numbers): ignore all whitespace so "0054415 - 00" and
// "0054415-00" are equal. Internal spacing of an identifier isn't semantic.
const idEq = (a, b) => norm(a).replace(/\s+/g, "") === norm(b).replace(/\s+/g, "");

// Loose customer/name match: compare on alphanumerics only (company names vary
// in spacing/punctuation — "LaserCraft USA" vs "Laser Craft", "Alma Bolt Company
// (ABC Fastener Group Inc)" vs "Alma Bolt Company"). Exact, or one contains the
// other, with a length floor to avoid trivial substring matches.
function nameEq(a, b) {
  const x = norm(a).replace(/[^a-z0-9]/g, "");
  const y = norm(b).replace(/[^a-z0-9]/g, "");
  if (!x && !y) return true;
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  return short.length >= 4 && long.includes(short);
}

function numEq(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const diff = Math.abs(a - b);
  return diff <= Math.max(1e-4, Math.abs(b) * 0.001); // 0.1% tolerance for prices
}

// A part matches if either the customer or supplier part lines up with the
// expected one (customers vary in which they cite).
function partMatch(exp, act) {
  const expParts = [exp.customer_part, exp.supplier_part].filter(Boolean).map(norm);
  const actParts = [act.customer_part, act.supplier_part].filter(Boolean).map(norm);
  if (expParts.length === 0) return actParts.length === 0;
  return expParts.some((p) => actParts.some((q) => p === q || p.includes(q) || q.includes(p)));
}

export function scoreSample(expected, actual) {
  const checks = {};
  checks.po_number = idEq(expected.po_number, actual?.po_number);
  checks.customer_name = nameEq(expected.customer?.name, actual?.customer?.name);

  const expLines = expected.line_items || [];
  const actLines = actual?.line_items || [];
  checks.line_count = expLines.length === actLines.length;

  const lineResults = expLines.map((exp, i) => {
    const act = actLines[i] || {};
    const part = partMatch(exp, act);
    const qty = numEq(exp.quantity, act.quantity);
    const price = numEq(exp.unit_price, act.unit_price);
    return { line_no: exp.line_no ?? i + 1, part, quantity: qty, unit_price: price, ok: part && qty && price };
  });
  const lineAccuracy = lineResults.length
    ? lineResults.filter((l) => l.ok).length / lineResults.length
    : (actLines.length === 0 ? 1 : 0);

  // Overall = mean of the four pillars (PO, customer, line count, line accuracy)
  const pillars = [checks.po_number, checks.customer_name, checks.line_count, lineAccuracy].map((v) =>
    typeof v === "boolean" ? (v ? 1 : 0) : v,
  );
  const score = pillars.reduce((a, b) => a + b, 0) / pillars.length;

  return { checks, lineResults, lineAccuracy, expLineCount: expLines.length, actLineCount: actLines.length, score };
}

export function aggregate(results) {
  const scored = results.filter((r) => r.score != null);
  const mean = scored.length ? scored.reduce((a, r) => a + r.score, 0) / scored.length : 0;
  const poOk = scored.filter((r) => r.checks?.po_number).length;
  const custOk = scored.filter((r) => r.checks?.customer_name).length;
  const lineCountOk = scored.filter((r) => r.checks?.line_count).length;
  return { count: scored.length, meanScore: mean, poOk, custOk, lineCountOk };
}
