# Step 1 — Labeled Order-Email Sample Set

Purpose: a curated, hand-verified set of real `Order@buckeyefasteners.com` emails used to
measure extraction accuracy (Step 2) and classification accuracy (Step 3) **in isolation** —
no Business Central, no UI, no queue.

## What's here

```
samples/
  README.md              # this file
  extraction-schema.json # the normalized target shape every format maps into
  manifest.csv           # index of every sample: id, format, classification, source, notes
  raw/
    S01/                 # one folder per sample
      email.json         #   email metadata + body (the raw input)
      <attachments>      #   original PDF/Word/CSV/Excel files, as received
  answer-keys/
    S01.json             # hand-verified ground-truth extraction for S01 (the "correct answer")
```

## Labeling conventions

Each sample carries two labels in `manifest.csv`:

- **format** — where the order data physically lives: `body`, `pdf`, `word`, `csv`, `excel`,
  or `mixed` (e.g. body + attachment). This is what Step 2's extractor has to handle.
- **classification** — the Step 3 ground truth: `order`, `not_order`, or `ambiguous`
  (a human genuinely can't tell without context — e.g. a reply in an existing thread,
  a quote request, an acknowledgment follow-up).

## Ground-truth answer keys

`answer-keys/S**.json` is the **correct** extraction for that email, following
`extraction-schema.json`. Step 2 scores the extractor's output field-by-field against these.

> These keys are drafted by carefully reading each source email/attachment, but they are the
> measuring stick for everything downstream — so each one is marked `"verified": false` until a
> human (Corey / a sales rep) confirms it. Flip to `true` once checked. An unverified key can
> still be used for a first accuracy read, but a real accuracy number requires verified keys.

## Sourcing note

Emails and attachments are pulled read-only from the shared mailbox via Microsoft Graph
(`Mail.Read.Shared`) and stored locally here for offline, repeatable testing. This is real
customer PO data — keep it inside the project, do not send it to any external service other
than the extraction model calls the pipeline itself makes.
