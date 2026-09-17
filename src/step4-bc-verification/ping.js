// Read-only Business Central connectivity + permissions probe.
// Confirms NavUserPassword basic auth works, lists companies, and tests read
// access to the entities the verification checks need. Nothing is written to BC.
//
// Setup in .env:
//   BC_BASE_URL=https://<server>:<port>/<instance>/api/v2.0
//   BC_USERNAME=<bc-service-user>
//   BC_PASSWORD=<that user's password>       # never commit; .env is git-ignored
//   BC_COMPANY=<company display name>        # optional; defaults to the first company
//
// Run (trust the corporate/Windows CA so TLS inspection / internal certs pass):
//   NODE_OPTIONS=--use-system-ca node src/step4-bc-verification/ping.js
import "dotenv/config";

const BASE = (process.env.BC_BASE_URL || "").replace(/\/$/, "");
const USER = process.env.BC_USERNAME;
const PASS = process.env.BC_PASSWORD;
const COMPANY = process.env.BC_COMPANY;

for (const [k, v] of [["BC_BASE_URL", BASE], ["BC_USERNAME", USER], ["BC_PASSWORD", PASS]]) {
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
}
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

async function get(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}/${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: AUTH, Accept: "application/json" } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function main() {
  console.log(`GET ${BASE}/companies ...`);
  let r;
  try {
    r = await get("companies");
  } catch (e) {
    console.error("Connection/TLS error:", e.message);
    console.error("If it's a certificate error, re-run with:  NODE_OPTIONS=--use-system-ca");
    console.error("(that trusts the Windows/corporate CA the BC server's cert is issued from).");
    process.exit(1);
  }

  if (r.status === 401) {
    console.error("401 Unauthorized — check BC_USERNAME / BC_PASSWORD, and that the instance credential type is NavUserPassword.");
    process.exit(1);
  }
  if (!r.ok) {
    console.error(`HTTP ${r.status}:`, (r.text || "").slice(0, 600));
    process.exit(1);
  }

  const companies = r.json?.value || [];
  console.log(`OK — auth works. ${companies.length} company/companies visible:`);
  for (const c of companies) console.log(`  - ${c.name}   (id ${c.id})`);

  const target = COMPANY
    ? companies.find((c) => (c.name || "").toLowerCase() === COMPANY.toLowerCase())
    : companies[0];
  if (!target) {
    console.log(COMPANY ? `\nCompany "${COMPANY}" not found in the list above — check BC_COMPANY.` : "\nNo companies returned.");
    return;
  }

  console.log(`\nProbing read access on "${target.name}" (the verification entities):`);
  for (const ep of ["customers?$top=1", "items?$top=1", "salesOrders?$top=1"]) {
    const rr = await get(`companies(${target.id})/${ep}`);
    const name = ep.split("?")[0];
    if (rr.ok) {
      const n = rr.json?.value?.length ?? 0;
      console.log(`  ${name.padEnd(12)} HTTP ${rr.status}  -> ${n} record(s) readable`);
    } else {
      console.log(`  ${name.padEnd(12)} HTTP ${rr.status}  -> NOT readable${rr.status === 403 ? " (service user's permission set lacks read on this entity)" : ""}`);
    }
  }
  console.log("\nConnectivity check done. Green across the board = the pipeline can read BC.");
}

main().catch((e) => { console.error(e); process.exit(1); });
