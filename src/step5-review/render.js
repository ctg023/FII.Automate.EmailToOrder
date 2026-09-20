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

const BADGE = {
  order: ['<span class="badge ok">→ ORDER</span>', "order"],
  quote: ['<span class="badge quote">→ QUOTE</span>', "quote"],
  review: ['<span class="badge warn">NEEDS REVIEW</span>', "review"],
};

// A single "did you mean" candidate button.
function suggestionBtn(s) {
  const bits = [`#${esc(s.number)}`];
  if (s.city) bits.push(esc([s.city, s.state].filter(Boolean).join(", ")));
  if (s.of) bits.push(`matches ${s.shared}/${s.of} words`);
  if (s.geo) bits.push("same city ✓");
  return `<button class="sugg"><b>${esc(s.displayName)}</b><span class="sm">${bits.join(" · ")}</span></button>`;
}

// One line-item check row (dot state from pass / rule2).
function lineRow(l) {
  const state = l.pass ? "ok" : "bad";
  const mark = l.pass ? "✓" : l.rule2 ? "✕" : "!";
  return `<div class="check">
      <span class="dot ${state}">${mark}</span>
      <div class="txt">
        <span class="k">${esc(l.label)}</span>
        <div class="sub">${esc(l.detail)}</div>
      </div></div>`;
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

// Warn when this PO already exists in BC (duplicate guard) so a rep doesn't re-key it.
function dupBlock(r) {
  if (!r.duplicates?.length) return "";
  const items = r.duplicates.map((d) => `${esc(d.ent)} ${esc(d.number)}${d.status ? ` (${esc(d.status)})` : ""}`).join(", ");
  return `<div class="dupe">⚠ Already in BC for this PO + customer: ${items}. Check before creating.</div>`;
}

// Links to the saved source PDF(s) so a rep can open the original document.
function attachBlock(r) {
  if (!r.attachments_saved?.length) return "";
  const links = r.attachments_saved.map((a) => `<a class="pdf-link" href="${esc(a.href)}" target="_blank" rel="noopener">📎 ${esc(a.name || "PDF")}</a>`).join(" ");
  return `<div class="sec">Source document</div><div class="pdfs">${links}</div>`;
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

export function card(r) {
  const [badge, cls] = BADGE[r.disposition] || BADGE.review;
  const custName = r.customer?.name || "—";
  const matched = r.rule1?.pass && r.rule1?.match;
  const custLine = matched
    ? `→ ${esc(r.rule1.match.displayName)} (#${esc(r.rule1.match.number)})`
    : `→ <i>unresolved — see suggestions below</i>`;
  const lineCount = (r.line_items || []).length;
  const custDot = r.rule1?.pass ? "ok" : "bad";
  const custMark = r.rule1?.pass ? "✓" : "✕";
  const custKey = r.rule1?.pass ? "Matched" : "Not matched with high certainty";

  const suggestions = r.rule1?.suggestions?.length
    ? `<div class="sec">Did you mean… (pick to assign the customer)</div>
    <div class="suggs">${r.rule1.suggestions.map(suggestionBtn).join("")}<button class="sugg new">＋ This is a new customer</button></div>`
    : "";

  const lineRows = lineCount
    ? (r.lines || []).map(lineRow).join("")
    : `<div class="check"><span class="dot bad">!</span><div class="txt"><span class="k">No line items extracted</span><div class="sub">Order body/attachment produced no lines — needs a rep.</div></div></div>`;

  return `<details class="card ${cls}" data-cid="${esc(r.conversationId || r.id)}">
    <summary class="row">
      ${badge}
      <div class="main">
        <div class="po">PO ${esc(r.po_number || "—")} · ${esc(custName)}</div>
        <div class="cust">${custLine}</div>
      </div>
      <div class="meta">${esc(r.order_date || "")}<br>${lineCount} line(s)</div>
      <span class="chev">▸</span>
    </summary>
    <div class="detail">
      <div class="disporeason">${esc(r.dispositionReason || "")}</div>
      ${dupBlock(r)}
      ${attachBlock(r)}
      ${conversationBlock(r)}
      <div class="sec">Customer match</div>
      <div class="check">
        <span class="dot ${custDot}">${custMark}</span>
        <div class="txt"><span class="k">${custKey}</span>
          <div class="sub">${esc(r.rule1?.detail || "")}</div></div>
      </div>
      ${suggestions}
      <div class="sec">Line items — part match &amp; stock</div>
      ${lineRows}
      <div class="actions">
        ${actions(r.disposition)}
      </div>
      <div class="result" hidden></div>
    </div>
  </details>`;
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
    --quote:#2563eb;--quote-bg:#e8effc;}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1319;--panel:#171c25;--ink:#e8ecf3;
    --muted:#9aa5b6;--line:#262d39;--accent:#3b82f6;--ok:#34d399;--ok-bg:#0f2a1f;--warn:#fbbf24;--warn-bg:#2a2110;--bad:#f87171;--chip:#222a36;
    --quote:#60a5fa;--quote-bg:#12233f;}}
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
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden}
  summary.row{display:flex;align-items:center;gap:12px;padding:13px 15px;cursor:pointer;list-style:none}
  summary.row::-webkit-details-marker{display:none}
  .badge{font-size:11px;font-weight:700;padding:4px 9px;border-radius:999px;white-space:nowrap}
  .badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.warn{background:var(--warn-bg);color:var(--warn)}
  .badge.quote{background:var(--quote-bg);color:var(--quote)}
  .stat.quote .n{color:var(--quote)}
  .btn.primary.quote{background:var(--quote);border-color:var(--quote)}
  .disporeason{font-size:12.5px;color:var(--muted);margin:-2px 0 6px;font-style:italic}
  .suggs{display:flex;flex-direction:column;gap:6px;margin:2px 0 6px}
  .sugg{display:flex;flex-direction:column;text-align:left;border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:8px 12px;cursor:pointer;color:var(--ink)}
  .sugg:hover{border-color:var(--accent)}
  .sugg b{font-size:13.5px}.sugg .sm{color:var(--muted);font-size:12px}
  .sugg.new{color:var(--accent);font-weight:600;flex-direction:row}
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
  code{background:var(--chip);padding:1px 5px;border-radius:5px;font-size:12.5px}</style></head><body><div class="wrap">
<header><h1>Order Review Queue</h1>
<p>${interactive ? "Live" : "Prototype"} · orders read from the <code>orders@</code> mailbox, extracted, and checked against Business Central. ${records.length} order(s) · generated ${esc(when)}.</p></header>
${interactive ? '<div class="topbar"><button class="refresh" onclick="refreshQueue()">↻ Check for new mail</button><span id="rmsg" class="sub"></span></div>' : ""}
<div class="banner"><b>Human-in-the-loop.</b><span>Nothing is written to BC without a rep's approval. Clean orders route to an <b>Order</b> (all in stock) or a <b>Quote</b> (some short); the rest need review. "Approve" here is a mock.</span></div>
<div class="stats">
  <div class="stat ok"><div class="n">${tally.order || 0}</div><div class="l">→ Create as Order</div></div>
  <div class="stat quote"><div class="n">${tally.quote || 0}</div><div class="l">→ Create as Quote</div></div>
  <div class="stat warn"><div class="n">${tally.review || 0}</div><div class="l">Needs review</div></div>
</div>
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
  const approve = e.target.closest('[data-act="approve"]');
  const confirmBtn = e.target.closest('[data-act="confirm-create"]');
  const cancelBtn = e.target.closest('[data-act="cancel-create"]');

  if(approve){
    const card = approve.closest('details[data-cid]'); const res = card.querySelector('.result');
    res.hidden=false; res.textContent='Building preview…';
    const pv = await post('/api/preview',{conversationId:card.dataset.cid});
    if(!pv.ok){ res.textContent='Cannot create: '+(pv.dispositionReason||pv.reason||'unknown'); return; }
    const hasDup = !!(pv.duplicates && pv.duplicates.length);
    const dupHtml = hasDup ? '<div class="dupe">⚠ Already in BC: '+pv.duplicates.map(d=>esc(d.ent)+' '+esc(d.number)).join(', ')+'</div>' : '';
    res.innerHTML = '<div class="confirm-box"><div><b>Review before creating</b></div>'
      + '<div class="sub">Create <b>'+esc(pv.docType.toUpperCase())+'</b> in '+esc(pv.company)+' · customer '+esc(pv.header.customerNumber)
      + ' · PO '+esc(pv.header.externalDocumentNumber||'-')+' · '+pv.lines.length+' line(s)</div>'
      + dupHtml
      + '<div class="cbtns"><button class="btn primary" data-act="confirm-create" data-dup="'+hasDup+'">Confirm — write to BC</button>'
      + '<button class="btn" data-act="cancel-create">Cancel</button></div></div>';
    return;
  }
  if(cancelBtn){ cancelBtn.closest('.result').textContent='Cancelled — nothing written.'; return; }
  if(confirmBtn){
    const card = confirmBtn.closest('details[data-cid]'); const res = card.querySelector('.result');
    res.innerHTML='Creating in BC…';
    const out = await post('/api/approve',{conversationId:card.dataset.cid, allowDuplicate: confirmBtn.dataset.dup==='true'});
    if(out.ok && out.created){
      res.innerHTML='✅ Created '+esc(out.docType)+' <b>'+esc(out.number)+'</b> in '+esc(out.company)+' (open, not released). You can close this.';
      card.classList.add('done'); const a=card.querySelector('[data-act="approve"]'); if(a) a.disabled=true;
    } else { res.textContent='Not created: '+(out.reason||'unknown'); }
    return;
  }
});
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
