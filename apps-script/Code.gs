/**
 * Craftifix — Google Apps Script web app
 * ---------------------------------------
 * Paste this into the "Craftifix Database" Google Sheet:
 *   Extensions → Apps Script → replace everything in Code.gs with this file → Save.
 * Then: Deploy → New deployment → type "Web app"
 *   Execute as: Me        Who has access: Anyone
 * Copy the Web app URL and give it to Claude (or add it in Vercel as APPS_SCRIPT_URL).
 *
 * What it does when the Craftifix website calls it:
 *   - new_order:     emails the order to the shop owner (from your Gmail) and adds it
 *                    to the Orders and Order items tabs
 *   - status_update: emails the status update to the customer and updates the
 *                    order's status in the Orders tab
 *   - new_inquiry:   emails the custom inquiry (with inspiration photos) to the shop owner
 *                    and adds it to the Inquiries tab, with photo previews
 *   - inquiry_status: updates the inquiry's status, last reply, quoted price and
 *                    order number in the Inquiries tab (and emails the customer a reply)
 *   - product_upsert / product_delete: keeps the Products tab in step with the shop
 *   - account_upsert: keeps the Accounts tab in step (sign-up, details, plan changes)
 *
 * SECRET must match APPS_SCRIPT_SECRET in Vercel. Do not share it.
 */
