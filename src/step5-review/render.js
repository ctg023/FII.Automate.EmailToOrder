// Step 5 — review-queue renderer.
//
// Turns the structured verification output from Step 4 into the static review
// page a rep looks at: incoming orders grouped by disposition (Order / Quote /
// Needs review), each with its BC customer-match result, per-line part+stock
// checks, and — when the customer didn't resolve — a "Did you mean…" pick-list.
//
// This is READ-ONLY and offline: it renders JSON that `verify.js` already
// produced. It makes no BC or Claude calls. The buttons are a MOCK — this is a
// prototype of the review UI, not the live app; nothing is written to BC.
//
// PII: the rendered page embeds real customer/order data, so it is written to
// the git-ignored `out/` dir by default. Never commit the output.
//
// Pipeline:
//   1) NODE_OPTIONS=--use-system-ca node src/step4-bc-verification/verify.js \
//        --batch <dir-of-extracted-orders> --json out/verified.json
//   2) node src/step5-review/render.js --in out/verified.json --out out/review.html
//
// Usage:
//   node src/step5-review/render.js                       # in=out/verified.json, out=out/review.html
//   node src/step5-review/render.js --in <f> --out <f>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n = (x) => (x == null ? "" : Number(x).toLocaleString("en-US"));
const usd = (x) => (Number.isFinite(Number(x)) ? `$${Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");
const uprice = (x) => (Number.isFinite(Number(x)) ? `$${Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 5 })}` : "—"); // keep fastener precision

const BADGE = {
  order: ['<span class="badge ok">→ ORDER</span>', "order"],
  quote: ['<span class="badge quote">→ QUOTE</span>', "quote"],
  review: ['<span class="badge warn">NEEDS REVIEW</span>', "review"],
};

// "Action needed soon" detection — an explicit urgency term, or a stated deadline of
// ≤ 2 days (24h / 48h / 1–2 days / next-day / by tomorrow). Scans the email subject/body,
// notes and the CS-action reason. Pure render-time cue (no cost, backfills existing cards).
const URGENT_TERMS = /\b(asap|urgent(?:ly)?|immediate(?:ly)?|expedit\w*|rush|right\s+away|right\s+now|end\s+of\s+day|eod|by\s+(?:today|tomorrow|end\s+of\s+day))\b/i;
const URGENT_DEADLINE = /\bwithin\s+(?:24|48)\s*(?:hours?|hrs?)\b|\b(?:24|48)\s*(?:hours?|hrs?)\b|\bwithin\s+(?:1|2|one|two)\s+(?:business\s+)?days?\b|\b(?:1|2|one|two)\s+(?:business\s+)?days?\b|\bnext[-\s]?day\b|\bby\s+tomorrow\b/i;
// The full sentence around a match index, so the banner shows the customer's actual
// request ("Please confirm price and delivery within 24 hours") not just the keyword.
function sentenceAround(text, idx, matchLen, cap = 240) {
  const before = text.slice(0, idx);
  const start = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"),
    before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1;
  const rest = text.slice(idx + matchLen);
  const rel = rest.search(/[.!?\n\r]/);
  const end = rel === -1 ? text.length : idx + matchLen + rel + 1;
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (s.length > cap) s = s.slice(0, cap - 1).trimEnd() + "…";
  return s;
}
function urgencyOf(r) {
  const parts = [];
  for (const m of r.conversation || []) parts.push(m.subject || "", m.body_text || "");
  parts.push(r.special_instructions || "", r.service_action_reason || "");
  const text = parts.join("\n");
  const m = text.match(URGENT_TERMS) || text.match(URGENT_DEADLINE);
  if (!m) return null;
  const sentence = sentenceAround(text, m.index, m[0].length);
  return { hit: sentence || String(m[0]).replace(/\s+/g, " ").trim() };
}

// A single "did you mean" candidate button.
function suggestionBtn(s) {
  const bits = [`#${esc(s.number)}`];
  if (s.city) bits.push(esc([s.city, s.state].filter(Boolean).join(", ")));
  if (s.of) bits.push(`matches ${s.shared}/${s.of} words`);
  if (s.geo) bits.push("same city ✓");
  return `<button class="sugg" data-act="assign" data-cust="${esc(s.number)}" data-name="${esc(s.displayName)}"><b>${esc(s.displayName)}</b><span class="sm">${bits.join(" · ")}</span></button>`;
}

