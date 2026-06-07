/**
 * Arc'emX! Waitlist — Google Apps Script web app.
 *
 * Setup:
 * 1. Create a new Google Sheet. Rename the first sheet to "Waitlist" (optional).
 * 2. Extensions > Apps Script. Replace Code.gs with this entire file.
 * 3. Click Deploy > New deployment > Type: Web app.
 *    - Description: "Arc'emX! waitlist intake"
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Authorize when prompted. Copy the resulting /exec URL.
 * 5. Paste that URL into WAITLIST_WEBHOOK_URL on Netlify (and in marketing/.env for local dev).
 *
 * To rotate the URL later: Deploy > Manage deployments > New version.
 */

var SHEET_NAME = "Waitlist";

var HEADERS = [
  "Submitted At (IST)",
  "Name",
  "Email",
  "Phone",
  "Age",
  "Broker",
  "Excited About",
  "Wanted Feature",
  "Submitted At (UTC ISO)",
  "User Agent",
];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || "{}");

    var sheet = getSheet_();
    ensureHeaders_(sheet);

    var nowUtc = new Date();
    var istString = Utilities.formatDate(nowUtc, "Asia/Kolkata", "dd/MM/yyyy hh:mm:ss a");

    sheet.appendRow([
      istString,
      String(body.name || ""),
      String(body.email || ""),
      String(body.phone || ""),
      Number(body.age) || "",
      String(body.broker || ""),
      String(body.excited || ""),
      String(body.wanted || ""),
      String(body.submittedAt || nowUtc.toISOString()),
      String((e.parameter && e.parameter.ua) || ""),
    ]);

    return jsonResponse_({ ok: true });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message || err) }, 500);
  }
}

function doGet() {
  return jsonResponse_({ ok: true, service: "arcemx-waitlist" });
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  return sheet;
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
  }
}

function jsonResponse_(obj, status) {
  var out = ContentService.createTextOutput(JSON.stringify(obj));
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}
