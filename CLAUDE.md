# CLAUDE.md — project guide for Claude Code sessions

Keep this current. It's the fast-start context for anyone (human or Claude) picking up this project.
Detailed live status is in [PROJECT-STATUS.md](PROJECT-STATUS.md).

## What this is
An internal tool that reads incoming **order emails** from a shared `orders@` mailbox, extracts the
order, checks it against **Business Central**, and lets a sales rep **approve** each one before it's
created in BC. Goal: cut manual order entry for ~10 reps while keeping a human in the loop.

**A human approves every order before it is created in BC. No auto-create — ever, at least through rollout.**

## Status (2026-09-20)
See [PROJECT-STATUS.md](PROJECT-STATUS.md) for the authoritative, detailed status — keep that current too.
- **Step 1 (sample set):** done — 50 labeled sample emails in `samples/` (29 order, 8 ambiguous, 13 not_order).
- **Step 2 (extraction):** done — harness in `src/step2-extraction/`; ~100% on order content. Now also sends
  **native PDF bytes** as document blocks (`buildMessageContent`), so real/scanned PDFs are read directly.
- **Step 3 (classification):** done — harness in `src/step3-classification/`; 92%, **0 dropped orders**.
- **Step 4 (BC verification):** done (read-only v1) — `src/step4-bc-verification/verify.js` resolves customer
  (Rule 1) + line items via direct/cross-ref (Rule 2) + stock (Rule 3), and assigns a **disposition**
  (Order / Quote / Needs-review). `--batch <dir> --json <out>` emits structured per-order records.
- **Step 5 (review app):** **LIVE, end-to-end.**
  - `pipeline.js` — live runner: pulls `order@` Inbox, groups messages into **threads by conversationId**
    (Inbox-only — reps reply from their own mailboxes, so Sent isn't captured), classify→extract(w/ PDFs)→
    verify, **incremental cache** in `out/review-store.json`. Model defaults to **Sonnet 5**. Non-orders hidden.
  - `render.js` — renders the queue; interactive mode wires the buttons.
  - `server.js` — Node service serving the live page. **Approve = dry-run preview → INLINE confirm →
    guarded create** to BC260TEST/Fasteners (writes a real Sales Order/Quote). Created docs are marked
    actioned (leave the queue), **deep-link back to BC** (needs `BC_WEB_URL`), and are **reconciled** — if the
    BC doc is later deleted the order returns to the queue. Cards flag **PO-already-in-BC** and link the source PDF.
- **Step 6 (order creation):** write **proven** — `src/step6-order-creation/create.js`; `createDoc()` is the
  programmatic path the server calls. Dry-run default; guarded real write. ⚠️ BC assigns a **default** number
  series until the `EMAILORDER` No.-Series **AL codeunit is deployed** (developer task — then S-ORD-EMAIL/S-QUO-EMAIL).
- **Ingestion (Track A):** **LIVE** — Entra app + `.env` done; `mailbox.js --check` green; reads
  `order@buckeyefasteners.com` (singular). ⚠️ **Application Access Policy fence NOT yet applied** (app can read
  ALL mailboxes) — must do before pilot.
- Next: server **auth** (none yet), mailbox **Access Policy fence**, **accuracy pass** on the live backlog;
  then pilot with 1–2 reps. Backlog idea: **item-level quote history / rate-shopping visibility** (see PROJECT-STATUS).

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
                          #   render.js (page), server.js (serves page + approve/preview/refresh endpoints)
src/step6-order-creation/ # create.js = BC Sales Order / Quote write; createDoc()/docExists() exported for server
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
