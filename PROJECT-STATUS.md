# Project status — Orders@ → Business Central automation

_Last updated: 2026-09-21_

## Recent changes (2026-09-21)
Live-backlog hardening from working real orders in the review app:
- **Forwarded-as-email POs handled** (ingestion) — senders like **Bunn** attach the PO as an *email*
  (Graph `itemAttachment`, message/rfc822) with the real PDF nested inside. `mailbox.js`
  (`fetchItemAttachmentFiles`, nested `$expand`) now recovers those PDFs so they reach extraction.
- **Thread merging** (`src/step5-review/thread-merge.js`) — a PO split across conversations (customer
  `Re:` + internal `FW:`) now merges into ONE card by subject keys (**BC/Q number** or a **guarded PO
  token**). **Cache-aware** (matches cards whose other half left the pull window; `fetchThreadByIds`).
  **ON** via `MERGE_THREADS=1`; free preview with `pipeline.js --merge-preview`. Caught 4 split POs
  (e.g. P/O 287921 — PO PDF + signed print were on separate cards).
- **Part-matching fallbacks** (verify.js, Rule 2) for messy part fields — **part-field prefix**
  (`HS3 M6 PROJECTION WELD NUT`→`HS3 M6`) and **description-anchored** (`RW2114OHIO`→`RW-2114` from the
  description). Both require a unique BC match. Recovered several backlog orders from review→order/quote.
- **Assign re-scans Rules 4 & 5** — changing a customer in the app (`/api/assign`) now updates the
  **Ship-To / Contact** panels for the new customer (previously left stale, so a matched customer could
  still show a red ship-to/contact from the pre-change verify).
- **Quantity-increment gate** (verify.js) — piece quantities must be whole multiples of **100** (fasteners
  ship in hundreds); a non-multiple (e.g. 120, 2120, 2150) routes the order to review. Tune/disable via
  `QTY_STEP`. (Applies only to piece quantities; non-piece UoM is already flagged separately.)

## Where we are
Working through the brief's build order. **Steps 1–3 done. Step 4 in progress:** BC connectivity
proven, live data-quality probe run, and a **read-only v1 verification gate (`verify.js`) works
end-to-end** against live BC (selftest: clean order → APPROVE-READY, bad line → FLAGGED).

