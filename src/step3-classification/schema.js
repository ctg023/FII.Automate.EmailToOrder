// Structured output for Step 3 intent classification.
// Uses the Zod v4 API (required by the SDK's zodOutputFormat helper).
import { z } from "zod/v4";

export const Classification = z.object({
  // Matches the brief's taxonomy. "unsure" == the manifest's "ambiguous".
  classification: z.enum(["order", "not_order", "unsure"]),
  confidence: z.number(), // 0..1, calibrated probability the label is correct
  reasoning: z.string(), // one sentence
});
