# CLAUDE.md — project guide for Claude Code sessions

Keep this current. It's the fast-start context for anyone (human or Claude) picking up this project.
Detailed live status is in [PROJECT-STATUS.md](PROJECT-STATUS.md).

## What this is
An internal tool that reads incoming **order emails** from a shared `orders@` mailbox, extracts the
order, checks it against **Business Central**, and lets a sales rep **approve** each one before it's
created in BC. Goal: cut manual order entry for ~10 reps while keeping a human in the loop.

**A human approves every order before it is created in BC. No auto-create — ever, at least through rollout.**

## Status (2026-09-22)
See [PROJECT-STATUS.md](PROJECT-STATUS.md) for the authoritative, detailed status — keep that current too.
> **"Gate"** = a pass/fail checkpoint in `verify.js` that decides if an order can be auto-created or must
> stop for a human. **Hard gate** → routes to **Needs review**, not creatable until resolved. **Soft/overlay
> gate** → flagged but still creatable under a condition (e.g. the >$5k second sign-off, or a blocked line
> that's just excluded). Disposition is **Order** (all lines available) / **Quote** (some short) / **review**.
- **Step 1 (sample set):** done — 50 labeled sample emails in `samples/` (29 order, 8 ambiguous, 13 not_order).
- **Step 2 (extraction):** done — harness in `src/step2-extraction/`; ~100% on order content. Now also sends
  **native PDF bytes** as document blocks (`buildMessageContent`), so real/scanned PDFs are read directly.
- **Step 3 (classification):** done — harness in `src/step3-classification/`; 92%, **0 dropped orders**.
- **Step 4 (BC verification):** done (read-only) — `src/step4-bc-verification/verify.js` assigns a
  **disposition** (Order / Quote / Needs-review). Rules: **1** customer name match (whole-token name
  match; a unique hit resolves. Ties are broken by, in order: ship-to **city/state**, then a **contact
  tiebreak** — the PO buyer against each tied candidate's BC contacts: exact **email**, then email
  **domain** (both prod; free-mail/own domains excluded), then buyer **name** (works in the test instance
  where contact emails are scrubbed). Resolves only when exactly ONE candidate matches; else flags for a
  human. Learned aliases still consulted first.) · **2** line items
  (direct / cross-ref via `Item_References_Excel`, then two fallbacks for messy part fields —
  **part-field prefix**: real part + crammed description words, e.g. `HS3 M6 PROJECTION WELD NUT`→`HS3 M6`;
  and **description-anchored**: clean part in the description when the part field carries a tag, e.g.
  `RW2114OHIO`→`RW-2114`; both require a unique BC match) · **3** stock — **PER-LOCATION available** (on-hand
  from `Item_Ledger_Entries_Excel` `Remaining_Quantity` **minus** open sales-order qty from `Sales_Lines_Excel`
  `Outstanding_Quantity`, summed by `Location_Code`). The gate uses the **customer's ship-from location**
  (customer-card `Location_Code`); short there → Quote **even if another branch has stock** (no location →
  company total). Each line shows `CL/CH/AT` available (the customer's own location starred), tunable via
  `STOCK_LOCATIONS` · **4** ship-to matches a `ShipTo` on file
  (hard gate) · **5** contact/email matches a Person contact under the customer's company contact
  (`Contact`/`ContactBusinessRelation`; **informational unless `CONTACT_GATE=1`**) · **6** price matches the
  **referenced BC quote** — extract the **BC/Q #** from the subject and read its item unit prices from the
  **classic OData pages** (`Sales_Quote_Excel`+`…SalesLines` for an open quote; if the rep already converted
  it, `Sales_Order_Excel` by **`Quote_No`**+`…SalesLines`), then compare each item's price to the PO's (exact
  by default; `PRICE_TOL` per-unit $ tolerance); mismatch → review. NB: the **standard `salesQuotes` API has no
  usable No./lines** — use the classic pages. A referenced quote not in the current instance (some live only in
  **prod**) is reported, not gated. · **7** **plating/finish substitution** — customers order the BASE item
  and ask (in the line text/notes) for a finish, which is a different item `base-P##`. Detects the request,
  reads the authoritative **`ARC_Plating_Desc`** off the classic `Item_Card_Excel`, and **swaps in the plated
  item number** (e.g. "black oxide" → `SSM 05014-P44`, "copper flash" → `-P40`, "zinc yellow" → `-P17`).
  "plain / no plate" keeps the base; **bare "zinc"** (several zinc variants) or any unresolved finish → review
  with candidate variants. Explicit `-P##` on the PO is used directly.
  · **8** **PO price vs BC PRICE LIST** — reads `Price_List_Lines_Excel` (customer-specific lines `Source_Type`
  `Customer` + base tiers `Source_Type` `All Customers`; sales lines have `Unit_Price`>0, purchase/`Vendor` don't).
  Replicates BC's default **Lowest-Price "Get Price"**: among every line the customer is eligible for, matching
  UoM/currency/date with `Minimum_Quantity` ≤ ordered qty, take the **lowest** — i.e. customer price if lower,
  else the applicable **All-Customers quantity break**. Mismatch → review (exact by default, `PRICE_TOL`). A
  referenced quote (Rule 6) still wins for lines it priced. (Customer **Price Group** tier exists in code but 0
  customers use one. There is NO usable read-only "Get Price" before create — the standard API only fills the
  price when a line is POSTed.)
  Also gates: non-piece **UoM** (100PACK/M/C → review), **piece quantity not a multiple of 100** (fasteners
  ship in hundreds; e.g. 2120/2150 → review, tune/disable via `QTY_STEP`), **multi-PO-in-one-email** → review,
  **high-value** (PO total ≥ `REVIEW_OVER` = $5,000, or un-totalable when `REVIEW_NO_PRICE` — needs a **second
  sign-off** at create, an overlay not a hard block), **blocked item** (BC item `Blocked` → line **excluded**
  from the created doc; all lines blocked → review), **customer Blocked** (credit hold Ship/Invoice/All → review),
  **payment** (customer prepay Payment **Terms** in `REVIEW_TERMS_CODES`=PREPAY, or term+fee Payment **Method**
  in `REVIEW_METHOD_CODES`=TERMS+FEE → review), and **special instructions** (extractor sets
  `service_action_required`; verify gates ONLY genuine CS actions — payment/credit-card change, certs/test
  reports, partial/split-ship or hold, price/qty discrepancy — the routine "acknowledge/confirm price &
  delivery" ask does NOT gate, the acknowledgement email + urgency flag cover it). `--batch <dir> --json <out>`
  emits records.
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
  - **Mailbox reconcile** (read-only): drops cards whose **source email is no longer in the Inbox** (deleted or
    moved out = a human handled it outside the app). Checks each cached message by id (`messageInInbox`), and —
    because Graph **default message ids can rotate** — CONFIRMS an id-"gone" with a content `$search`
    (`inboxContains`) before removing, so a rotated id never drops a present order. Runs inside `--run` and
    `--reconcile`; standalone `--reconcile-mailbox`. (Still read-only — it prunes the local store, not the mailbox.)
  - **Ship-to picker:** a **change** link on the Ship-to row lists the customer's on-file `ShipTo` addresses
    (`listShipTos` → `/api/shiptos`); picking one (`/api/assign-shipto`, `forceShipTo`) clears the ship-to gate
    and is kept across re-verifies. On create, a **post-create classic-page PATCH** sets the established
    `Ship_to_Code` on `Sales_Order_Excel`/`Sales_Quote_Excel` (the standard API has no `shipToCode` — address
    fields are written as a safe fallback if the PATCH fails). ⚠️ PATCH not yet validated on a real create.
  - **Ship-from location picker:** a **change** link on the "Ship from" row (Line items section) lets a rep
    re-point the whole PO to any `STOCK_LOCATIONS` branch (`/api/assign-location`, `forceLocation`). The stock
    gate then uses that branch instead of the customer's default `Location_Code`, so a line **short at the
    customer's branch flips to in-stock (Quote→Order) when the chosen branch has stock**. Kept across
    re-verifies; **Reset** returns to the customer default. On create, a **post-create classic-page PATCH** sets
    `Location_Code` on `Sales_Order_Excel`/`Sales_Quote_Excel` **before the lines are POSTed** so BC defaults each
    line to that branch (same mechanism as `Ship_to_Code`). ⚠️ PATCH not yet validated on a real create.
  - **Directional price rule (our price vs PO price):** the created line is **always priced from OUR BC price
    list** (create.js POSTs no price — BC fills it), so a Rule 6/8 comparison drives **routing**, not billing.
    Per creatable line, compare **our price** (referenced quote wins, else BC price list) to the **PO price**
    (within `PRICE_TOL`): **our < PO** → process normally **and notify the customer** we billed our lower price
    (a line is added to the acknowledgement email; `underPriced` → `acknowledge.js`); **our > PO** → the whole
    document becomes a **Quote** (overrides stock — customer must accept the higher price; `priceForcesQuote`);
    **our ≈ PO** → match; **PO priced but our price undeterminable** (item on no price list, no referenced quote)
    → **review** (`priceUnknown`). Both prices stay **visible** on the card (per-line PO price + the our-price
    note from Rules 6/8, plus a directional note). No manual price override — the direction decides.
  - **Order acknowledgement email** (`acknowledge.js`): on Approve→create the app composes a brief receipt and,
    when `ACK_SEND=1`, **sends it from `order@` via Graph `Mail.Send`**. Recipient = the PO's buyer email (NOT
    BC's scrubbed contact); `ACK_TEST_TO` redirects EVERY send to one address for testing (currently `navl@`).
    Safe by default (compose-only until `ACK_SEND=1` + a recipient). A send failure never fails the create.
    **Needs-acknowledgement view** at the top of the queue surfaces created orders whose ack failed (`ack.sent
    =false`, dry-runs excluded) with a **Resend** button (`/api/resend-ack`) — so a send failure isn't lost.
  - **Queue filters:** a client-side chip bar + clickable stat tiles filter cards by facet (Order/Quote/Review,
    Customer, Ship-to, Item/part, Price, Payment, Cust. blocked, Over $5k, Special instr., Contact, Urgent) with
    live counts, remembered across reloads. **Urgency flag:** cards with an urgency term or a ≤2-day deadline get
    a light-red background + a banner quoting the customer's request sentence. **Per-line PO price** (unit ×
    qty = extended, 5-decimal) and **PO total** shown on each card. **PDF links** open in the host's default
    viewer (`/api/open-pdf`, local-use).
  - Commands: `pipeline.js --run` (process new mail; also reconciles) · `--merge-preview` (show split-PO merges,
    free) · `--reverify` (re-apply rules to cache, no Claude) · `--enrich` (save source PDFs for EVERY card —
    order/quote/review — so any card can link the PO; BC dup-check on order/quote) · `--reconcile`
    (BC-deleted back to queue + mailbox reconcile) · `--reconcile-mailbox` · `--rerender`. `server.js` serves the app.
- **Step 6 (order creation):** write **proven** — `src/step6-order-creation/create.js`; `createDoc()` is the
  programmatic path the server calls. Dry-run default; guarded real write. **Dates:** sets **Requested Delivery
  Date** (header) = the PO's requested date, else **today's order-entry date**, and the **line Shipment Date**
  = that same date. ⚠️ The standard API salesOrder header exposes **no** `shipmentDate` (or Promised Delivery
  Date), so the header Shipment Date can't be written — BC leaves it at the work date; only the *line* Shipment
  Date is set (see Open items). ⚠️ BC assigns a **default** number series until the `EMAILORDER` No.-Series
  **AL codeunit is deployed** (developer task — then S-ORD-EMAIL/S-QUO-EMAIL).
- **Ingestion (Track A):** **LIVE** — Entra app + `.env` done; `mailbox.js --check` green; reads
  `order@buckeyefasteners.com` (singular). Handles **forwarded-as-email POs** (e.g. Bunn) — a Graph
  `itemAttachment` (message/rfc822) whose real PDF is nested one level down is pulled via a nested `$expand`
  (`fetchItemAttachmentFiles`), so those PDFs reach extraction. ⚠️ **Application Access Policy fence NOT yet
  applied** (app can read ALL mailboxes) — must do before pilot.
- **Acknowledgement email LIVE:** `Mail.Send` granted; `ACK_SEND=1` with `ACK_TEST_TO=navl@buckeyefasteners.com`
  so test sends don't hit real customers (a real test send to `navl@` succeeded). **Before prod:** remove
  `ACK_TEST_TO` to email real buyers. `.env` is git-ignored so these settings must be re-set on the VM.
- Accuracy pass **done** (found+fixed UoM, multi-PO, PDF-folder collision). Live backlog processed (full 188
  Inbox → ~85 real orders). **Open decisions:** (1) enable `CONTACT_GATE=1`? (works now; email match needs
  prod) (2) build the **mailbox move-on-approve** cleanup (needs `Mail.ReadWrite`)? (3) server **auth**,
  mailbox **Access Policy fence**, deploy the **EMAILORDER codeunit** — all before pilot. Backlog idea:
  item-level quote history / rate-shopping (see PROJECT-STATUS).
- **Not built (deferred, noted for a new session):** (a) **empty-thread guard** — the pipeline can create a
  phantom card from a null/empty message (message id null, no content, stored under key `"undefined"`); one was
  purged by hand. Guard: skip threads with a null id or no subject/body/attachments before classify/extract.
  (b) **bare-PO-number merge** — `thread-merge.js` only keys on a BC/Q # or a PO token that follows a "PO"/"P.O."
  marker, so customers whose subject is JUST the number (e.g. Bunn `4600000421`) don't merge and show as
  duplicate cards. Fix: also treat a whole-subject strong token (≥6 chars, has a digit) as a PO key.
- **Open date items:** (a) **header Shipment Date** — the standard API can't write it, BUT the classic
  `Sales_Order_Excel` page **does** expose `Shipment_Date` (and `Ship_to_Code`), so the **same post-create PATCH
  mechanism now used for Ship_to_Code** can set it — not yet wired. (b) **Two dates (requested + required)** —
  POs sometimes carry both under varied labels, but extraction captures only **one** (`requested_ship_date`);
  plan: add a second extracted field + surface it, and write the "required" date to BC once wired. (c)
  **Established Ship-To vs Custom Address** — now **built** via the ship-to picker + a post-create classic
  `Ship_to_Code` PATCH (address fields as fallback); ⚠️ the PATCH is **not yet validated on a real create**.

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
                          #   render.js (page+filters), server.js (serves page + approve/preview/assign/
                          #   assign-shipto/shiptos/resend-ack/open-pdf endpoints), thread-merge.js (fold
                          #   split-PO threads; MERGE_THREADS=1), acknowledge.js (order ack email via Mail.Send),
                          #   aliases.js (learned customer aliases)
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
node src/step5-review/pipeline.js --reconcile            # BC-deleted orders back to queue + mailbox reconcile
node src/step5-review/pipeline.js --reconcile-mailbox    # drop cards whose email left the Inbox (handled elsewhere)
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
- **Tuning env vars** (all `.env`, all optional): `PRICE_TOL` (price-match $ tolerance, 0=exact) · `QTY_STEP`
  (piece multiple, 100) · `CONTACT_GATE` (1 = hard-gate contact) · `MERGE_THREADS` (1 = split-PO merge) ·
  `REVIEW_OVER` (high-value threshold, 5000) · `REVIEW_NO_PRICE` (gate un-totalable POs, on) · `REVIEW_TERMS_CODES`
  (prepay Payment Terms, PREPAY) · `REVIEW_METHOD_CODES` (term+fee Payment Method, TERMS+FEE) · `STOCK_LOCATIONS`
  (per-line stock columns, `CL,CH,AT`) · `AVAIL_TTL_MS` (per-item stock/price cache, 60000) · `ACK_SEND` (1 =
  really send the acknowledgement) · `ACK_TEST_TO` (redirect all acks here for testing) · `ACK_FROM_NAME`.

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
  `ContactBusinessRelation`, `Item_Card_Excel` (plating `ARC_Plating_Desc`), `Sales_Quote_Excel`/`Sales_Order_Excel`
  (+`…SalesLines`, referenced-quote prices; and `Ship_to_Code`/`Shipment_Date` for the post-create PATCH),
  `Price_List_Lines_Excel` (customer + All-Customers price tiers, **Rule 8**), `Item_Ledger_Entries_Excel`
  (`Remaining_Quantity` per location) + `Sales_Lines_Excel` (`Outstanding_Quantity` per location) for **per-location
  stock**, `Customer_Card_Excel` (`Location_Code`, `Currency_Code`, `Customer_Price_Group`). Standard API v2.0
  is used for `customers`/`items` and order **creation** — but has **no `shipToCode` and no header `shipmentDate`**
  (why the classic-page PATCH exists), and price is only filled when a line is POSTed (no read-only "Get Price").
  **Customers' buyers are Person `Contact`s linked by `Company_No`** to the customer's company contact (found via
  `ContactBusinessRelation`).
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