// One line-item check row. Green ✓ only when the line is genuinely ready: resolved,
// in stock, AND no blocking quantity/UoM problem. A resolved+in-stock line whose
// quantity isn't safe to create (not a multiple of 100, or a multiplier UoM) shows ✕.
function lineRow(l, poLine) {
  const ok = l.pass && !l.qtyFlag && !l.uomFlag && !l.priceFlag && !l.platingFlag && !l.blockedFlag && !l.bcPriceFlag;
  const state = ok ? "ok" : "bad";
  const mark = ok ? "✓" : l.rule2 ? "✕" : "!";
  const priceNote = l.priceNote ? `<div class="sub">${l.priceFlag ? "⚠ " : ""}${esc(l.priceNote)}</div>` : "";
  const bcPriceNote = l.bcPriceNote ? `<div class="sub">${l.bcPriceFlag ? "⚠ " : ""}${esc(l.bcPriceNote)}</div>` : "";
  const blockedNote = l.blockedFlag ? `<div class="sub" style="color:var(--bad);font-weight:600">⛔ Item ${esc(l.item || "")} is BLOCKED in BC — this line is excluded from the created doc.</div>` : "";
  // Per-location available stock (customer's ship-from location bold/starred = the one the gate uses).
  const locLine = (l.locStock && l.locStock.length)
    ? `<div class="locstock">Available — ${l.locStock.map((c) => `<span class="${c.loc === l.gateLoc ? "gateloc" : ""}">${esc(c.loc)}${c.loc === l.gateLoc ? "★" : ""}: ${n(c.avail)}</span>`).join(" · ")}</div>`
    : "";
  // The customer's price ON THE PO, shown prominently so a rep can confirm it (esp. when
  // the email says "confirm price"). "Our price" isn't reliably available pre-create; the
  // referenced-quote comparison (Rule 6) still appears above as priceNote when present.
  const num = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null); // NB: Number(null)===0, so guard first
  const price = poLine ? num(poLine.unit_price) : null;
  const qty = poLine ? num(poLine.quantity) : null;
  const ext = price != null && qty != null ? price * qty : (poLine ? num(poLine.line_total) : null);
  const priceLine = price != null
    ? `<div class="poprice">PO price: <b>${uprice(price)}</b>/ea${qty != null ? ` × ${n(qty)}` : ""}${ext != null ? ` = <b>${usd(ext)}</b>` : ""}</div>`
    : (poLine ? `<div class="poprice none">No price on the PO for this line</div>` : "");
  return `<div class="check">
      <span class="dot ${state}">${mark}</span>
      <div class="txt">
        <span class="k">${esc(l.label)}</span>
        <div class="sub">${esc(l.detail)}</div>
        ${locLine}
        ${priceLine}
        ${priceNote}
        ${bcPriceNote}
        ${blockedNote}
      </div></div>`;
}

// Order details: dates (order date, requested/ship) and any special instructions
// (highlighted so a rep can't miss them). When the PO states no requested date, BC gets
// today's order-entry date at creation (and the line Shipment Date matches) — so note that.
function orderDetailsBlock(r) {
  const req = r.requested_ship_date && String(r.requested_ship_date).trim();
  const reqShown = req || "order-entry date (today)";
  const reqNote = req ? "" : ` <span style="color:var(--muted)">(none on PO — today's date filled at creation; Shipment Date matches)</span>`;
  const si = r.special_instructions && String(r.special_instructions).trim();
  if (!r.order_date && !reqShown && !si) return "";
  return `<div class="sec">Order details</div>
    <div class="disporeason">Order date: <b>${esc(r.order_date || "—")}</b> · Requested/ship: <b>${esc(reqShown || "—")}</b>${reqNote}</div>
    ${si ? `<div class="dupe">✎ Special instructions: ${esc(si)}</div>` : ""}`;
}

// The email chain for a thread (live pipeline only): inbound customer mail +
// outbound rep replies, oldest first, so the rep sees the whole negotiation.
function conversationBlock(r) {
  if (!r.conversation?.length) return "";
  const rows = r.conversation.map((m) => {
    const who = m.direction === "outbound" ? "Buckeye →" : "→ customer";
    const body = esc((m.body_text || "").replace(/\s+/g, " ").slice(0, 600));
    return `<div class="msg ${m.direction === "outbound" ? "out" : "in"}">
        <div class="msg-h"><b>${esc(m.from || "")}</b> <span class="msg-dir">${who}</span>
          <span class="msg-when">${esc((m.received || "").slice(0, 16).replace("T", " "))}</span></div>
        <div class="msg-b">${body}${(m.body_text || "").length > 600 ? "…" : ""}</div>
      </div>`;
  }).join("");
  return `<div class="sec">Conversation (${r.conversation.length} message${r.conversation.length > 1 ? "s" : ""})</div>
    <div class="thread">${rows}</div>`;
}

// High-value second-approval requirement and/or blocked-line exclusions — surfaced at
// the top of the card so a rep sees the hold before doing anything. The sign-off itself
// is collected in the Approve confirm panel (driven by the live preview response).
function holdBlock(r) {
  const bits = [];
  if (r.requiresApproval && r.approvalReason) bits.push(`⚠ ${esc(r.approvalReason)}`);
  if (r.blockedLines?.length) {
    const items = r.blockedLines.map((b) => esc(b.item)).join(", ");
    bits.push(`⛔ ${r.blockedLines.length} line(s) blocked in BC (${items}) — excluded from the created doc; the rest can still be created.`);
  }
  return bits.length ? `<div class="dupe">${bits.join("<br>")}</div>` : "";
}

// Customer Blocked (credit-hold) review label.
function customerBlockedBlock(r) {
  const b = r.customerBlocked;
  if (!b) return "";
  return `<div class="dupe">🚫 Customer is BLOCKED in BC (${esc(b.code)} — credit hold). Do not create without clearing it.</div>`;
}

// Payment-terms / payment-method review label (prepay terms, or term+fee method).
function paymentBlock(r) {
  const p = r.paymentReview;
  if (!p || !p.review) return "";
  const tags = [p.isPrepay ? "PREPAY TERMS" : null, p.isTermsFee ? "TERM + FEE" : null].filter(Boolean).join(" · ");
  return `<div class="dupe">💳 ${tags} — ${esc(p.reason)}</div>`;
}

// Special instructions that GATE the order to review (genuine CS action needed). The
// routine acknowledge/confirm ask doesn't gate and isn't shown here — it still appears as
// context in the order-details "Special instructions" line.
function serviceBlock(r) {
  if (!r.serviceReview?.required) return "";
  const label = r.serviceReview.reason || "special instructions need customer-service action";
  const why = (r.service_action_reason || "").trim();
  return `<div class="dupe">📣 ${esc(label)}${why ? `: “${esc(why)}”` : ""}</div>`;
}

