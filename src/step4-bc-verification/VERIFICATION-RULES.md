# Verification Rules — v1

The set of read-only checks an extracted order must pass to be **approve-ready**.
Anything that fails → the order is **flagged for a rep** with the reason (no auto-create;
a human still clicks Approve — see CLAUDE.md).

Scope note: v1 is deliberately small. "Tighten these rules and add more later" is
expected — see [Later / candidates](#later--candidates). Fields cited below are the
real API v2.0 fields confirmed live via `data-quality.js`.

Input to verification = the **extracted order** (Step 2): a customer identity + one or
more line items `{ part, quantity, uom? }`.

---

## Rule 1 — Customer resolves
**Passes when** the order's customer resolves to **exactly one** BC customer.

- BC entity/fields: `customers` → `number`, `displayName`, `email`, `addressLine1`, `postalCode`.
- Match inputs from the email: sold-to name, email domain, address.
- **Flag if:** 0 matches (unknown customer) **or** >1 plausible match (ambiguous).
- Note: this is fuzzy name/identity matching, not a single field lookup — the hardest
  part of v1. Resolution strategy is its own design task.

## Rule 2 — Every line item resolves
**Passes when** *every* line item resolves to **exactly one** BC item.

- Match path (a) **direct**: `items.number` (and/or `gtin`) — the PO lists our item number.
- Match path (b) **cross-reference**: customer part # → our item # via the BC
  **Item Reference** table.
- ⚠️ **Dependency:** path (b) requires the Item Reference table, which is **not exposed
  by standard API v2.0** (`itemReferences` / `itemCrossReferences` → 404). **Required
  BC-side item:** expose it via a custom API page (or OData query endpoint). Until then,
  customer-part-number POs cannot fully pass Rule 2.
- **Flag if:** any line resolves to 0 items (unknown part) or >1 (ambiguous).

## Rule 3 — Every line item is in stock (sufficient quantity)
**Passes when** for *every* line, on-hand inventory **≥ quantity ordered**.

- BC entity/fields: `items.inventory` (on-hand qty via API v2.0).
- **Flag if:** any line's `inventory` < ordered quantity (a "short" line).
- Definition: v1 uses **on-hand**. "Available" (on-hand minus committed/reserved) is the
  more correct measure but not a single API v2.0 field — deferred to Later.
- UoM caveat: quantity compare assumes the order is in the item's
  `baseUnitOfMeasureCode`. Mismatched UoM is a Later item (see below).

## Rule 4 — All-or-nothing across lines
**Passes when** *all* lines pass Rules 2 and 3 together.

- A single unresolved or short line flags the **entire PO** — partial orders are not
  auto-approved in v1. (This is Rules 2+3 applied across every line; kept explicit
  because it's a business decision, not a technical one.)

---

## Later / candidates
Noted, not built in v1. Confirm before adding.

- **Blocked customer** (`customers.blocked`) → don't approve orders for a blocked customer.
- **Blocked item** (`items.blocked`) → a part may resolve but be un-sellable.
- **Credit check** (`customers.creditLimit` vs `balanceDue` + order total) → over-limit flags.
- **Duplicate PO** (`salesOrders.externalDocumentNumber`) → same customer PO already in BC.
- **Available (not just on-hand)** inventory — net of reservations/committed.
- **Unit-of-measure conversion** when the order UoM ≠ item base UoM.
- **Price sanity** (order unit price vs `items.unitPrice`).

## Open BC-side items (need admin/user confirmation)
- Expose the **Item Reference** table (blocks Rule 2 path b). **Required.**
- Confirm `Fasteners` is the production company (vs sandbox) so counts are real.
