# Email Order No. Series — BC extension (developer handoff)

A small per-tenant Business Central (AL) extension so email-originated Sales Orders
and Quotes get their own number series, without changing standard numbering.

Context: the email-to-order app creates documents via the **BC API v2.0** as the
**`EMAILORDER`** user and posts them **without a document number** — BC assigns it.
Today (codeunit not yet deployed) BC falls back to the **default** Order/Quote series;
after deploying this, `EMAILORDER`-created docs get `S-ORD-EMAIL…` / `S-QUO-EMAIL…`.

## 1. Create the two number series
BC → **No. Series** page → New, two entries. On each, add a **No. Series Line**:

| No. Series  | Description             | Starting No.     | Manual Nos. | Default Nos. |
|-------------|-------------------------|------------------|-------------|--------------|
| `S-ORD-EMAIL` | Email Sales Orders    | `S-ORD-EMAIL00001` | No        | Yes          |
| `S-QUO-EMAIL` | Email Sales Quotes    | `S-QUO-EMAIL00001` | No        | Yes          |

(Format/length is your choice — just keep **Manual Nos. = No**.)

## 2. Confirm the integration user
The subscriber fires only for the BC user **`EMAILORDER`** (what the app authenticates
as). If your service user has a different name, change `EmailUserTok` in the codeunit.

## 3. Object ID
`EmailOrderNoSeries.al` uses codeunit **50100** — change it to a free ID in your
licensed per-tenant range if 50100 is taken.

## 4. Publish
Build/publish the extension to **BC260TEST first**, create one order + one quote as
`EMAILORDER` via the API, and confirm they number `S-ORD-EMAIL00001` / `S-QUO-EMAIL00001`.
Then publish to production.

## 5. After deploy
If the standard **Order Nos. / Quote Nos.** series had **Manual Nos.** turned **On**
for earlier testing, turn it back **Off** — the app no longer supplies numbers.

## Notes
- Written for **BC v26** — uses the modern codeunit `"No. Series"` (not the deprecated
  `NoSeriesManagement`). Confirm the `OnBeforeInsert` event signature and the
  `GetNextNo` overload against your exact build before publishing.
- The app side is already done: `src/step6-order-creation/create.js` posts without a
  number and relies on BC to assign it (see PROJECT-STATUS.md, Step 6).
- Nothing else in the pipeline changes when this lands — it's purely BC-side numbering.
