# Project status — Orders@ → Business Central automation

_Last updated: 2026-09-17_

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
| 5 | Review-queue web app (Teams tab) | Later |
| 6 | Order creation against BC sandbox | Later |
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

Optional / low-priority:
- Export **native binaries for S12 & S13** (scanned/mislabeled PDFs) to test the native-PDF path.
- Human spot-check of answer keys **S02 / S03** (AI-audited, not yet human-confirmed).
- Confirm confidence-display preference for "unsure" (raw score vs. binary flag) — can default for now.