// Warn when this PO already exists in BC (duplicate guard) so a rep doesn't re-key it.
function dupBlock(r) {
  if (!r.duplicates?.length) return "";
  const items = r.duplicates.map((d) => `${esc(d.ent)} ${esc(d.number)}${d.status ? ` (${esc(d.status)})` : ""}`).join(", ");
  return `<div class="dupe">⚠ Already in BC for this PO + customer: ${items}. Check before creating.</div>`;
}

// Links to the saved source PDF(s) so a rep can open the original document.
function attachBlock(r) {
  if (!r.attachments_saved?.length) return "";
  const links = r.attachments_saved.map((a) => `<a class="pdf-link" data-act="open-pdf" data-path="${esc(a.href)}" href="${esc(a.href)}" target="_blank" rel="noopener">📎 ${esc(a.name || "PDF")}</a>`).join(" ");
  return `<div class="sec">Source document</div><div class="pdfs">${links}</div>`;
}

// Ship-to and contact validation results (Rules 4 & 5), shown when they were checked.
// The Ship-to row carries a "change" link that opens a picker of the customer's on-file
// ship-to addresses (loaded live from BC) so a rep can fix a ship-to that didn't match.
function shipContactBlock(r) {
  if (!r.shipTo && !r.contact) return "";
  const canPick = !!r.rule1?.pass; // need a resolved customer to list ship-tos for
  const shipRow = r.shipTo
    ? `<div class="check"><span class="dot ${r.shipTo.pass ? "ok" : "bad"}">${r.shipTo.pass ? "✓" : "✕"}</span>
        <div class="txt"><span class="k">Ship-to</span>
          <div class="sub">${esc(r.shipTo.detail || "")}${canPick ? ` <button class="changelink" data-act="change-shipto">change</button>` : ""}</div>
          ${canPick ? `<div class="shipfix" hidden><div class="csresults suggs"></div></div>` : ""}
        </div></div>`
    : "";
  const contactRow = r.contact
    ? `<div class="check"><span class="dot ${r.contact.pass ? "ok" : "bad"}">${r.contact.pass ? "✓" : "✕"}</span>
        <div class="txt"><span class="k">Contact / email</span><div class="sub">${esc(r.contact.detail || "")}</div></div></div>`
    : "";
  return `<div class="sec">Ship-to &amp; contact</div>${shipRow}${contactRow}`;
}

// The action row differs by disposition; buttons are a mock (no handlers).
function actions(disp) {
  if (disp === "order")
    return `<button class="btn primary" data-act="approve">Approve &amp; create Order</button>
        <button class="btn">Assign to me</button>`;
  if (disp === "quote")
    return `<button class="btn primary quote" data-act="approve">Approve &amp; create Quote</button>
        <button class="btn">Assign to me</button>`;
  return `<button class="btn" disabled>Resolve to continue</button>
        <button class="btn">Assign to me</button>`;
}

// The set of filter facets a card belongs to (disposition + each issue type present).
// A card can carry several — it shows under every matching filter chip.
function cardFacets(r) {
  const f = new Set();
  if (r.disposition) f.add(r.disposition); // order | quote | review
  if (!r.rule1?.pass) f.add("customer");
  if (r.shipTo && !r.shipTo.pass) f.add("shipto");
  if (r.contact && !r.contact.pass) f.add("contact");
  if (!(r.line_items || []).length) f.add("item");
  if ((r.lines || []).some((l) => !l.rule2 || l.blockedFlag || l.uomFlag || l.qtyFlag || l.platingFlag)) f.add("item");
  if ((r.lines || []).some((l) => l.priceFlag || l.bcPriceFlag)) f.add("price");
  if (r.paymentReview?.review) f.add("payment");
  if (r.customerBlocked) f.add("blocked");
  if (r.requiresApproval) f.add("highvalue");
  if (r.serviceReview?.required) f.add("special");
  if (urgencyOf(r)) f.add("urgent");
  return [...f];
}
const FILTERS = [
  ["all", "All"], ["order", "Order"], ["quote", "Quote"], ["review", "Needs review"],
  ["customer", "Customer"], ["shipto", "Ship-to"], ["item", "Item/part"], ["price", "Price"],
  ["payment", "Payment"], ["blocked", "Cust. blocked"], ["highvalue", "Over $5k"],
  ["special", "Special instr."], ["contact", "Contact"], ["urgent", "Urgent"],
];

