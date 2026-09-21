# CLAUDE.md — project guide for Claude Code sessions

Keep this current. It's the fast-start context for anyone (human or Claude) picking up this project.
Detailed live status is in [PROJECT-STATUS.md](PROJECT-STATUS.md).

## What this is
An internal tool that reads incoming **order emails** from a shared `orders@` mailbox, extracts the
order, checks it against **Business Central**, and lets a sales rep **approve** each one before it's
created in BC. Goal: cut manual order entry for ~10 reps while keeping a human in the loop.

**A human approves every order before it is created in BC. No auto-create — ever, at least through rollout.**

## Status (2026-09-21)
See [PROJECT-STATUS.md](PROJECT-STATUS.md) for the authoritative, detailed status — keep that current too.
- **Step 1 (sample set):** done — 50 labeled sample emails in `samples/` (29 order, 8 ambiguous, 13 not_order).
- **Step 2 (extraction):** done — harness in `src/step2-extraction/`; ~100% on order content. Now also sends
  **native PDF bytes** as document blocks (`buildMessageContent`), so real/scanned PDFs are read directly.
- **Step 3 (classification):** done — harness in `src/step3-classification/`; 92%, **0 dropped orders**.
- **Step 4 (BC verification):** done (read-only) — `src/step4-bc-verification/verify.js` assigns a
  **disposition** (Order / Quote / Needs-review). Rules: **1** customer name match · **2** line items
  (direct / cross-ref via `Item_References_Excel`, then two fallbacks for messy part fields —
  **part-field prefix**: real part + crammed description words, e.g. `HS3 M6 PROJECTION WELD NUT`→`HS3 M6`;
  and **description-anchored**: clean part in the description when the part field carries a tag, e.g.
  `RW2114OHIO`→`RW-2114`; both require a unique BC match) · **3** stock · **4** ship-to matches a `ShipTo` on file
  (hard gate) · **5** contact/email matches a Person contact under the customer's company contact
  (`Contact`/`ContactBusinessRelation`; **informational unless `CONTACT_GATE=1`**) · **6** price matches the
  **referenced BC quote** — extract the **BC/Q #** from the subject, look up `salesQuotes`(number)→lines, and
  compare each item's `unitPrice` to the PO's (exact by default; `PRICE_TOL` per-unit $ tolerance); mismatch →
  review. ⚠️ Many referenced quotes live in **production**, not BC260TEST (its quotes are header-only), so the
  price check **validates against prod** — in test it reports "quote not in this company" and does not gate.
  Also gates: non-piece **UoM** (100PACK/M/C → review), **piece quantity not a multiple of 100** (fasteners
  ship in hundreds; e.g. 2120/2150 → review, tune/disable via `QTY_STEP`), and **multi-PO-in-one-email** →
  review. `--batch <dir> --json <out>` emits records.
