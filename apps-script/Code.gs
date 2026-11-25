/**
 * CrochetHub — Google Apps Script web app
 * ---------------------------------------
 * Paste this into the "CrochetHub database" Google Sheet:
 *   Extensions → Apps Script → replace everything in Code.gs with this file → Save.
 * Then: Deploy → New deployment → type "Web app"
 *   Execute as: Me        Who has access: Anyone
 * Copy the Web app URL and give it to Claude (or add it in Vercel as APPS_SCRIPT_URL).
 *
 * What it does when the CrochetHub website calls it:
 *   - new_order:     emails the order to the shop owner (from your Gmail) and adds it
 *                    to the Orders and Order items tabs
 *   - status_update: emails the status update to the customer and updates the
 *                    order's status in the Orders tab
 *
 * SECRET must match APPS_SCRIPT_SECRET in Vercel. Do not share it.
 */
const SECRET = 'PASTE_THE_SAME_VALUE_AS_APPS_SCRIPT_SECRET_IN_VERCEL';
const SENDER_NAME = 'CrochetHub';

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request' });
  }
  if (!data || data.secret !== SECRET) return json_({ ok: false, error: 'Unauthorized' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const result = { ok: true, emailed: false, sheet: false };

    if (data.action === 'new_order' && data.order) {
      addOrder_(data.order);
      result.sheet = true;
    } else if (data.action === 'status_update' && data.order) {
      result.sheet = updateStatus_(data.order.orderNo, data.order.statusLabel);
    }

    if (data.email && data.email.to) {
      const quotaLeft = MailApp.getRemainingDailyQuota();
      if (quotaLeft > 0) {
        MailApp.sendEmail({
          to: data.email.to,
          subject: data.email.subject || 'CrochetHub',
          body: data.email.text || '',
          htmlBody: data.email.html || undefined,
          replyTo: data.email.replyTo || undefined,
          name: data.email.fromName || SENDER_NAME
        });
        result.emailed = true;
        if (data.action === 'new_order' && data.order) markEmailSent_(data.order.orderNo);
      } else {
        result.error = 'Daily Gmail sending limit reached';
      }
    }
    return json_(result);
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Visiting the web app URL in a browser shows this, so you can check it is live.
function doGet() {
  return json_({ ok: true, service: 'CrochetHub', quotaLeft: MailApp.getRemainingDailyQuota() });
}

/* ---------- sheet helpers ---------- */

function addOrder_(o) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const orders = sheet_(ss, 'Orders', ['Order no.', 'Shop (user ID)', 'Date', 'Status', 'Customer', 'Email', 'WhatsApp', 'Delivery address', 'Notes', 'Total (AED)', 'Email sent']);
  const items = sheet_(ss, 'Order items', ['Order no.', 'Shop (user ID)', 'Product', 'Qty', 'Unit price (AED)', 'Line total (AED)']);

  if (findRow_(orders, o.orderNo) > 0) return; // already recorded

  const r = orders.getLastRow() + 1;
  orders.getRange(r, 1, 1, 11).setValues([[
    o.orderNo, o.shop, new Date(o.createdAt), o.statusLabel || 'New',
    o.customer.name, o.customer.email, "'" + o.customer.whatsapp, o.customer.address, o.customer.notes || '',
    "=SUMIFS('Order items'!$F:$F,'Order items'!$A:$A,$A" + r + ')', 'No'
  ]]);
  orders.getRange(r, 3).setNumberFormat('yyyy-mm-dd hh:mm');
  orders.getRange(r, 10).setNumberFormat('#,##0.00;(#,##0.00);"-"');

  (o.items || []).forEach(function (it) {
    const ir = items.getLastRow() + 1;
    items.getRange(ir, 1, 1, 6).setValues([[o.orderNo, o.shop, it.name, it.qty, it.unitPrice, '=$D' + ir + '*$E' + ir]]);
    items.getRange(ir, 5, 1, 2).setNumberFormat('#,##0.00;(#,##0.00);"-"');
  });
}

function updateStatus_(orderNo, statusLabel) {
  const orders = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
  if (!orders) return false;
  const r = findRow_(orders, orderNo);
  if (r < 1) return false;
  orders.getRange(r, 4).setValue(statusLabel);
  return true;
}

function markEmailSent_(orderNo) {
  const orders = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
  const r = orders ? findRow_(orders, orderNo) : -1;
  if (r > 0) orders.getRange(r, 11).setValue('Yes');
}

function findRow_(sheet, orderNo) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(orderNo)) return i + 2;
  return -1;
}

function sheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* Run this once from the editor (select "authorize" → Run) to grant Gmail and Sheets access
   before deploying. It sends nothing; it only checks your remaining email quota. */
function authorize() {
  Logger.log('Emails left today: ' + MailApp.getRemainingDailyQuota());
  Logger.log('Sheet: ' + SpreadsheetApp.getActiveSpreadsheet().getName());
}