export function card(r) {
  let [badge, cls] = BADGE[r.disposition] || BADGE.review;
  // A creatable (order/quote) PO that needs a second sign-off reads as a review state.
  if (r.requiresApproval && r.disposition !== "review") {
    badge = '<span class="badge warn">REVIEW · 2ND SIGN-OFF</span>'; cls = "review";
  }
  const custName = r.customer?.name || "—";
  const matched = r.rule1?.pass && r.rule1?.match;
  const custLine = matched
    ? `→ ${esc(r.rule1.match.displayName)} (#${esc(r.rule1.match.number)})`
    : `→ <i>unresolved — see suggestions below</i>`;
  const lineCount = (r.line_items || []).length;
  const custDot = r.rule1?.pass ? "ok" : "bad";
  const custMark = r.rule1?.pass ? "✓" : "✕";
  const custKey = r.rule1?.pass ? "Matched" : "Not matched with high certainty";

  // Customer fix-up UI (ranked suggestions + live BC search + "new customer").
  // Shown open when the customer didn't resolve; hidden behind a "change" link on a
  // matched card so a WRONG auto-match can be corrected too. Every pick teaches the
  // alias, so the same customer resolves itself next time.
  const fixInner = `${r.rule1?.suggestions?.length ? `<div class="suggs">${r.rule1.suggestions.map(suggestionBtn).join("")}</div>` : ""}
    <div class="custsearch"><input class="csi" type="text" placeholder="search BC customers by name…" autocomplete="off"><div class="csresults suggs"></div></div>
    <button class="sugg new" data-act="new-customer">＋ This is a new customer</button>`;
  const customerFix = r.rule1
    ? `<div class="custfix"${matched ? " hidden" : ""}>
      <div class="sec">${matched ? "Reassign to a different customer" : "Assign customer (pick a suggestion or search)"}</div>
      ${fixInner}</div>`
    : "";

  const lineRows = lineCount
    ? (r.lines || []).map((l, i) => lineRow(l, r.line_items?.[i])).join("")
    : `<div class="check"><span class="dot bad">!</span><div class="txt"><span class="k">No line items extracted</span><div class="sub">Order body/attachment produced no lines — needs a rep.</div></div></div>`;

  const urgent = urgencyOf(r);
  const urgentBanner = urgent ? `<div class="urgentbar">⏱ Action needed soon${urgent.hit ? ` — “${esc(urgent.hit)}”` : ""}</div>` : "";

  return `<details class="card ${cls}${urgent ? " urgent" : ""}" data-cid="${esc(r.conversationId || r.id)}" data-facets="${cardFacets(r).join(" ")}">
    <summary class="row">
      ${badge}${urgent ? '<span class="badge soon">⏱ SOON</span>' : ""}
      <div class="main">
        <div class="po">PO ${esc(r.po_number || "—")} · ${esc(custName)}</div>
        <div class="cust">${custLine}</div>
      </div>
      <div class="meta">${esc(r.order_date || "")}<br>${lineCount} line(s)</div>
      <span class="chev">▸</span>
    </summary>
    <div class="detail">
      ${urgentBanner}
      <div class="disporeason">${esc(r.dispositionReason || "")}</div>
      ${customerBlockedBlock(r)}
      ${serviceBlock(r)}
      ${paymentBlock(r)}
      ${holdBlock(r)}
      ${orderDetailsBlock(r)}
      ${dupBlock(r)}
      ${attachBlock(r)}
      ${conversationBlock(r)}
      <div class="sec">Customer match</div>
      <div class="check">
        <span class="dot ${custDot}">${custMark}</span>
        <div class="txt"><span class="k">${custKey}</span>
          <div class="sub">${esc(r.rule1?.detail || "")}${matched ? ` <button class="changelink" data-act="change-customer">change</button>` : ""}</div></div>
      </div>
      ${customerFix}
      ${shipContactBlock(r)}
      <div class="sec">Line items — part match, stock &amp; PO price</div>
      ${lineRows}
      ${Number.isFinite(Number(r.orderTotal)) ? `<div class="pototal">PO total (from line prices): <b>${usd(r.orderTotal)}</b></div>` : ""}
      <div class="actions">
        ${actions(r.disposition)}
      </div>
      <div class="result" hidden></div>
    </div>
  </details>`;
}

// Created orders whose acknowledgement email failed to send — a rep can resend each.
function needsAckBlock(needsAck) {
  if (!needsAck || !needsAck.length) return "";
  const rows = needsAck.map((r) => {
    const who = r.rule1?.match?.displayName || r.customer?.name || "—";
    const num = r.bc_number ? `${esc(r.bc_docType === "quote" ? "Quote" : "Order")} ${esc(r.bc_number)}` : "";
    return `<div class="ackrow" data-cid="${esc(r.conversationId || r.id)}">
      <div class="g"><b>PO ${esc(r.po_number || "—")}</b> · ${esc(who)} · ${num}
        <div class="sub">not sent — ${esc(r.ack?.reason || "unknown")}${r.customer?.contact_email ? ` · to ${esc(r.customer.contact_email)}` : ""}</div></div>
      <button class="btn primary sm" data-act="resend-ack">Resend</button></div>`;
  }).join("");
  return `<div class="ackbox"><h3>⚠ ${needsAck.length} order(s) need acknowledgement — email didn't send</h3>${rows}</div>`;
}

// Filter chips (client-side) with a live count per facet. Chips with 0 are dimmed.
function filterBar(records) {
  const counts = { all: records.length };
  for (const r of records) for (const f of cardFacets(r)) counts[f] = (counts[f] || 0) + 1;
  const chips = FILTERS.map(([k, label]) => {
    const c = counts[k] || 0;
    return `<button class="chip${k === "all" ? " active" : ""}${c === 0 && k !== "all" ? " zero" : ""}" data-filter="${k}">${esc(label)} <span class="c">${c}</span></button>`;
  }).join("");
  return `<div class="filterbar">${chips}</div>`;
}