- **Step 5 (review app):** **LIVE, end-to-end.**
  - `pipeline.js` — live runner: pulls `order@` Inbox, groups messages into **threads by conversationId**
    (Inbox-only — reps reply from their own mailboxes, so Sent isn't captured), classify→extract(w/ PDFs)→
    verify, **incremental cache** in `out/review-store.json`. Model defaults to **Sonnet 5**. Non-orders hidden.
  - **Thread merging** (`src/step5-review/thread-merge.js`): one PO's paperwork often arrives under multiple
    conversationIds (customer `Re:` + internal `FW:`). Merges them into ONE card by subject keys (**BC/Q number**
    or a **guarded PO token**), keeping the thread shape so downstream is unchanged. **Cache-aware** — matches a
    fresh thread against cached cards whose other half scrolled out of the pull window (`fetchThreadByIds`).
    **ON** via `MERGE_THREADS=1` in `.env`; preview (no changes) with `pipeline.js --merge-preview`.
  - `render.js` — renders the queue; interactive mode wires the buttons.
  - `server.js` — Node service serving the live page. **Approve = dry-run preview → INLINE confirm →
    guarded create** to BC260TEST/Fasteners (writes a real Sales Order/Quote). Created docs are marked
    actioned (leave the queue), **deep-link back to BC** (needs `BC_WEB_URL`), and are **reconciled** — if the
    BC doc is later deleted the order returns to the queue. Cards flag **PO-already-in-BC** and link the source PDF.
  - **Customer fix-up:** unmatched (or wrong) customers get suggestions + a **BC customer search** + a
    **change** link on matched cards; every pick is saved as a **learned alias** (`src/step5-review/aliases.js`,
    `data/`, keyed by email domain + name) consulted *before* name-matching, so recurring customers stop
    needing review. Created orders set the matched **ship-to address + contact** on the BC doc. Changing the
    customer (`/api/assign`) **re-scans Rules 4 & 5** and updates the Ship-To / Contact panels for the new customer.
  - Commands: `pipeline.js --run` (process new mail) · `--merge-preview` (show split-PO merges, free) ·
    `--reverify` (re-apply rules to cache, no Claude) · `--enrich` (dup-check + save PDFs) · `--reconcile` ·
    `--rerender`. `server.js` serves the app.
- **Step 6 (order creation):** write **proven** — `src/step6-order-creation/create.js`; `createDoc()` is the
  programmatic path the server calls. Dry-run default; guarded real write. ⚠️ BC assigns a **default** number
  series until the `EMAILORDER` No.-Series **AL codeunit is deployed** (developer task — then S-ORD-EMAIL/S-QUO-EMAIL).
- **Ingestion (Track A):** **LIVE** — Entra app + `.env` done; `mailbox.js --check` green; reads
  `order@buckeyefasteners.com` (singular). Handles **forwarded-as-email POs** (e.g. Bunn) — a Graph
  `itemAttachment` (message/rfc822) whose real PDF is nested one level down is pulled via a nested `$expand`
  (`fetchItemAttachmentFiles`), so those PDFs reach extraction. ⚠️ **Application Access Policy fence NOT yet
  applied** (app can read ALL mailboxes) — must do before pilot.
- Accuracy pass **done** (found+fixed UoM, multi-PO, PDF-folder collision). Live backlog processed (full 188
  Inbox → ~85 real orders). **Open decisions:** (1) enable `CONTACT_GATE=1`? (works now; email match needs
  prod) (2) build the **mailbox move-on-approve** cleanup (needs `Mail.ReadWrite`)? (3) server **auth**,
  mailbox **Access Policy fence**, deploy the **EMAILORDER codeunit** — all before pilot. Backlog idea:
  item-level quote history / rate-shopping (see PROJECT-STATUS).

## Stack & architecture
- **Node.js (ESM)** throughout. No build step; run `.js` directly with `node`.
- **Decoupled stages** (ingest → classify → extract → verify → review → create) so the BC layer can be
  swapped at the future SaaS migration without rebuilding the rest.
- **Hosting:** on-prem, domain-joined Windows VM next to the BC server. Outbound HTTPS only (Graph, Claude);
  no inbound BC exposure. Off-network reps reach the review app via existing GlobalProtect.
  *Recommended (not yet confirmed):* IIS reverse proxy → a standalone Node Windows service (NOT `iisnode`).

## Repo layout
```
src/ingestion/            # mailbox.js = read-only Graph pull from orders@ (Track A)
src/step2-extraction/     # extraction harness (schema.js, extract.js, score.js, run.js)
src/step3-classification/ # order/not_order/unsure classifier (same shape)
src/step4-bc-verification/# ping.js (connectivity), data-quality.js, verify.js (read-only rules + disposition)
src/step5-review/         # LIVE review app: pipeline.js (ingest→classify→extract→verify→cache),
                          #   render.js (page), server.js (serves page + approve/preview/refresh endpoints),
                          #   thread-merge.js (fold split-PO threads into one card; MERGE_THREADS=1)
src/step6-order-creation/ # create.js = BC Sales Order / Quote write; createDoc()/docExists() exported for server
bc-extension/             # AL codeunit + README for the EMAILORDER number series (developer handoff)
docs/                     # Email-Order-Review-Guide.pdf (rep-facing user guide)
data/                     # git-ignored: learned customer aliases (PII)
samples/                  # test set. README + extraction-schema.json are committed;
                          #   raw/, answer-keys/, manifest.csv, FINDINGS.md are git-ignored (customer data)
out/                      # git-ignored render/verify output (contains PII) — e.g. verified.json, review.html
.env                      # secrets (git-ignored). Copy from .env.example
PROJECT-STATUS.md         # living status + open items
```

## Running the harnesses
This machine's shell is **PowerShell**. On this network set the corporate-CA option once per
session with `$env:NODE_OPTIONS="--use-system-ca"` (see gotchas), then run node normally.
```powershell
npm install
$env:NODE_OPTIONS = "--use-system-ca"                 # once per terminal (corporate TLS)
node src/step2-extraction/run.js --list               # what's testable (free)
node src/step2-extraction/run.js --estimate --all     # token/cost estimate only (free)
node src/step2-extraction/run.js --sample S03         # run ONE (safe default)
node src/step2-extraction/run.js --all                # run all, then --rescore is free
node src/step3-classification/run.js --all            # classifier
node src/step4-bc-verification/ping.js                # BC read-only smoke test (needs BC_* in .env)
# Sample-set review page (read-only): verify the sample orders, then render.
node src/step4-bc-verification/verify.js --batch samples/answer-keys --json out/verified.json
node src/step5-review/render.js --in out/verified.json --out out/review.html
# LIVE review app (reads order@; writes to BC only on human Approve):
node src/step5-review/pipeline.js --threads              # FREE: pull + group live threads
node src/step5-review/pipeline.js --merge-preview        # FREE: show which split-PO threads would merge
node src/step5-review/pipeline.js --estimate --limit 3   # cost projection for new threads
node src/step5-review/pipeline.js --run [--limit N]      # classify+extract+verify new threads (Sonnet)
node src/step5-review/pipeline.js --reconcile            # return BC-deleted orders to the queue
node src/step5-review/server.js                          # serve interactive app at http://localhost:8787
```
The server needs `BC_*` (+ `BC_WEB_URL` for deep links) and `$env:NODE_OPTIONS`. Approve does a dry-run
preview then a guarded write to `BC_COMPANY` (BC260TEST/Fasteners). It runs as a standalone Node service;
IIS reverse proxy sits in front later (accepted on-prem, changeable). **No server auth yet.**
(Bash/CI equivalent for the env var: prefix a command with `NODE_OPTIONS=--use-system-ca node ...`.)
Guardrail: harnesses run nothing without an explicit `--sample`/`--all`/`--estimate` flag.
Reminder: `create.js --create` (Step 6) is the only thing that WRITES to BC; the review pipeline never does.

## Conventions
- **Claude API:** `@anthropic-ai/sdk`, `client.messages.parse()` with **Zod v4** structured output
  (`import { z } from "zod/v4"` — the SDK's `zodOutputFormat` needs v4).
- **Default model `claude-opus-5`**, overridable per run: `MODEL=claude-sonnet-5 node ...` (extraction/
  classification are good cheaper-model candidates — the user's call, not an automatic downgrade).
- **API key must be workspace-scoped** (Anthropic Console "Buckeye Auto Order" workspace). If an org key is
  used instead, set `ANTHROPIC_WORKSPACE_ID`. Key lives in `.env`.
- Cost discipline: estimate first (`--estimate`), run one sample before `--all`, print $ after each run.

## Environment gotchas (must persist on the VM too)
- **Corporate TLS inspection** breaks npm, Claude API, and BC calls with `SELF_SIGNED_CERT_IN_CHAIN`.
  Fix: run Node with **`NODE_OPTIONS=--use-system-ca`** (trusts the Windows/corporate CA), or set it as a
  machine env var. `npm config`/git also need the corporate CA (git: `http.sslBackend schannel`).
- **Secrets in `.env` only** (git-ignored). Never commit keys/passwords.

## Key decisions & corrections
- **BC auth = `NavUserPassword`** (dedicated BC service user + password over HTTPS) for **on-prem now**.
  ⚠️ Web Service Access Keys / basic-auth access keys are **deprecated — do not use** (an earlier plan
  said WSAK; that was wrong). When the company moves to BC **SaaS (~Feb 2027)** this one auth layer swaps
  to **OAuth 2.0 Service-to-Service** (Entra app registration). Don't build OAuth now.
- BC API: standard **OData v4 / API v2.0** endpoints, read-only for verification; order creation later, sandbox first.
- **Mailbox** is the Exchange Online shared mailbox **`order@buckeyefasteners.com`** (singular "order"),
  read via **Microsoft Graph, app-only `Mail.Read`** (application permission, admin-consented) — a dedicated
  Entra app registration for the unattended VM service (NOT delegated `Mail.Read.Shared`). Entra app + `.env`
  `GRAPH_*` are set and working. ⚠️ **Application Access Policy to fence the app to `order@` is NOT yet applied**
  (until it is, the app can read every mailbox in the tenant) — do before pilot. See `src/ingestion/README.md`.
- **BC write target** for the live app = **BC260TEST / `Fasteners`** (`BC_COMPANY`), a dev/test instance —
  never production first. `BC_WEB_URL` (browser base URL) drives the review app's deep links back to BC.
  ⚠️ **BC260TEST has contact emails SCRUBBED** to `navl@buckeyefasteners.com`; **production has the real
  buyer emails.** So Rule 5 matches by **name** in test, by **email** in prod — validate email matching only
  against prod.
- **BC OData services used** (classic `/ODataV4`, published pages — NOT standard API v2.0):
  `Item_References_Excel` (customer part → item), `ShipTo` (Customer_No + Code + address), `Contact` +
  `ContactBusinessRelation`. **Customers' buyers are Person `Contact`s linked by `Company_No`** to the
  customer's company contact (found via `ContactBusinessRelation`). Order creation uses standard API v2.0.
- **Mailbox cleanup is the primary goal** (reps spend all day managing `order@`). Plan (decided, NOT built):
  on **Approve→create**, move that thread's emails to an **"Entered in BC"** folder; leave everything else for
  reps. Needs **`Mail.ReadWrite`** (escalation from `Mail.Read`) + the Access Policy fence FIRST. This flips the
  "mailbox is read-only" rule — update it if/when built. Pending/handled-outside-app emails still need a plan
  (a manual "File/Close" action + an aging view).
- **BC AL codeunit for numbering** is drafted for the developer in `bc-extension/` (EMAILORDER No. Series);
  not yet deployed. A rep-facing **user guide PDF** is in `docs/Email-Order-Review-Guide.pdf`.

## Data & integration notes
- The M365 Graph connector returns attachment **extracted text, not native files**; **scanned or
  `octet-stream`-mislabeled PDFs return no text** and need a native-file export (samples S12/S13/S35).
- **No CSV/Excel email orders** were found — structured customers arrive via **EDI straight into BC**.
  Email order formats in practice: PDF (most), body text, occasional Word.
- Real customer sample data is **kept out of the (public) repo** and is **regenerable** from the mailbox.

## Working preferences (from the user)
- **Stick to the agreed plan. Do not introduce architecture/tooling/hosting choices on the fly** — surface
  options as questions and let the user decide (e.g. IIS was suggested unprompted and pushed back on).
- Be honest about what's a settled decision vs. an open item; verify facts (esp. BC/Microsoft specifics)
  rather than asserting from memory.

## Where secrets & PII live (never in git)
`.env` (Anthropic key, BC credentials) · `samples/raw` + `answer-keys` + `manifest.csv` + `FINDINGS.md`
(customer names, contacts, PO numbers, pricing) · the user's Claude Code memory dir.
