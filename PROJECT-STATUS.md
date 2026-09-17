# Project status — Orders@ → Business Central automation

_Last updated: 2026-09-17_

## Where we are
Working through the brief's build order. **Steps 1–2 done; Step 3 is next.**

| Step | What | Status |
|---|---|---|
| 1 | Pull real sample emails (all formats) | ✅ Done — **50 labeled samples** in `samples/` (29 order, 8 ambiguous, 13 not_order) |
| 2 | Test extraction accuracy in isolation | ✅ Done (initial) — 100% on the first 12 order samples (source-audited keys), ~$0.31/run. Harness in `src/step2-extraction/`. S24–S50 keys drafted (verified:false); re-run to score the larger set |
| 3 | Test order / not-order / unsure classification | ✅ Done — 92% (46/50); **order recall 100%, 0 missed orders**; errors only on not_order↔unsure boundary. Harness in `src/step3-classification/`, ~$0.41/run on Opus. Labels S24–S50 are drafted (verified:false) |
| 4 | Confirm BC prerequisites + build read-only verification checks | ⛔ Needs BC-side info (see below) |
| 5 | Review-queue web app (Teams tab) | Later |
| 6 | Order creation against BC sandbox | Later |
| 7 | Pilot with 1–2 reps | Later |

## Settled decisions
On-prem domain-joined VM next to BC · Node.js · BC auth = UserName + Web Service Access Key (Basic Auth) · off-network access via GlobalProtect · no public BC exposure · Graph API for mailbox ingestion · decoupled stages.

## Recommended (not yet confirmed — decide at review-app stage)
- **Web app hosting:** IIS reverse proxy → standalone Node Windows service (not `iisnode`). Fallback: Node serves HTTPS directly.

## Open items / needed from Corey
**To continue right now (Step 3): nothing — can start immediately.**

Needed to unblock later steps (worth starting in parallel; BC-side, lead time):
- Confirm BC Server has the `UserName` credential type enabled; create a dedicated BC service user + Web Service Access Key (read).
- Confirm OData v4 API (v2.0) web services are enabled/published on the BC Server.
- Data-quality checks: is the **Item Cross-Reference** table populated (customer part# → Buckeye item#)? Is the **salesperson code** filled in across active customers?
- A BC **sandbox/test company** for order-creation testing (never production first).

Optional / low-priority:
- Export **native binaries for S12 & S13** (scanned/mislabeled PDFs) to test the native-PDF path.
- Human spot-check of answer keys **S02 / S03** (AI-audited, not yet human-confirmed).
- Confirm confidence-display preference for "unsure" (raw score vs. binary flag) — can default for now.
