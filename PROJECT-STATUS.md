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
**no auto-create: clean orders are staged approve-ready, a human always clicks Approve through rollout.**

## Recommended (not yet confirmed — decide at review-app stage)
- **Web app hosting:** IIS reverse proxy → standalone Node Windows service (not `iisnode`). Fallback: Node serves HTTPS directly.

## Open items / needed from Corey
BC-side items (some now confirmed from the live probe on 2026-09-17):
- ✅ BC connectivity confirmed — NavUserPassword auth works; OData API v2.0 published; read access on
  customers/items/salesOrders. `Fasteners` is the real production company (**9,379 customers**, 10,042 items).
- ✅ **Rule 1 (customer match) validated on real data: 18/29 (62%)** resolved cleanly via `verify.js --batch`.
  The remaining 11: 3 extraction gaps (S12/S13/S35, no name), 1 genuinely new customer (Big Bolt), 5
  ambiguous ties that the matcher safely FLAGS instead of guessing, 1 abbreviation miss (Manufacturing↔Mfg),
  1 borderline. **Matcher tuning identified:** abbreviation normalization + secondary-signal (address/email)
  tie-breaker. No logic bug.
- ⚠️ **BC OData `$top` gotcha (bit us):** a small `$top` hard-caps the total AND suppresses `@odata.nextLink`,
  silently hiding the rest of a table. Always page via `nextLink` with no `$top`. (An earlier "only 1,000
  customers / looks like sandbox" reading was this bug, now fixed in verify.js + data-quality.js.)
- ⛔ **REQUIRED (blocks Rule 2 for customer part numbers):** expose the **Item Reference** table
  (customer part# → our item#). Standard API v2.0 does not expose it (`itemReferences`/
  `itemCrossReferences` → 404). Needs a small custom API page or OData query endpoint.
- ℹ️ Resolved: **salesperson-code coverage is a non-issue** — only ~0.5% of active customers (43/9,283)
  carry a `salespersonCode`, but we route via a shared queue, not per salesperson. Dropped from scope.
- ℹ️ Noted: `inventory` is a FlowField — cannot be `$filter`ed server-side (HTTP 400); read the item and
  compare in code (verify.js already does this).
- A BC **sandbox/test company** for order-creation testing (never production first) — still needed for Step 6.

Optional / low-priority:
- Export **native binaries for S12 & S13** (scanned/mislabeled PDFs) to test the native-PDF path.
- Human spot-check of answer keys **S02 / S03** (AI-audited, not yet human-confirmed).
- Confirm confidence-display preference for "unsure" (raw score vs. binary flag) — can default for now.