export function page(data, opts = {}) {
  const records = data.records || [];
  const interactive = !!opts.interactive; // served by the live server: wire the buttons
  const tally = data.tally || records.reduce((t, r) => ((t[r.disposition] = (t[r.disposition] || 0) + 1), t), {});
  const when = data.generated ? new Date(data.generated).toLocaleString("en-US") : new Date().toLocaleString("en-US");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Order Review Queue</title>
<style>
  :root{--bg:#f4f5f7;--panel:#fff;--ink:#1c2230;--muted:#606a7b;--line:#e4e8ef;--accent:#2563eb;
    --ok:#16a34a;--ok-bg:#e9f8ef;--warn:#b45309;--warn-bg:#fdf3e3;--bad:#dc2626;--chip:#eef1f6;
    --quote:#2563eb;--quote-bg:#e8effc;--urgent-bg:#fdecec;--urgent-bd:#f0b4b4;}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1319;--panel:#171c25;--ink:#e8ecf3;
    --muted:#9aa5b6;--line:#262d39;--accent:#3b82f6;--ok:#34d399;--ok-bg:#0f2a1f;--warn:#fbbf24;--warn-bg:#2a2110;--bad:#f87171;--chip:#222a36;
    --quote:#60a5fa;--quote-bg:#12233f;--urgent-bg:#2a1517;--urgent-bd:#5c2b2b;}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:20px 16px 80px}
  header h1{margin:0 0 2px;font-size:22px} header p{margin:0;color:var(--muted);font-size:13px}
  .banner{display:flex;gap:10px;align-items:center;background:var(--warn-bg);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:16px 0;font-size:13.5px}
  .banner b{color:var(--warn)}
  .stats{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}
  .stat{flex:1;min-width:130px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
  .stat .n{font-size:26px;font-weight:700}.stat .l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .stat.ok .n{color:var(--ok)}.stat.warn .n{color:var(--warn)}
  .stat[data-filter]{cursor:pointer}.stat.active{outline:2px solid var(--accent);outline-offset:-1px}
  .filterbar{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0}
  .chip{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:5px 12px;font-size:12.5px;cursor:pointer}
  .chip:hover{border-color:var(--accent)}
  .chip.active{background:var(--accent);color:#fff;border-color:var(--accent)}
  .chip .c{opacity:.65;font-variant-numeric:tabular-nums}
  .chip.zero{opacity:.4}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden}
  summary.row{display:flex;align-items:center;gap:12px;padding:13px 15px;cursor:pointer;list-style:none}
  summary.row::-webkit-details-marker{display:none}
  .badge{font-size:11px;font-weight:700;padding:4px 9px;border-radius:999px;white-space:nowrap}
  .badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.warn{background:var(--warn-bg);color:var(--warn)}
  .badge.quote{background:var(--quote-bg);color:var(--quote)}
  .badge.soon{background:var(--bad);color:#fff}
  .card.urgent{background:var(--urgent-bg);border-color:var(--urgent-bd)}
  .urgentbar{background:var(--bad);color:#fff;border-radius:8px;padding:7px 11px;font-size:12.5px;font-weight:600;margin:0 0 8px}
  .locstock{font-size:12.5px;margin-top:3px;color:var(--muted);font-variant-numeric:tabular-nums}
  .locstock .gateloc{color:var(--ink);font-weight:700}
  .poprice{font-size:13px;margin-top:3px;font-variant-numeric:tabular-nums}
  .poprice.none{color:var(--muted);font-style:italic}
  .pototal{margin-top:8px;font-size:13.5px;text-align:right;font-variant-numeric:tabular-nums}
  .stat.quote .n{color:var(--quote)}
  .btn.primary.quote{background:var(--quote);border-color:var(--quote)}
  .disporeason{font-size:12.5px;color:var(--muted);margin:-2px 0 6px;font-style:italic}
  .suggs{display:flex;flex-direction:column;gap:6px;margin:2px 0 6px}
  .sugg{display:flex;flex-direction:column;text-align:left;border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:8px 12px;cursor:pointer;color:var(--ink)}
  .sugg:hover{border-color:var(--accent)}
  .sugg b{font-size:13.5px}.sugg .sm{color:var(--muted);font-size:12px}
  .sugg.new{color:var(--accent);font-weight:600;flex-direction:row}
  .custsearch{margin:2px 0 6px}
  .csi{width:100%;padding:8px 11px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:13px}
  .csi:focus{outline:none;border-color:var(--accent)}
  .csresults{margin-top:6px}.csresults:empty{margin:0}
  .changelink{border:none;background:none;color:var(--accent);cursor:pointer;font:inherit;font-size:12px;padding:0 0 0 6px;text-decoration:underline}
  .main{flex:1;min-width:0}.po{font-weight:650}
  .cust{color:var(--muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .meta{color:var(--muted);font-size:12px;text-align:right;white-space:nowrap}
  .chev{color:var(--muted);transition:transform .15s}.card[open] .chev{transform:rotate(90deg)}
  .detail{border-top:1px solid var(--line);padding:14px 15px}
  .check{display:flex;gap:9px;padding:7px 0;border-bottom:1px dashed var(--line);font-size:13.5px}.check:last-of-type{border-bottom:0}
  .dot{margin-top:2px;flex:none;width:16px;height:16px;border-radius:50%;font-size:11px;line-height:16px;text-align:center;color:#fff}
  .dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
  .txt{flex:1}.txt .k{font-weight:600}.sub{color:var(--muted);font-size:12.5px}.part{font-variant-numeric:tabular-nums}
  .sec{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:12px 0 4px}
  .actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
  .btn{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
  .btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}.btn.primary:disabled{opacity:.4;cursor:not-allowed}
  .btn.ghost{background:transparent}
  .thread{display:flex;flex-direction:column;gap:6px;margin:2px 0 4px}
  .msg{border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:12.5px;background:var(--panel)}
  .msg.out{border-left:3px solid var(--accent)}.msg.in{border-left:3px solid var(--ok)}
  .msg-h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
  .msg-dir{font-size:11px;color:var(--muted)}.msg-when{margin-left:auto;color:var(--muted);font-size:11px}
  .msg-b{color:var(--muted);margin-top:3px;line-height:1.45}
  .dupe{background:var(--warn-bg);color:var(--warn);border:1px solid var(--line);border-radius:8px;padding:8px 11px;font-size:12.5px;font-weight:600;margin:4px 0}
  .pdfs{display:flex;gap:8px;flex-wrap:wrap}
  .pdf-link{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:8px;padding:5px 10px;font-size:12.5px;text-decoration:none;color:var(--accent);background:var(--panel)}
  .pdf-link:hover{border-color:var(--accent)}
  .result{margin-top:10px;font-size:13px;padding:9px 12px;border-radius:8px;background:var(--chip)}
  .confirm-box{display:flex;flex-direction:column;gap:8px}
  .cbtns{display:flex;gap:8px;margin-top:2px}
  .card.done{opacity:.6}.card.done .badge{filter:grayscale(1)}
  .refresh{margin-left:auto;font:inherit;font-size:13px;font-weight:600;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:6px 13px;cursor:pointer}
  .refresh:hover{border-color:var(--accent)} .topbar{display:flex;align-items:center;gap:10px;margin-top:8px}
  .ackbox{background:var(--warn-bg);border:1px solid var(--urgent-bd);border-radius:12px;padding:12px 14px;margin:16px 0}
  .ackbox h3{margin:0 0 8px;font-size:14px;color:var(--warn)}
  .ackrow{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px dashed var(--line);font-size:13px}
  .ackrow:first-of-type{border-top:0}.ackrow .g{flex:1;min-width:0}
  .ackrow .g .sub{color:var(--muted);font-size:12px}
  .btn.sm{padding:5px 11px;font-size:12.5px}
  code{background:var(--chip);padding:1px 5px;border-radius:5px;font-size:12.5px}</style></head><body><div class="wrap">
<header><h1>Order Review Queue</h1>
<p>${interactive ? "Live" : "Prototype"} · orders read from the <code>orders@</code> mailbox, extracted, and checked against Business Central. ${records.length} order(s) · generated ${esc(when)}.</p></header>
${interactive ? '<div class="topbar"><button class="refresh" onclick="refreshQueue()">↻ Check for new mail</button><span id="rmsg" class="sub"></span></div>' : ""}
<div class="banner"><b>Human-in-the-loop.</b><span>Nothing is written to BC without a rep's approval. Clean orders route to an <b>Order</b> (all in stock) or a <b>Quote</b> (some short); the rest need review. "Approve" here is a mock.</span></div>
<div class="stats">
  <div class="stat ok" data-filter="order"><div class="n">${tally.order || 0}</div><div class="l">→ Create as Order</div></div>
  <div class="stat quote" data-filter="quote"><div class="n">${tally.quote || 0}</div><div class="l">→ Create as Quote</div></div>
  <div class="stat warn" data-filter="review"><div class="n">${tally.review || 0}</div><div class="l">Needs review</div></div>
</div>
${filterBar(records)}
${needsAckBlock(data.needsAck)}
${records.map(card).join("\n")}
</div>
${interactive ? CLIENT_SCRIPT : ""}
</body></html>`;
}

// Client-side wiring for the served (interactive) page. Approve is two-step:
// dry-run preview -> INLINE confirm panel -> real create. (No window.confirm — some
// embedded browsers auto-dismiss it, which silently cancelled the write.) Refresh
// re-runs the pipeline.
const CLIENT_SCRIPT = `<script>
async function post(url, body){ const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}); return r.json(); }
function esc(s){ return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
async function refreshQueue(){ const m=document.getElementById('rmsg'); m.textContent=' checking…';
  try{ const r=await post('/api/refresh'); m.textContent=' '+(r.message||'done')+' — reloading…'; setTimeout(()=>location.reload(),700);}catch(e){ m.textContent=' refresh failed'; } }
document.addEventListener('click', async (e)=>{
  const openPdf = e.target.closest('[data-act="open-pdf"]');
  if(openPdf){
    e.preventDefault();
    const card = openPdf.closest('details[data-cid]'); const res = card ? card.querySelector('.result') : null;
    const name = openPdf.textContent.replace(/^[^A-Za-z0-9]*/,'').trim() || 'PDF';
    if(res){ res.hidden=false; res.textContent='Opening '+name+' in your default PDF viewer…'; }
    try{ const r = await post('/api/open-pdf',{path:openPdf.dataset.path});
      if(r.ok){ if(res) res.textContent='Opened '+name+' in your default PDF viewer.'; }
      else if(res){ res.textContent='Could not open PDF: '+(r.reason||'unknown'); }
    }catch(err){ if(res) res.textContent='Could not open PDF.'; }
    return;
  }
  const resend = e.target.closest('[data-act="resend-ack"]');
  if(resend){
    const row = resend.closest('.ackrow'); const cid = row.dataset.cid;
    resend.disabled=true; resend.textContent='Sending…';
    const out = await post('/api/resend-ack',{conversationId:cid});
    if(out.ok && out.sent){ row.innerHTML='<div class="g"><b>✅ Acknowledgement sent</b><div class="sub">to '+esc(out.to||'')+'</div></div>'; }
    else { resend.disabled=false; resend.textContent='Resend'; const s=row.querySelector('.sub'); if(s) s.textContent='still not sent — '+esc(out.reason||'unknown'); }
    return;
  }
  const approve = e.target.closest('[data-act="approve"]');
  const confirmBtn = e.target.closest('[data-act="confirm-create"]');
  const cancelBtn = e.target.closest('[data-act="cancel-create"]');
  const assign = e.target.closest('[data-act="assign"]');
  const newCust = e.target.closest('[data-act="new-customer"]');
  const change = e.target.closest('[data-act="change-customer"]');

  if(change){ const p = change.closest('details[data-cid]').querySelector('.custfix'); if(p){ p.hidden=!p.hidden; if(!p.hidden){ const i=p.querySelector('.csi'); if(i) i.focus(); } } return; }

  const changeShip = e.target.closest('[data-act="change-shipto"]');
  if(changeShip){
    const card = changeShip.closest('details[data-cid]'); const box = card.querySelector('.shipfix'); if(!box) return;
    box.hidden = !box.hidden; if(box.hidden) return;
    const list = box.querySelector('.csresults'); list.innerHTML = '<div class="sm" style="color:var(--muted);font-size:12px">loading ship-to addresses…</div>';
    try{
      const j = await (await fetch('/api/shiptos?conversationId='+encodeURIComponent(card.dataset.cid))).json();
      if(!j.ok || !j.results || !j.results.length){ list.innerHTML='<div class="sm" style="color:var(--muted);font-size:12px">no ship-to addresses on file for this customer</div>'; return; }
      list.innerHTML = j.results.map(s=>'<button class="sugg" data-act="assign-shipto" data-code="'+esc(s.code)+'"><b>'+esc(s.code)+' — '+esc(s.name||'')+'</b><span class="sm">'+esc([s.address,s.city,s.state,s.postalCode].filter(Boolean).join(', '))+'</span></button>').join('');
    }catch(err){ list.innerHTML='<div class="sm">could not load ship-to addresses</div>'; }
    return;
  }
  const assignShip = e.target.closest('[data-act="assign-shipto"]');
  if(assignShip){
    const card = assignShip.closest('details[data-cid]'); const res = card.querySelector('.result');
    res.hidden=false; res.textContent='Setting ship-to '+assignShip.dataset.code+' and re-checking…';
    const out = await post('/api/assign-shipto',{conversationId:card.dataset.cid, code:assignShip.dataset.code});
    if(out.ok){ res.textContent='Ship-to set → '+out.disposition+'. Reloading…'; setTimeout(()=>location.reload(),700); }
    else res.textContent='Ship-to assign failed: '+(out.reason||'unknown');
    return;
  }

  if(assign){
    const card = assign.closest('details[data-cid]'); const res = card.querySelector('.result');
    res.hidden=false; res.textContent='Assigning '+assign.dataset.name+' and re-checking against BC…';
    const out = await post('/api/assign',{conversationId:card.dataset.cid, customerNumber:assign.dataset.cust, customerName:assign.dataset.name});
    if(out.ok){ res.textContent='Assigned to '+assign.dataset.name+' → '+out.disposition+'. Reloading…'; setTimeout(()=>location.reload(),700); }
    else res.textContent='Assign failed: '+(out.reason||'unknown');
    return;
  }
  if(newCust){
    const res = newCust.closest('details[data-cid]').querySelector('.result');
    res.hidden=false; res.textContent='Marked NEW customer — create the customer in BC first, then re-check here. (Not auto-created.)';
    return;
  }

  if(approve){
    const card = approve.closest('details[data-cid]'); const res = card.querySelector('.result');
    res.hidden=false; res.textContent='Building preview…';
    const pv = await post('/api/preview',{conversationId:card.dataset.cid});
    if(!pv.ok){ res.textContent='Cannot create: '+(pv.dispositionReason||pv.reason||'unknown'); return; }
    const hasDup = !!(pv.duplicates && pv.duplicates.length);
    const dupHtml = hasDup ? '<div class="dupe">⚠ Already in BC: '+pv.duplicates.map(d=>esc(d.ent)+' '+esc(d.number)).join(', ')+'</div>' : '';
    const blockedHtml = (pv.blockedLines && pv.blockedLines.length) ? '<div class="dupe">⛔ '+pv.blockedLines.length+' blocked line(s) excluded: '+pv.blockedLines.map(b=>esc(b.item)).join(', ')+'</div>' : '';
    const needAppr = !!pv.requiresApproval;
    const apprHtml = needAppr
      ? '<div class="sub" style="color:var(--warn);font-weight:600">⚠ '+esc(pv.approvalReason||'A second approver must sign off before creating.')+'</div>'
        + '<input class="approver" type="text" placeholder="Second approver — name or initials" autocomplete="off" style="width:100%;padding:8px 11px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:13px">'
      : '';
    res.innerHTML = '<div class="confirm-box"><div><b>Review before creating</b></div>'
      + '<div class="sub">Create <b>'+esc(pv.docType.toUpperCase())+'</b> in '+esc(pv.company)+' · customer '+esc(pv.header.customerNumber)
      + ' · PO '+esc(pv.header.externalDocumentNumber||'-')+' · '+pv.lines.length+' line(s) to create</div>'
      + dupHtml + blockedHtml + apprHtml
      + '<div class="cbtns"><button class="btn primary" data-act="confirm-create" data-dup="'+hasDup+'" data-need-appr="'+needAppr+'"'+(needAppr?' disabled':'')+'>Confirm — write to BC</button>'
      + '<button class="btn" data-act="cancel-create">Cancel</button></div></div>';
    return;
  }
  if(cancelBtn){ cancelBtn.closest('.result').textContent='Cancelled — nothing written.'; return; }
  if(confirmBtn){
    const card = confirmBtn.closest('details[data-cid]'); const res = card.querySelector('.result');
    const apprInput = res.querySelector('.approver');
    const approver = apprInput ? apprInput.value.trim() : '';
    if(confirmBtn.dataset.needAppr==='true' && !approver){ return; } // guarded — button is disabled until filled
    res.innerHTML='Creating in BC…';
    const out = await post('/api/approve',{conversationId:card.dataset.cid, allowDuplicate: confirmBtn.dataset.dup==='true', approver: approver||undefined});
    if(out.ok && out.created){
      const num = out.url ? '<a href="'+out.url+'" target="_blank" rel="noopener"><b>'+esc(out.number)+'</b></a>' : '<b>'+esc(out.number)+'</b>';
      let ackLine = '';
      if(out.ack){ ackLine = out.ack.sent
        ? '<div class="sub">✉ Acknowledgement sent to '+esc(out.ack.to)+'.</div>'
        : '<div class="sub">✉ Acknowledgement composed'+(out.ack.to?' for '+esc(out.ack.to):'')+' — not sent ('+esc(out.ack.reason||'')+').</div>'; }
      res.innerHTML='✅ Created '+esc(out.docType)+' '+num+' in '+esc(out.company)+' (open, not released). You can close this.'+ackLine;
      card.classList.add('done'); const a=card.querySelector('[data-act="approve"]'); if(a) a.disabled=true;
    } else { res.textContent='Not created: '+(out.reason||'unknown'); }
    return;
  }
});
let csTimer;
document.addEventListener('input', (e)=>{
  const appr = e.target.closest('.approver');
  if(appr){ const box=appr.closest('.confirm-box'); const btn=box&&box.querySelector('[data-act="confirm-create"]'); if(btn) btn.disabled = appr.value.trim().length===0; return; }
  const inp = e.target.closest('.csi'); if(!inp) return;
  const box = inp.closest('.custsearch').querySelector('.csresults');
  const q = inp.value.trim();
  clearTimeout(csTimer);
  if(q.length < 2){ box.innerHTML=''; return; }
  csTimer = setTimeout(async ()=>{
    box.innerHTML = '<div class="sm" style="color:var(--muted);font-size:12px">searching…</div>';
    try{
      const j = await (await fetch('/api/search-customers?q='+encodeURIComponent(q))).json();
      if(!j.ok || !j.results){ box.innerHTML='<div class="sm">search failed</div>'; return; }
      if(!j.results.length){ box.innerHTML='<div class="sm" style="color:var(--muted);font-size:12px">no matches</div>'; return; }
      box.innerHTML = j.results.map(c=>'<button class="sugg" data-act="assign" data-cust="'+esc(c.number)+'" data-name="'+esc(c.displayName).replace(/"/g,'&quot;')+'"><b>'+esc(c.displayName)+'</b><span class="sm">#'+esc(c.number)+(c.city?' · '+esc(c.city):'')+(c.state?', '+esc(c.state):'')+'</span></button>').join('');
    }catch(err){ box.innerHTML='<div class="sm">search error</div>'; }
  }, 300);
});
// Queue filter: chips + clickable stat tiles show/hide cards by facet. Single-select;
// remembered across reloads (the app reloads after actions) via localStorage.
function applyFilter(key){
  document.querySelectorAll('[data-filter]').forEach(el=>el.classList.toggle('active', el.dataset.filter===key));
  document.querySelectorAll('details.card').forEach(card=>{
    const fac=(card.dataset.facets||'').split(' ');
    card.style.display=(key==='all'||fac.indexOf(key)>=0)?'':'none';
  });
  try{ localStorage.setItem('queueFilter', key); }catch(e){}
}
document.addEventListener('click',(e)=>{ const f=e.target.closest('[data-filter]'); if(f) applyFilter(f.dataset.filter); });
try{ const saved=localStorage.getItem('queueFilter'); if(saved && saved!=='all' && document.querySelector('[data-filter="'+saved+'"]')) applyFilter(saved); }catch(e){}
</script>`;

function main() {
  const args = process.argv.slice(2);
  const inFlag = args.indexOf("--in");
  const outFlag = args.indexOf("--out");
  const inPath = inFlag !== -1 ? args[inFlag + 1] : "out/verified.json";
  const outPath = outFlag !== -1 ? args[outFlag + 1] : "out/review.html";

  let data;
  try {
    data = JSON.parse(readFileSync(inPath, "utf8"));
  } catch (e) {
    console.error(`Could not read verification JSON at "${inPath}".`);
    console.error("Produce it first with:");
    console.error("  NODE_OPTIONS=--use-system-ca node src/step4-bc-verification/verify.js --batch <dir> --json " + inPath);
    process.exit(1);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, page(data));
  const t = data.tally || {};
  console.log(`Rendered ${(data.records || []).length} order(s) -> ${outPath}`);
  console.log(`  Order ${t.order || 0} · Quote ${t.quote || 0} · Needs review ${t.review || 0}`);
  console.log("  (Prototype — buttons are a mock; contains customer PII, keep in out/ and out of git.)");
}

// Only run the CLI when executed directly; importing (e.g. from pipeline.js) does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