| Step | What | Status |
|---|---|---|
| 1 | Pull real sample emails (all formats) | ✅ Done — **50 labeled samples** in `samples/` (29 order, 8 ambiguous, 13 not_order) |
| 2 | Test extraction accuracy in isolation | ✅ Done (initial) — 100% on the first 12 order samples (source-audited keys), ~$0.31/run. Harness in `src/step2-extraction/`. S24–S50 keys drafted (verified:false); re-run to score the larger set |
| 3 | Test order / not-order / unsure classification | ✅ Done — 92% (46/50); **order recall 100%, 0 missed orders**; errors only on not_order↔unsure boundary. Harness in `src/step3-classification/`, ~$0.41/run on Opus. Labels S24–S50 are drafted (verified:false) |
| 4 | Confirm BC prerequisites + build read-only verification checks | 🟡 In progress — connectivity proven (`ping.js`), data-quality probed (`data-quality.js`), **v1 rules cataloged (`VERIFICATION-RULES.md`) and running (`verify.js`)**. One BC-side blocker: Item Reference table not exposed (see below) |
| 5 | Review-queue web app (Teams tab) | 🟢 **LIVE end-to-end (v1).** `pipeline.js` pulls `order@` Inbox, groups messages into **threads by conversationId** (Inbox-only — reps reply from their own mailboxes, so Sent isn't captured), then classify→extract (**native PDF passthrough**)→verify, caching per-thread in `out/review-store.json` (incremental; **Sonnet 5** default). `server.js` serves the interactive page at `:8787`: **Approve = dry-run preview → inline confirm → guarded real create** to BC260TEST/Fasteners; created docs leave the queue, **deep-link to BC** (`BC_WEB_URL`), are **reconciled** (return to queue if the BC doc is deleted), and cards flag **PO-already-in-BC** + link the source PDF. `render.js` uses an **inline** confirm panel (native `confirm()` was auto-dismissed in some browsers). Proven live: created Sales Order 231177 (Mack Hils) + a Quote. **Still open:** no server **auth**; standalone Node now (IIS reverse proxy later — accepted on-prem, changeable); perf — `verifyOrder` re-pulls customers/items per call (slow preview), cache later |
| 6 | Order creation against BC sandbox | 🟡 **Write PROVEN incl. email number series** — `create.js` created Sales Order **S-ORD-EMAIL00001** in Fasteners from S01 (customer 91333700, PO 114543, `SN 1409`×11000 PCS, $697.40, open/not released) via the **EMAILORDER** service user. **Numbering decided: the `Email Order No. Series` AL subscriber** (BC stamps S-ORD-EMAIL/S-QUO-EMAIL for the EMAILORDER user and owns the sequence; regular series untouched). App-side manual-number path **removed** from create.js — it posts without a number. Dry-run default; write double-guarded (`--create`+`--company`). (The manual `--manual-number` path was tested/worked but is retired.) **Quote path also proven** — created **S-QUO-EMAIL00001** (Metal-Core 00017997, PO MCA025008, `BF W705182`×150000 PCS, $11,700). Both Order and Quote write correctly (quotes use `documentDate`, orders `orderDate`). **Duplicate-PO guard done** — pre-create check across orders/quotes/invoices for PO#+customer; refuses on `--create` unless `--allow-duplicate` (a PO+customer match can be a legit release order, so it's a refuse-by-default net; precise per-email dedup = message-id store at ingestion). Pending: **deploy the codeunit** (then Manual Nos. can go back OFF on the default series); UoM multiplier handling if non-EA units appear |
| 7 | Pilot with 1–2 reps | Later |

## Settled decisions
On-prem domain-joined VM next to BC · Node.js · **BC auth = NavUserPassword** (dedicated BC service
user + password over HTTPS; ⚠️ Web Service Access Keys are deprecated — earlier "WSAK" note was wrong;
SaaS migration ~Feb 2027 swaps this one layer to OAuth 2.0 S2S) · off-network access via GlobalProtect ·
no public BC exposure · Graph API for mailbox ingestion · decoupled stages · **shared review queue —
orders are NOT routed per salesperson** (so customer `salespersonCode` coverage is a non-issue) ·
**no auto-create: clean orders are staged approve-ready, a human always clicks Approve through rollout** ·
**mailbox is READ-ONLY — never mark-read / move / delete / flag the production `orders@` mailbox** (Graph
`Mail.Read.Shared` only). Consequence: the pipeline must track already-processed emails in its OWN state
store (keyed by Graph message-id), since we can't move or flag them to mark "done" ·
**scope = clean the PO + get it into BC as the right document** (NOT replicating the 10 ARC web-order
auto-release rules — those were reviewed and set aside). Two gates need a human: (1) customer not matched
with high certainty, (2) any line not resolved to a BC item. Otherwise **stock routes the document type:
all lines in stock → Order; any short line → whole PO as a Quote** (option A). Actual create stays a later,
human-approved, sandbox-first write.

## Recommended (not yet confirmed — decide at review-app stage)
- **Web app hosting:** IIS reverse proxy → standalone Node Windows service (not `iisnode`). Fallback: Node serves HTTPS directly.

## Open items / needed from Corey
Track A (live mailbox ingestion) — ✅ **LIVE.** Entra app registration created; `.env` `GRAPH_*` set;
`mailbox.js --check` green against **`order@buckeyefasteners.com`** (singular "order"). App-only `Mail.Read`
(application permission, admin-consented) — confirmed the right model for the unattended VM service.
- ⛔ **Application Access Policy NOT yet applied** — until it is, the app-only `Mail.Read` can read **every**
  mailbox in the tenant. Fence it to `order@` via Exchange Online PowerShell (New-ApplicationAccessPolicy;
  spec in `src/ingestion/README.md`). **Must do before pilot.** (Deliberately deferred to unblock testing.)
- ℹ️ Reps reply from their **own** mailboxes, not `order@`, so the shared mailbox's Sent Items has no rep
  side — the live app reads **Inbox only** and groups threads by `conversationId`.

Live review app (Step 5/6) — open before pilot:
- ⛔ **Server auth** — `server.js` has none yet (fine on the internal dev box; needed before reps use it).
- ⛔ **`EMAILORDER` No.-Series AL codeunit not deployed** — until the developer deploys it, BC assigns the
  **default** sales-order/quote series (created order 231177 got a default number, not S-ORD-EMAIL). App is
  correct (posts without a number; BC numbers it). No app change needed once the codeunit lands.
- 🟡 **Accuracy pass** on the live backlog not yet done (spot-checked only). Validate extractions/dispositions
  before pilot.
- 🟡 **Perf:** `verifyOrder` re-pulls all customers + item index on every call → multi-second preview/approve.
  Cache the customer/item data for the live app later.

BC-side items (some now confirmed from the live probe on 2026-09-17):
- ✅ BC connectivity confirmed — NavUserPassword auth works; OData API v2.0 published; read access on
  customers/items/salesOrders. `Fasteners` is the real production company (**9,379 customers**, 10,042 items).
- ✅ **Rule 2 cross-reference path built & working** — `verify.js` resolves customer part numbers via the
  live `Item_References_Excel` OData service (narrowed to the resolved customer), then checks inventory.
  Confirmed on real orders (e.g. S44 3/4 lines, S08 → APPROVE-READY). APPROVE-READY 8/29 and rising as
  Rule 1 / UoM are tuned. Remaining line gaps: unresolved customers, genuine stock-outs, and EA↔PCS UoM
  skips (a UoM synonym map is a Later item).
- ✅ **Rule 1 (customer match) tuned — 18/29 (62%) at higher precision.** Matcher is now token-based
  (whole words, not substrings): a candidate must contain ALL order name tokens, with abbreviation expansion
  (Mfg↔Manufacturing), plural stemming, country-word stripping, and a ship-to city/state tie-breaker.
  All knobs live in one `MATCH` config block in verify.js (rules expected to change → single edit point).
  Prefers to FLAG over mis-resolve: eliminated prior false positives (e.g. "Westwood…"→"ICA Corp") and
  giant tie-sets. Remaining flags are mostly correct (multi-location duplicates, not-in-BC, extraction gaps).
  Known limits: one subset false-positive (Big Bolt→Big D Bolt & Tool), and initials-only names (T/J) flag.
  Next tuning candidates: UoM synonym map (EA↔PCS), initials handling.
- ⚠️ **BC OData `$top` gotcha (bit us):** a small `$top` hard-caps the total AND suppresses `@odata.nextLink`,
  silently hiding the rest of a table. Always page via `nextLink` with no `$top`. (An earlier "only 1,000
  customers / looks like sandbox" reading was this bug, now fixed in verify.js + data-quality.js.)
- ✅ **RESOLVED — Item References are reachable now, no admin work.** Standard API v2.0 does not expose
  them (`itemReferences`/`itemCrossReferences` → 404; that's a missing *route*, not a permission issue —
  it 404s for admins too). BUT BC already publishes the **`Item_References_Excel` OData web service**
  (`/ODataV4/Company('Fasteners')/Item_References_Excel`): **44,720 customer-type refs** (customer part# →
  our item#), 1,093+ distinct customers. Fields: `Item_No, Reference_Type, Reference_Type_No` (customer #),
  `Reference_No` (customer's PN), `Unit_of_Measure`. Rule 2 cross-ref path can be built against this.
  Caveats: some customer refs have a blank customer number; a junk test row exists.
- Note: this endpoint is a **dev/test instance** (`BC260TEST` on `bp-nav-dev`, BC v26) holding a prod-like
  restore (9,379 customers) — good for read-testing.
- ℹ️ Resolved: **salesperson-code coverage is a non-issue** — only ~0.5% of active customers (43/9,283)
  carry a `salespersonCode`, but we route via a shared queue, not per salesperson. Dropped from scope.
- ℹ️ Noted: `inventory` is a FlowField — cannot be `$filter`ed server-side (HTTP 400); read the item and
  compare in code (verify.js already does this).
- A BC **sandbox/test company** for order-creation testing (never production first) — still needed for Step 6.

Backlog / future features (discussed, not started):
- **Item-level quote history / rate-shopping visibility.** Reps get burned by customers rate-shopping the
  same part across distributors. Idea: key a history by the **resolved BC item number** (verify.js already
  gives it per line) and show, on a quote, prior activity for that item. Two data sources, answering different
  questions: (1) **from our emails/store** — every thread that requested an item, which customer + when, with a
  link back to the source email/PDF (a rate-shop *demand* signal; cheap, data already captured; catches the
  same end-buyer shopping via different distributors even when their PNs differ); (2) **from BC** — the actual
  **quoted price** to other customers (authoritative), which likely needs a **published BC page/query for quote
  (+archived quote) lines**, same pattern as `Item_References_Excel`. ⚠️ Key gotcha: the price **we** quoted is
  NOT in the inbound email (customer is asking us to price) — it lives in BC (once a quote exists) or the rep's
  **Sent** reply (which we don't capture). Open Qs: show "who's asking" vs "what we quoted"; inline per-line vs
  a standalone item-history lookup; cross-customer price visibility is a business/policy call.

Optional / low-priority:
- Export **native binaries for S12 & S13** (scanned/mislabeled PDFs) to test the native-PDF path.
- Human spot-check of answer keys **S02 / S03** (AI-audited, not yet human-confirmed).
- Confirm confidence-display preference for "unsure" (raw score vs. binary flag) — can default for now.
