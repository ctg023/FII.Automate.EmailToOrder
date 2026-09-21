// Zod version of samples/extraction-schema.json — the normalized shape Claude
// must return for every order. Keep this in sync with extraction-schema.json.
// Note: `extraction_flags` from the JSON schema is annotator metadata for answer
// keys only; it is intentionally NOT part of what the model extracts.
// Use the Zod v4 API (shipped under this subpath since zod 3.25) — the SDK's
// zodOutputFormat helper expects v4 schemas (reads `.def`).
import { z } from "zod/v4";

const nstr = z.string().nullable();
const nnum = z.number().nullable();

export const LineItem = z.object({
  line_no: z.number().int().nullable(),
  customer_part: nstr, // the part number the CUSTOMER uses (their PN)
  supplier_part: nstr, // Buckeye's / the supplier's part number or SKU, if cited
  description: nstr,
  quantity: nnum,
  uom: nstr, // unit of measure as written (EA, M=thousand, LB, PC, ...)
  unit_price: nnum, // price per UOM as written; null if not stated
  line_total: nnum,
});

export const OrderExtraction = z.object({
  customer: z.object({
    name: nstr,
    customer_po_account: nstr,
    contact_name: nstr,
    contact_email: nstr,
    contact_phone: nstr,
  }),
  po_number: nstr,
  order_date: nstr, // ISO 8601 if unambiguous, else verbatim
  requested_ship_date: nstr,
  ship_to: z.object({
    name: nstr,
    line1: nstr,
    line2: nstr,
    city: nstr,
    state: nstr,
    postal_code: nstr,
    country: nstr,
  }),
  freight_terms: nstr,
  payment_terms: nstr,
  line_items: z.array(LineItem),
  notes: nstr,
  // Customer-service action gate. Judge the WHOLE order (body, notes, freight terms, and
  // line descriptions): does it contain any instruction a human must ACT ON or decide
  // before the order can be processed normally? TRUE examples: call/contact/confirm with
  // the buyer, a new or changed credit card or price, hold / do-not-ship-until / ship-
  // complete-no-partials, required material certs / PPAP / paperwork, or special carrier /
  // drop-ship-to-end-customer routing that needs a person — and anything similar in
  // spirit (open-ended, not just these). FALSE for standing constraints that need no
  // action (e.g. "cartons not to exceed 50 lbs", "use acct #X"). If unsure, prefer TRUE.
  service_action_required: z.boolean().nullable(),
  service_action_reason: nstr, // short quote/paraphrase of the instruction(s); null if none
});
