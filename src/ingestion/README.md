# Mailbox ingestion (Track A) — read-only, via Microsoft Graph

Reads new order emails from the `orders@` **shared mailbox** and emits a normalized
record per email for the downstream pipeline (classify → extract → verify → review →
create).

## Guarantees
- **Read-only.** Only `GET` calls against message data (plus the OAuth token request).
  Never marks read, moves, deletes, or flags anything in the mailbox.
- **No double-processing.** Because we may not mark messages "done" in the mailbox,
  processed message ids are tracked in a **local** state file
  (`.ingest-state.json`, git-ignored). The Graph message id is the exact dedup key.

## One-time setup (M365 / Entra admin)
App-only (client credentials) — the right model for an unattended VM service.

1. **Register an app** in Entra ID (Azure Portal → App registrations → New).
2. **API permission:** Microsoft Graph → **Application permissions** → **`Mail.Read`**.
   Then **Grant admin consent**. (Application `Mail.Read`, not delegated — no user sign-in.)
3. **Credential:** create a **client secret** (or, preferred for prod, upload a certificate).
4. **Scope it to only `orders@`** so the app can't read any other mailbox — via an
   Application Access Policy in Exchange Online PowerShell:
   ```powershell
   # a mail-enabled security group whose ONLY member is orders@
   New-DistributionGroup -Name "EmailOrderMailboxes" -Type Security -Members orders@yourdomain.com

   New-ApplicationAccessPolicy -AppId <client-id> `
     -PolicyScopeGroupId EmailOrderMailboxes@yourdomain.com `
     -AccessRight RestrictAccess `
     -Description "Restrict email-order app to orders@ only"

   # verify: should return Granted for orders@ and Denied for any other mailbox
   Test-ApplicationAccessPolicy -Identity orders@yourdomain.com -AppId <client-id>
   ```
5. **Fill `.env`:**
   ```
   GRAPH_TENANT_ID=<tenant id>
   GRAPH_CLIENT_ID=<app (client) id>
   GRAPH_CLIENT_SECRET=<client secret>
   GRAPH_MAILBOX=orders@yourdomain.com
   ```

## Usage
On this network, prefix Node with `NODE_OPTIONS=--use-system-ca` (corporate TLS).
```bash
node src/ingestion/mailbox.js --list                 # read-only preview of recent Inbox
node src/ingestion/mailbox.js --pull                 # emit NEW messages, update local state
node src/ingestion/mailbox.js --pull --out .inbox    # also write a JSON record per email
```
`--list` never changes state; `--pull` records processed ids so re-runs skip them.

## Notes
- Native attachment bytes (`contentBytes`) are available per attachment via Graph — a
  later stage saves/extracts them (handles the scanned-PDF case with real files, unlike
  the connector's text-only export).
- Pulled records and the state file are **git-ignored** (customer PII).
