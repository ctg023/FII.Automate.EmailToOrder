// Email Order No. Series — Business Central AL extension (per-tenant)
// -------------------------------------------------------------------
// PURPOSE
//   The email-to-order automation creates Sales Orders / Quotes through the BC
//   API v2.0 as the dedicated integration user "EMAILORDER", and posts them
//   WITHOUT a document number (the app never manages numbering). This codeunit
//   stamps a dedicated number series on those documents so email-originated
//   orders/quotes are visually distinct and independently sequenced, WITHOUT
//   touching the standard Order/Quote number series used by everyone else.
//
//   EMAILORDER creates an Order  -> number from series  S-ORD-EMAIL  (e.g. S-ORD-EMAIL00001)
//   EMAILORDER creates a Quote   -> number from series  S-QUO-EMAIL  (e.g. S-QUO-EMAIL00001)
//   Any other user / document    -> standard numbering, unchanged.
//
// HOW IT WORKS
//   Subscribes to the Sales Header table's OnBeforeInsert event. If the record has
//   no number yet AND the current user is EMAILORDER AND it's an Order or Quote,
//   it draws the next number from the dedicated series and sets it, so the standard
//   InitInsert() logic (which only assigns when "No." is blank) leaves it alone.
//
// DEPLOY / SETUP  (see README.md in this folder for full steps)
//   1. Create the two No. Series (S-ORD-EMAIL, S-QUO-EMAIL) — Manual Nos. = No.
//   2. Confirm the integration user is named EMAILORDER (adjust the label if not).
//   3. Set the object ID (50100 below) to a free number in your licensed range.
//   4. Publish this extension to the tenant (BC260TEST first, then production).
//   5. After deploy, "Manual Nos." can go back OFF on the standard Order/Quote series.
//
// NOTES FOR THE DEVELOPER
//   - Written for BC v26 (uses the modern codeunit "No. Series"; NoSeriesManagement
//     is deprecated). Please confirm the OnBeforeInsert event signature and the
//     "No. Series".GetNextNo overload against your exact BC 26 build before publishing.
//   - UserId() returns the BC user name; for NavUserPassword auth that's "EMAILORDER".
//     If your service user is named differently, change EmailUserTok.

codeunit 50100 "Email Order No. Series"
{
    [EventSubscriber(ObjectType::Table, Database::"Sales Header", 'OnBeforeInsertEvent', '', false, false)]
    local procedure AssignEmailOrderNoOnBeforeInsert(var Rec: Record "Sales Header"; RunTrigger: Boolean)
    var
        NoSeries: Codeunit "No. Series";
        SeriesCode: Code[20];
    begin
        if Rec.IsTemporary() then
            exit;
        if Rec."No." <> '' then
            exit; // a number is already assigned — never override it
        if UpperCase(UserId()) <> UpperCase(EmailUserTok) then
            exit; // only the EMAILORDER integration user

        case Rec."Document Type" of
            Rec."Document Type"::Order:
                SeriesCode := OrderSeriesTok;
            Rec."Document Type"::Quote:
                SeriesCode := QuoteSeriesTok;
            else
                exit; // invoices, credit memos, etc. keep standard numbering
        end;

        Rec."No. Series" := SeriesCode;
        Rec."No." := NoSeries.GetNextNo(SeriesCode); // overload with a usage date is also available
    end;

    var
        EmailUserTok: Label 'EMAILORDER', Locked = true;
        OrderSeriesTok: Label 'S-ORD-EMAIL', Locked = true;
        QuoteSeriesTok: Label 'S-QUO-EMAIL', Locked = true;
}