const SECRET = 'PASTE_THE_SAME_VALUE_AS_APPS_SCRIPT_SECRET_IN_VERCEL';
const SENDER_NAME = 'Craftifix';
let LAST_REPLY_ROW = 0;

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
    } else if (data.action === 'new_inquiry' && data.inquiry) {
      addInquiry_(data.inquiry);
      result.sheet = true;
    } else if (data.action === 'inquiry_status' && data.inquiry) {
      result.sheet = updateInquiryStatus_(data.inquiry);
    } else if (data.action === 'product_upsert' && data.product) {
      upsertProduct_(data.product); result.sheet = true;
    } else if (data.action === 'product_delete' && data.product) {
      result.sheet = deleteProduct_(data.product.id);
    } else if (data.action === 'account_upsert' && data.account) {
      upsertAccount_(data.account); result.sheet = true;
    }

    if (data.email && data.email.to) {
      const quotaLeft = MailApp.getRemainingDailyQuota();
      if (quotaLeft > 0) {
        MailApp.sendEmail({
          to: data.email.to,
          subject: data.email.subject || 'Craftifix',
          body: data.email.text || '',
          htmlBody: data.email.html || undefined,
          replyTo: data.email.replyTo || undefined,
          name: data.email.fromName || SENDER_NAME
        });
        result.emailed = true;
        if (data.action === 'new_order' && data.order) markEmailSent_(data.order.orderNo);
        if (data.action === 'new_inquiry' && data.inquiry) markInquiryEmailSent_(data.inquiry.inqNo);
        if (data.action === 'inquiry_status' && LAST_REPLY_ROW) {
          const rep = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Inquiry replies');
          if (rep) rep.getRange(LAST_REPLY_ROW, 8).setValue('Yes');
        }
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
  return json_({ ok: true, service: 'Craftifix', quotaLeft: MailApp.getRemainingDailyQuota() });
}

/* ---------- sheet helpers ---------- */

function addOrder_(o) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const orders = sheet_(ss, 'Orders', ['Order no.', 'Shop (user ID)', 'Date', 'Status', 'Customer', 'Email', 'WhatsApp', 'Delivery address', 'Notes', 'Total', 'Email sent', 'Source', 'From inquiry', 'Currency']);
  const items = sheet_(ss, 'Order items', ['Order no.', 'Shop (user ID)', 'Product', 'Qty', 'Unit price', 'Line total']);

  if (findRow_(orders, o.orderNo) > 0) return; // already recorded

  const r = orders.getLastRow() + 1;
  const fromInquiry = o.source && o.source.inqNo ? o.source.inqNo : '';
  orders.getRange(r, 1, 1, 14).setValues([[
    o.orderNo, o.shop, new Date(o.createdAt), o.statusLabel || 'New',
    o.customer.name, o.customer.email, "'" + o.customer.whatsapp, o.customer.address, o.customer.notes || '',
    "=SUMIFS('Order items'!$F:$F,'Order items'!$A:$A,$A" + r + ')', 'No',
    fromInquiry ? 'Converted from inquiry' : 'Shop order', fromInquiry, o.currency || 'AED'
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

const INQ_HEADERS = ['Inquiry no.', 'Shop (user ID)', 'Date', 'Status', 'Customer', 'Email', 'WhatsApp', 'Request', 'Budget', 'Needed by',
  'Option 1 notes', 'Option 1 photo', 'Option 1 photo link', 'Option 2 notes', 'Option 2 photo', 'Option 2 photo link', 'Email sent',
  'Last reply', 'Quoted price (AED)', 'Order no.'];

function addInquiry_(q) {
  const sh = sheet_(SpreadsheetApp.getActiveSpreadsheet(), 'Inquiries', INQ_HEADERS);
  if (findRow_(sh, q.inqNo) > 0) return; // already recorded
  const r = sh.getLastRow() + 1;
  const opt = function (i) { return (q.options || [])[i] || {}; };
  const img = function (url) { return url ? '=IMAGE("' + String(url).replace(/"/g, '') + '")' : ''; };
  sh.getRange(r, 1, 1, 17).setValues([[
    q.inqNo, q.shop, new Date(q.createdAt), q.statusLabel || 'New',
    q.customer.name, q.customer.email, "'" + q.customer.whatsapp, q.message, q.budget || '', q.neededBy || '',
    opt(0).note || '', img(opt(0).image), opt(0).image || '',
    opt(1).note || '', img(opt(1).image), opt(1).image || '', 'No'
  ]]);
  sh.getRange(r, 3).setNumberFormat('yyyy-mm-dd hh:mm');
  if (opt(0).image || opt(1).image) sh.setRowHeight(r, 120);
}

function updateInquiryStatus_(q) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Inquiries');
  if (!sh) return false;
  const r = findRow_(sh, q.inqNo);
  if (r < 1) return false;
  if (q.statusLabel) sh.getRange(r, 4).setValue(q.statusLabel);
  if (q.lastReply) {
    sh.getRange(r, 18).setValue(q.lastReply);
    const rep = sheet_(SpreadsheetApp.getActiveSpreadsheet(), 'Inquiry replies', ['Inquiry no.', 'Shop (user ID)', 'Customer', 'Replied at', 'Reply', 'Quoted price', 'Ready by', 'Emailed']);
    const rr = rep.getLastRow() + 1;
    rep.getRange(rr, 1, 1, 8).setValues([[q.inqNo, q.shop || '', q.customerName || '', q.replyAt ? new Date(q.replyAt) : new Date(), q.lastReply,
      q.price === undefined || q.price === null ? '' : q.price, q.readyBy || '', 'No']]);
    rep.getRange(rr, 4).setNumberFormat('yyyy-mm-dd hh:mm');
    LAST_REPLY_ROW = rr;
  }
  if (q.price !== undefined && q.price !== null) sh.getRange(r, 19).setValue(q.price).setNumberFormat('#,##0.00');
  if (q.orderNo) sh.getRange(r, 20).setValue(q.orderNo);
  return true;
}

function markInquiryEmailSent_(inqNo) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Inquiries');
  const r = sh ? findRow_(sh, inqNo) : -1;
  if (r > 0) sh.getRange(r, 17).setValue('Yes');
}

/* ---------- Products and Accounts ---------- */
const PRODUCT_HEADERS = ['Shop (user ID)', 'SKU', 'Product name', 'Category', 'Status', 'Stock qty', 'Production days', 'Customisable',
  'Materials (AED)', 'Accessories (AED)', 'Packaging (AED)', 'Hours', 'Hourly rate (AED)', 'Overhead %', 'Total cost (AED)', 'Pricing method',
  'Markup / margin %', 'Rounding (AED)', 'VAT added', 'Selling price (AED)', 'Customer price (AED)', 'Profit (AED)', 'Margin %',
  'Description', 'Photo URL', 'Created', 'Product ID'];
const METHOD_LABEL = { markup: 'Markup', margin: 'Gross margin', hourly: 'Hourly only', wholesale: 'Wholesale + retail' };

function findRowIn_(sheet, col, value) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const vals = sheet.getRange(2, col, last - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(value)) return i + 2;
  return -1;
}

function upsertProduct_(p) {
  const sh = sheet_(SpreadsheetApp.getActiveSpreadsheet(), 'Products', PRODUCT_HEADERS);
  let r = findRowIn_(sh, 27, p.id);
  if (r < 1) r = sh.getLastRow() + 1;
  const c = p.costing || {}, pr = p.pricing || {};
  sh.getRange(r, 1, 1, 27).setValues([[
    p.shop, p.sku || '', p.name, p.category || '', p.status === 'published' ? 'Published' : 'Draft', p.quantity || 0, p.productionDays || 0, p.customizable ? 'Yes' : 'No',
    c.materials || 0, c.accessories || 0, c.packaging || 0, c.hours || 0, c.rate || 0, (c.overheadPct || 0) / 100,
    '=($I' + r + '+$J' + r + '+$K' + r + '+$L' + r + '*$M' + r + ')*(1+$N' + r + ')', METHOD_LABEL[c.method] || c.method || '',
    c.method === 'hourly' ? '' : (c.pct || 0) / 100, c.round || 0, c.vat ? 'Yes' : 'No',
    pr.price || 0, pr.customerPrice || 0, '=$T' + r + '-$O' + r, '=IF($T' + r + '=0,0,$V' + r + '/$T' + r + ')',
    p.description || '', p.image || '', new Date(p.createdAt || new Date()), p.id
  ]]);
  sh.getRange(r, 9, 1, 3).setNumberFormat('#,##0.00;(#,##0.00);"-"');
  sh.getRange(r, 13, 1, 3).setNumberFormat('#,##0.00;(#,##0.00);"-"');
  sh.getRange(r, 14).setNumberFormat('0.0%;(0.0%);"-"');
  sh.getRange(r, 17).setNumberFormat('0.0%;(0.0%);"-"');
  sh.getRange(r, 20, 1, 3).setNumberFormat('#,##0.00;(#,##0.00);"-"');
  sh.getRange(r, 23).setNumberFormat('0.0%;(0.0%);"-"');
  sh.getRange(r, 26).setNumberFormat('yyyy-mm-dd hh:mm');
}

function deleteProduct_(id) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Products');
  if (!sh) return false;
  const r = findRowIn_(sh, 27, id);
  if (r < 1) return false;
  sh.deleteRow(r);
  return true;
}

const ACCOUNT_HEADERS = ['User ID', 'Name', 'Business', 'Email', 'WhatsApp', 'Plan', 'Plan price (per month)', 'Subscription status', 'Payment',
  'Member since', 'Last updated', 'Products', 'Orders', 'Order value', 'Shop currency', 'Logo', 'Instagram', 'Facebook', 'TikTok'];

function upsertAccount_(a) {
  const sh = sheet_(SpreadsheetApp.getActiveSpreadsheet(), 'Accounts', ACCOUNT_HEADERS);
  let r = findRowIn_(sh, 1, a.userId);
  if (r < 1) r = sh.getLastRow() + 1;
  const soc = a.social || {};
  sh.getRange(r, 1, 1, 19).setValues([[
    a.userId, a.name, a.business, a.email, a.whatsapp ? "'" + a.whatsapp : '', a.plan, a.planPrice, a.status, a.payment,
    new Date(a.createdAt), new Date(a.updatedAt),
    '=COUNTIF(Products!$A:$A,$A' + r + ')', '=COUNTIF(Orders!$B:$B,$A' + r + ')',
    '=SUMIFS(Orders!$J:$J,Orders!$B:$B,$A' + r + ',Orders!$D:$D,"<>Cancelled")',
    a.currency || 'AED', a.logo ? '=IMAGE("' + String(a.logo).replace(/"/g, '') + '")' : '',
    soc.instagram || '', soc.facebook || '', soc.tiktok || ''
  ]]);
  sh.getRange(r, 10, 1, 2).setNumberFormat('yyyy-mm-dd hh:mm');
  sh.getRange(r, 14).setNumberFormat('#,##0.00;(#,##0.00);"-"');
  if (a.logo) sh.setRowHeight(r, 70);
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
