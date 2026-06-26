/****************************************************************
 * Rattana Online Order — Apps Script Backend  v1.12
 * --------------------------------------------------------------
 * รับข้อมูลจากแอป rattana-online-order.html แล้วบันทึกลง Google Sheet
 *   action: "register"  -> เขียนแถวลงชีทลงทะเบียน (gid 1357794184)
 *   action: "order"     -> เขียนรายการลงชีท "Orders" (สร้างให้อัตโนมัติถ้ายังไม่มี)
 *
 * วิธี deploy:
 *   1. เปิด https://script.google.com -> New project
 *   2. วางโค้ดนี้ทั้งหมด
 *   3. Deploy -> New deployment -> type: Web app
 *        Execute as: Me
 *        Who has access: Anyone
 *   4. คัดลอก Web app URL ไปวางใน CFG.GAS_URL ในไฟล์ HTML
 ****************************************************************/

// ───── ชีทปลายทาง ─────
var REG_SPREADSHEET_ID = '18RSfuDdCadccWS_3v_Ggi70_X8FGEIVGrGUedkQLYUw';
var REG_SHEET_GID      = 1357794184;   // แท็บหน้าลงทะเบียน
var ORDER_SHEET_NAME   = 'order';      // แท็บเก็บออเดอร์ (ชื่อแท็บจริง)
var ORDER_SHEET_GID    = 1594322176;   // สำรอง: เผื่อเปลี่ยนชื่อแท็บ

// ───── LINE Messaging API (ส่งสรุปออเดอร์เข้าไลน์ลูกค้า) ─────
// เอา Channel access token (long-lived) จาก LINE Developers > channel Messaging API ของ OA Rattana_Official
var LINE_TOKEN = 'PASTE_LINE_MESSAGING_API_CHANNEL_ACCESS_TOKEN';

// ───── Supabase (เก็บออเดอร์ลงฐานข้อมูลด้วย — dual-write) ─────
// SUPABASE_URL = Project URL (เช่น https://abcd.supabase.co)
// SUPABASE_KEY = service_role key (Settings > API) — เก็บใน .gs เท่านั้น ห้ามใส่ในฝั่งเว็บ
var SUPABASE_URL = 'https://ncmgqigufxmlgiqfisdf.supabase.co';
var SUPABASE_KEY = 'PASTE_SERVICE_ROLE_KEY';
/* ── ทดสอบ: เลือกฟังก์ชันนี้ใน Apps Script แล้วกด Run → ดู Execution log ว่าได้ HTTP อะไร ── */
function testSupabaseInsert(){
  var resp = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/roo_sales', {
    method:'post', contentType:'application/json',
    headers:{ apikey:SUPABASE_KEY, Authorization:'Bearer '+SUPABASE_KEY, Prefer:'return=representation' },
    payload: JSON.stringify([{ date:'2026-06-23', time:'TEST', orderid:'TEST-'+new Date().getTime(), product_name:'ทดสอบ Supabase', qty:1, total:0 }]),
    muteHttpExceptions:true
  });
  Logger.log('URL = ' + SUPABASE_URL);
  Logger.log('KEY set? = ' + (SUPABASE_KEY && SUPABASE_KEY.indexOf('PASTE')<0));
  Logger.log('HTTP ' + resp.getResponseCode());
  Logger.log('BODY ' + resp.getContentText());
}
function pushOrderToSupabase(d){
  if(!SUPABASE_URL || SUPABASE_URL.indexOf('PASTE')>=0 || !SUPABASE_KEY || SUPABASE_KEY.indexOf('PASTE')>=0) return; // ยังไม่ตั้งค่า
  var now = new Date();
  var dateISO = Utilities.formatDate(now,'Asia/Bangkok','yyyy-MM-dd');   // date type -> ISO
  var timeStr = Utilities.formatDate(now,'Asia/Bangkok','HH:mm');        // time column ควรเป็น text
  var rows = (d.items||[]).map(function(it){
    return {
      date: dateISO, time: timeStr, email: d.uid||'',
      salesman_name: d.salemanName||'', salesman_code: d.salemanCode||'',
      wh: d.warehouse||'', customer_name: d.customerName||'', customer_code: d.shopCode||'',
      tran_type: it.type||'', barcode: String(it.barcode||''), product_name: it.name||'',
      status: '',                                       // = "ยกเลิก" (ว่าง = ไม่ยกเลิก)
      qty: Number(it.qty)||0, unit: it.unit||'',
      price: Number(it.price)||0, total: Number(it.total)||0,
      orderid: d.orderId||'', note: d.note||'',
      wh_ship: d.warehouse||'',
      approve_status: it.status||d.status||'',          // สถานะอนุมัติ: รออนุมัติ/อนุมัติ/ไม่อนุมัติ
      promotion: it.promo||''
    };
  });
  if(!rows.length) return;
  var base = SUPABASE_URL + '/rest/v1/roo_sales';
  // ── กันออเดอร์ซ้ำ (upsert แบบยึด orderId) ──
  // ถ้า orderId นี้เคยบันทึกแล้ว (กดยืนยันรัว / เน็ตส่งซ้ำ / แก้ออเดอร์แล้วส่งใหม่ด้วย orderId เดิม)
  // ลบแถวเดิมของ orderId นั้นทิ้งก่อน แล้วค่อยเขียนชุดใหม่ → เหลือชุดเดียวเสมอ ไม่มีแถวซ้ำ
  var oid = d.orderId || '';
  if(oid){
    UrlFetchApp.fetch(base + '?orderid=eq.' + encodeURIComponent(oid), {
      method:'delete',
      headers:{ apikey:SUPABASE_KEY, Authorization:'Bearer '+SUPABASE_KEY, Prefer:'return=minimal' },
      muteHttpExceptions:true
    });
  }
  UrlFetchApp.fetch(base, {
    method:'post', contentType:'application/json',
    headers:{ apikey:SUPABASE_KEY, Authorization:'Bearer '+SUPABASE_KEY, Prefer:'return=minimal' },
    payload: JSON.stringify(rows), muteHttpExceptions:true
  });
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.action === 'register') return json(handleRegister(data));
    if (data.action === 'order')    return json(handleOrder(data));
    if (data.action === 'syncOrder') return json(handleSyncOrder(data));
    if (data.action === 'linkUid')  return json(handleLinkUid(data));
    if (data.action === 'saveCart') return json(handleSaveCart(data));
    return json({ ok:false, error:'unknown action' });
  } catch (err) {
    return json({ ok:false, error:String(err) });
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'getCart') {
    var r = getCartFor(p.phone);
    return p.callback ? jsonp(p.callback, r) : json(r);   // JSONP = อ่านข้าม origin จากเบราว์เซอร์ได้
  }
  if (p.action === 'getOrders') {
    var ro = getOrdersFor(p.shop);
    return p.callback ? jsonp(p.callback, ro) : json(ro);
  }
  return json({ ok:true, service:'Rattana Online Order', time:new Date() });
}
function jsonp(cb, obj){ return ContentService.createTextOutput(cb + '(' + JSON.stringify(obj) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT); }

/* ───────── ตะกร้าร่วม (ซิงค์ข้ามเครื่องของร้านเดียวกัน ผูกด้วยเบอร์) ───────── */
function getCartSheet(){
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = ss.getSheetByName('ตะกร้า');
  if(!sh){ sh = ss.insertSheet('ตะกร้า'); sh.appendRow(['เบอร์','ชื่อร้าน','User ID','อัปเดตเมื่อ','จำนวนรายการ','ยอดรวม','รายการ(JSON)','ts','orderId']); }
  return sh;
}
function handleSaveCart(d){
  var sh = getCartSheet();
  var phone = String(d.phone||'').replace(/\D/g,''); if(!phone) return { ok:false, error:'no phone' };
  var cartStr = d.cart || '[]'; var cart=[]; try{ cart=JSON.parse(cartStr); }catch(e){}
  var orderId = String(d.orderId||'');
  var count=0, total=0; cart.forEach(function(it){ var q=Number(it.qty)||0; count+=q; total+=q*(Number(it.price)||0); });
  var ts = Number(d.ts) || (new Date().getTime());
  var now = Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yyyy HH:mm');
  var last = sh.getLastRow(), rowIdx=-1;
  if(last>=2){ var col=sh.getRange(2,1,last-1,1).getValues();
    for(var i=0;i<col.length;i++){ if(String(col[i][0]).replace(/\D/g,'')===phone){ rowIdx=i+2; break; } } }
  // ตะกร้าว่าง -> ไม่ลบแถว แต่บันทึกว่าง + ts ใหม่ + orderId ว่าง (ส่งสัญญาณให้เครื่องอื่นเคลียร์ตะกร้า+เริ่ม draft ใหม่)
  if(!cart.length){
    if(rowIdx>0) sh.getRange(rowIdx,1,1,9).setValues([[ "'"+phone, d.name||'', d.uid||'', now, 0, 0, '[]', ts, '' ]]);
    return { ok:true, cleared:true, ts:ts };
  }
  var row = [ "'"+phone, d.name||'', d.uid||'', now, count, total, cartStr, ts, orderId ];
  if(rowIdx>0) sh.getRange(rowIdx,1,1,row.length).setValues([row]); else sh.appendRow(row);
  return { ok:true, ts:ts, orderId:orderId };
}
function getCartFor(phone){
  var target=String(phone||'').replace(/\D/g,''); if(!target) return { ok:true, cart:[], ts:0, orderId:'' };
  var sh=getCartSheet(); var last=sh.getLastRow(); if(last<2) return { ok:true, cart:[], ts:0, orderId:'' };
  var w=Math.max(9, sh.getLastColumn());
  var vals=sh.getRange(2,1,last-1,w).getValues();
  for(var i=0;i<vals.length;i++){
    if(String(vals[i][0]).replace(/\D/g,'')===target){
      var cart=[]; try{ cart=JSON.parse(String(vals[i][6]||'[]')); }catch(e){}
      return { ok:true, cart:cart, ts:Number(vals[i][7])||0, name:vals[i][1]||'', orderId:String(vals[i][8]||'') };
    }
  }
  return { ok:true, cart:[], ts:0, orderId:'' };
}
// เคลียร์ตะกร้าร่วม (หลังยืนยันออเดอร์) — ไม่ลบแถว แต่ตั้งว่าง + ts ใหม่ → เครื่องอื่นพอ pull เจอ ts ใหม่ จะเคลียร์ตะกร้าตาม
function clearCartFor(phone){
  var target=String(phone||'').replace(/\D/g,''); if(!target) return;
  var sh=getCartSheet(); var last=sh.getLastRow(); if(last<2) return;
  var col=sh.getRange(2,1,last-1,1).getValues();
  var now=Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yyyy HH:mm');
  for(var i=0;i<col.length;i++){ if(String(col[i][0]).replace(/\D/g,'')===target){
    sh.getRange(i+2,1,1,9).setValues([[ "'"+target, '', '', now, 0, 0, '[]', new Date().getTime(), '' ]]); return;
  } }
}

/* ───────── ดึงออเดอร์ "อนุมัติ" ทั้งหมดของร้าน (จับจากชื่อร้าน) — ใช้ในหน้า "สรุปออเดอร์" ───────── */
function getOrdersFor(shop){
  var out = { ok:true, orders:[] };
  shop = String(shop||'').trim(); if(!shop) return out;
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = ss.getSheetByName(ORDER_SHEET_NAME) || getSheetByGid(ss, ORDER_SHEET_GID);
  if(!sh) return out;
  var headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  function col(name){ for(var i=0;i<headers.length;i++){ if(normHead(headers[i])===normHead(name)) return i; } return -1; }
  var c = { date:col('วัน'), time:col('เวลา'), shop:col('ชื่อร้าน'), type:col('รูปแบบ'), bc:col('Barcode'),
            name:col('ชื่อสินค้า'), qty:col('จำนวน'), unit:col('หน่วย'), price:col('ราคา'),
            total:col('ยอดเงินรวม'), oid:col('orderId'), status:col('สถานะอนุมัติ'),
            pickStatus:col('สถานะจัด'), billId:col('billId'), pickDate:col('วันสั่งจัด'), shipDate:col('วันกำหนดส่ง') };
  if(c.shop<0 || c.status<0) return out;
  var last = sh.getLastRow(); if(last<2) return out;
  var data = sh.getRange(2,1,last-1,headers.length).getValues();
  function gv(r, idx){ return idx>=0 ? String(r[idx]||'') : ''; }
  function fdate(v){ return (v instanceof Date) ? Utilities.formatDate(v,'Asia/Bangkok','dd/MM/yyyy') : String(v||''); }
  function ftime(v){ return (v instanceof Date) ? Utilities.formatDate(v,'Asia/Bangkok','HH.mm') : String(v||''); }
  data.forEach(function(r){
    if(String(r[c.shop]).trim() !== shop) return;
    if(String(r[c.status]||'').trim() !== 'อนุมัติ') return;
    out.orders.push({
      date:fdate(r[c.date]), time:ftime(r[c.time]),
      type:String(r[c.type]||''), barcode:String(r[c.bc]||''), name:String(r[c.name]||''),
      qty:Number(r[c.qty])||0, unit:String(r[c.unit]||''), price:Number(r[c.price])||0,
      total:Number(r[c.total])||0, orderId:String(r[c.oid]||''),
      pickStatus:gv(r,c.pickStatus), billId:gv(r,c.billId), pickDate:gv(r,c.pickDate), shipDate:gv(r,c.shipDate)
    });
  });
  return out;
}

/* ───────── ลงทะเบียนลูกค้า ───────── */
function handleRegister(d) {
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = getSheetByGid(ss, REG_SHEET_GID);
  if (!sh) return { ok:false, error:'reg sheet not found' };

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function(h){ return String(h).trim(); });
  var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');

  // map ค่าตามชื่อหัวคอลัมน์ของชีท
  var values = {
    'วันที่ลงทะเบียน': now,
    'ชื่อ / ร้านค้า':  d['ชื่อ / ร้านค้า'] || '',
    'เบอร์โทรศัพท์':   "'" + (d['เบอร์โทรศัพท์'] || ''),  // กัน 0 หาย
    'บ้านเลขที่':      d['บ้านเลขที่'] || '',
    'หมู่':            d['หมู่'] || '',
    'ตำบล':            d['ตำบล'] || '',
    'อำเภอ':           d['อำเภอ'] || '',
    'จังหวัด':         d['จังหวัด'] || '',
    'รหัสไปรษณีย์':    d['รหัสไปรษณีย์'] || '',
    'ปีเกิด (พ.ศ.)':   d['ปีเกิด (พ.ศ.)'] || '',
    'เดือนเกิด':       d['เดือนเกิด'] || '',
    'วันเกิด':         d['วันเกิด'] || '',
    'หมายเหตุ':        d['หมายเหตุ'] || '',
    'Latitude':        d['Latitude'] || '',
    'Longitude':       d['Longitude'] || '',
    'Google Maps Link': (d['Latitude'] && d['Longitude']) ? ('https://www.google.com/maps?q=' + d['Latitude'] + ',' + d['Longitude']) : '',
    'สถานะ':           d['สถานะ'] || 'รอยืนยัน',
    'User ID':         d['User ID'] || '',
    'เลขบัตร/ภพ.20':   d['เลขบัตร/ภพ.20'] || '',
    'Saleman Code':    '',
    'Saleman Name':    ''
  };

  var row = headers.map(function(h){ return values.hasOwnProperty(h) ? values[h] : ''; });
  sh.appendRow(row);
  return { ok:true, message:'registered' };
}

/* แปลงชื่อ/รหัสเซลล์สำหรับออเดอร์จาก Roo: ชื่อ + " (ROO)"; รหัส PMW102→ROW102 (PM→RO), HSW104→ROH104 (HSW→ROH) */
function applySalesmanFormat(d) {
  if (d.salemanName) { var n = String(d.salemanName).trim(); if (n && n.indexOf('(ROO)') < 0) d.salemanName = n + ' (ROO)'; }
  if (d.salemanCode) { d.salemanCode = String(d.salemanCode).replace(/^HSW/, 'ROH').replace(/^PM/, 'RO'); }
}

/* ───────── เขียน/อัปเดตรายการออเดอร์ลงแท็บ "order" ─────────
   - แถวใหม่ (สินค้านี้ยังไม่เคยมีใน orderId นี้) → append เขียนครั้งเดียว
   - แถวเดิม (orderId + บาร์โค้ด + รูปแบบ + หน่วย ตรงกัน) → อัปเดตเฉพาะ "สถานะอนุมัติ / จำนวน / ราคา / ยอดเงินรวม"
     *ไม่ลบแถว ไม่แตะคอลัมน์อื่น* (ผู้อนุมัติ/วันกำหนดส่ง/billId/สถานะจัด ฯลฯ ที่แอดมินกรอกไว้ยังอยู่ครบ) */
// รูปแบบมีแค่ "ขาย"/"แถม" — ค่าหน่วยที่หลุดมา (CS/PA/EA) หรืออื่นๆ ที่ไม่ใช่ "แถม" ถือเป็น "ขาย"
function typeKey(t){ return String(t||'').trim()==='แถม' ? 'แถม' : 'ขาย'; }
function lineKey(barcode, type, unit){
  return String(barcode||'').trim() + '|' + typeKey(type) + '|' + String(unit||'').trim();
}
function writeOrderToSheet(d, opts) {
  opts = opts || {};
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = ss.getSheetByName(ORDER_SHEET_NAME) || getSheetByGid(ss, ORDER_SHEET_GID);
  if (!sh) return { ok:false, error:'order sheet "' + ORDER_SHEET_NAME + '" not found', sh:null };
  // ── ล็อกสคริปต์: กัน syncOrder กับ confirm (หรือ sync ถี่ๆ) วิ่งชนกันแล้ว append แถวซ้ำ ──
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch(e){}
  try {
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    function col(name){ for (var i=0;i<headers.length;i++){ if (normHead(headers[i])===normHead(name)) return i; } return -1; }
    var oidCol=col('orderId'), bcCol=col('Barcode'), typeCol=col('รูปแบบ'), unitCol=col('หน่วย');
    var qtyCol=col('จำนวน'), priceCol=col('ราคา'), totalCol=col('ยอดเงินรวม'), statusCol=col('สถานะอนุมัติ');
    var items = d.items || [];

    // map เฉพาะ "แถวที่ยังไม่จบ" (สถานะยังไม่ใช่ อนุมัติ/ไม่อนุมัติ) ของ orderId นี้ : key → {row}
    var live = {}, hasApproved = false;
    var last = sh.getLastRow();
    if (last >= 2 && oidCol >= 0) {
      var data = sh.getRange(2, 1, last-1, headers.length).getValues();
      for (var r=0; r<data.length; r++){
        if (String(data[r][oidCol]).trim() !== String(d.orderId||'').trim()) continue;
        var st = statusCol>=0 ? String(data[r][statusCol]||'') : '';
        if (st === 'อนุมัติ') hasApproved = true;
        if (st === 'อนุมัติ' || st === 'ไม่อนุมัติ') continue;   // จบแล้ว — ข้าม ไม่จับคู่ ไม่แตะ
        live[ lineKey(data[r][bcCol], data[r][typeCol], data[r][unitCol]) ] = { row: r+2 };
      }
    }
    // ออเดอร์นี้ยืนยันแล้ว (มีแถวอนุมัติ) + เป็น syncOrder ที่ค้างมาทีหลัง → ไม่ทำอะไร กันแถว "รออนุมัติ" ซ้ำ
    if (opts.skipIfConfirmed && hasApproved) return { ok:true, skipped:'confirmed', sh:sh };

    var sent = {};
    items.forEach(function(it){
      var st = it.status || d.status || '';
      if (st === 'ไม่อนุมัติ') return;   // รายการที่ถูกลบ — ปล่อยให้ลูป "แถวที่ไม่ถูกส่ง" มาร์คครั้งเดียว
      var key = lineKey(it.barcode, it.type, it.unit);
      sent[key] = 1;
      var ex = live[key];
      if (ex) {
        // อัปเดตในแถวเดิม — แตะเฉพาะช่องที่เปลี่ยนได้ (สถานะ/จำนวน/ราคา/ยอด)
        if (statusCol>=0) sh.getRange(ex.row, statusCol+1).setValue(st);
        if (qtyCol>=0)    sh.getRange(ex.row, qtyCol+1).setValue(it.qty || 0);
        if (priceCol>=0)  sh.getRange(ex.row, priceCol+1).setValue(it.price || 0);
        if (totalCol>=0)  sh.getRange(ex.row, totalCol+1).setValue(it.total || 0);
      } else {
        appendOrderRow(sh, headers, bcCol, d, it);
        live[key] = { row: sh.getLastRow() };
      }
    });

    // แถวที่ยังไม่จบ แต่ไม่ถูกส่งมาในรอบนี้ (สินค้าที่ลบ + ของแถมของมัน) → มาร์ค "ไม่อนุมัติ" ครั้งเดียว
    if (statusCol >= 0) {
      for (var kk in live) {
        if (!sent[kk]) sh.getRange(live[kk].row, statusCol+1).setValue('ไม่อนุมัติ');
      }
    }
    return { ok:true, count:items.length, sh:sh };
  } finally {
    try { lock.releaseLock(); } catch(e){}
  }
}

// append แถวใหม่เต็มแถว (เฉพาะสินค้าที่ยังไม่เคยมีใน orderId นี้)
function appendOrderRow(sh, headers, bcCol, d, it) {
  var now = new Date();
  var v = {
    'วัน': Utilities.formatDate(now,'Asia/Bangkok','dd/MM/yyyy'),
    'เวลา': Utilities.formatDate(now,'Asia/Bangkok','HH.mm'),
    'email': d.uid || '',
    'ชื่อ-สกุล': d.salemanName || '', 'รหัสเซลล์': d.salemanCode || '', 'คลัง': d.warehouse || '', 'คลังส่ง': d.warehouse || '',
    'ชื่อร้าน': d.customerName || '', 'รหัสร้าน': d.shopCode || '',
    'รูปแบบ': typeKey(it.type), 'Barcode': (it.barcode || ''), 'ชื่อสินค้า': it.name || '',
    'ยกเลิก': '', 'จำนวน': it.qty || 0, 'หน่วย': it.unit || '', 'ราคา': it.price || 0,
    'ยอดเงินรวม': (it.total || 0), 'orderId': d.orderId || '',
    'สถานะอนุมัติ': it.status || d.status || '',   // รออนุมัติ / อนุมัติ / ไม่อนุมัติ
    'lineId': d.uid || '',                         // LINE userId
    'โปรที่ใช้': it.promo || '',
    'หมายเหตุ': d.note || ''
  };
  var vmap = {};
  for (var k in v) vmap[normHead(k)] = v[k];
  var row = headers.map(function(h){ var n = normHead(h); return vmap.hasOwnProperty(n) ? vmap[n] : ''; });
  sh.appendRow(row);
  if (bcCol >= 0) { var lr = sh.getLastRow(); var bcell = sh.getRange(lr, bcCol+1); bcell.setNumberFormat('@'); bcell.setValue(String(it.barcode || '')); }
}

// ลบแถวในแท็บ order ที่ orderId ตรงกัน (ไล่จากล่างขึ้นบน) — ใช้กันซ้ำ/อัปเดตทั้งชุด
function deleteSheetRowsByOrderId(sh, headers, orderId) {
  if (!orderId) return;
  var oidCol = -1;
  for (var i=0; i<headers.length; i++){ if (normHead(headers[i])===normHead('orderId')){ oidCol=i; break; } }
  if (oidCol < 0) return;
  var last = sh.getLastRow(); if (last < 2) return;
  var col = sh.getRange(2, oidCol+1, last-1, 1).getValues();
  for (var r=col.length-1; r>=0; r--){
    if (String(col[r][0]).trim() === String(orderId).trim()) sh.deleteRow(r+2);
  }
}

/* ลายเซ็นออเดอร์ = ร้าน(เบอร์) + รายการขายทั้งหมด (บาร์โค้ด:จำนวน:หน่วย) เรียงแล้ว — ใช้ตรวจออเดอร์ซ้ำ */
function orderSignature(d) {
  var its = (d.items || []).filter(function(it){ return typeKey(it.type)!=='แถม' && String(it.status||'')!=='ไม่อนุมัติ'; })
    .map(function(it){ return String(it.barcode||it.name||'')+':'+(it.qty||0)+':'+String(it.unit||''); }).sort();
  return its.join('|');
}
/* ───────── ยืนยันออเดอร์ (สถานะ "อนุมัติ") → เขียนชีท+Supabase + ส่ง LINE + ล้างตะกร้า ───────── */
function handleOrder(d) {
  applySalesmanFormat(d);                            // ชื่อ +" (ROO)", รหัส PM→RO
  if (!d.status) d.status = 'อนุมัติ';              // กดยืนยัน = อนุมัติ (ถ้าแอปไม่ได้ส่ง status รายชิ้นมา)
  // ── กันออเดอร์เบิ้ลจากหลายเครื่อง/กดซ้ำ: ร้านเดียวกัน + รายการเหมือนเดิม ภายใน 2 นาที = ซ้ำ → ไม่เขียน/ไม่ push ซ้ำ ──
  var phone = String(d.phone||'').replace(/\D/g,'');
  var sig = orderSignature(d);
  var props = PropertiesService.getScriptProperties();
  var pkey = 'lastorder_' + phone;
  if (phone && sig) {
    var prev = props.getProperty(pkey);              // รูปแบบ "sig~~epochMillis"
    if (prev) {
      var sep = prev.lastIndexOf('~~');
      if (sep > 0 && prev.slice(0,sep)===sig && (new Date().getTime() - Number(prev.slice(sep+2)||0)) < 120000) {
        return { ok:true, message:'duplicate ignored', dedup:true };
      }
    }
    props.setProperty(pkey, sig + '~~' + new Date().getTime());   // จองสิทธิ์ก่อนเขียน (กันสองเครื่องชนกัน)
  }
  var r = writeOrderToSheet(d);
  if (!r.ok) return r;
  try { pushLineOrder(d, r.sh); } catch (e) {}      // ส่งสรุปเข้าไลน์ลูกค้า (ทุก User ID ของร้าน)
  try { pushOrderToSupabase(d); } catch (e) {}      // dual-write Supabase
  clearCartFor(d.phone);                            // ยืนยันแล้ว -> ล้างตะกร้าร่วมของร้าน
  return { ok:true, message:'order saved', count:r.count };
}

/* ───────── ซิงค์ตะกร้าแบบ real-time (ใส่=รออนุมัติ / ลบ=ไม่อนุมัติ) → เขียนชีท+Supabase (ไม่ส่ง LINE/ไม่ล้างตะกร้า) ───────── */
function handleSyncOrder(d) {
  if (!d.orderId) return { ok:false, error:'no orderId' };
  applySalesmanFormat(d);                            // ชื่อ +" (ROO)", รหัส PM→RO
  var r = writeOrderToSheet(d, {skipIfConfirmed:true});   // ออเดอร์ที่ยืนยันแล้ว → ไม่เขียนซ้ำ
  if (!r.ok) return r;
  try { pushOrderToSupabase(d); } catch (e) {}      // dual-write Supabase ด้วยสถานะรายชิ้น
  return { ok:true, message:'order synced', count:r.count };
}

/* ═══════════════════════════════════════════════════════════════════
   เฟส 4 — onEdit sync: แก้ในแท็บ "order" ด้วยมือ → ดันขึ้น Supabase อัตโนมัติ
   *** ต้องตั้งเป็น INSTALLABLE trigger (UrlFetchApp ใช้ใน simple onEdit ไม่ได้) ***
   วิธีตั้ง: เลือกฟังก์ชัน createOrderEditTrigger() แล้วกด Run หนึ่งครั้ง (อนุญาตสิทธิ์)
   ═══════════════════════════════════════════════════════════════════ */
function createOrderEditTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t){ if (t.getHandlerFunction()==='onOrderEdit') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('onOrderEdit').forSpreadsheet(SpreadsheetApp.openById(REG_SPREADSHEET_ID)).onEdit().create();
  return 'onOrderEdit trigger installed';
}

// fire ทุกครั้งที่ "คน" แก้เซลล์ในชีท (การเขียนจาก Apps Script ไม่ trigger → ไม่วน loop)
function onOrderEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (sh.getName() !== ORDER_SHEET_NAME) return;          // เฉพาะแท็บ order
    if (e.range.getRow() < 2) return;                        // ข้าม header
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var oidCol = -1; for (var i=0; i<headers.length; i++){ if (normHead(headers[i])===normHead('orderId')){ oidCol=i; break; } }
    if (oidCol < 0) return;
    // แก้หลายแถวพร้อมกัน (เช่น วาง/ลบหลายแถว) → ไล่ทุก orderId ที่เกี่ยวข้อง
    var startRow = e.range.getRow(), nRows = e.range.getNumRows();
    var seen = {};
    var oids = sh.getRange(startRow, oidCol+1, nRows, 1).getValues();
    for (var k=0; k<oids.length; k++){
      var oid = String(oids[k][0]).trim();
      if (oid && !seen[oid]) { seen[oid]=1; syncOrderIdToSupabase(sh, headers, oid); }
    }
  } catch (err) { /* เงียบ — กัน trigger ล้ม */ }
}

// อ่านทุกแถวของ orderId จากชีท → upsert ขึ้น Supabase (ลบ orderid เดิม + insert ชุดล่าสุด)
function syncOrderIdToSupabase(sh, headers, orderId) {
  if (!SUPABASE_URL || SUPABASE_URL.indexOf('PASTE')>=0 || !SUPABASE_KEY || SUPABASE_KEY.indexOf('PASTE')>=0) return;
  if (!orderId) return;
  var last = sh.getLastRow(); if (last < 2) return;
  function ci(name){ for (var i=0;i<headers.length;i++){ if (normHead(headers[i])===normHead(name)) return i; } return -1; }
  var c = {
    date:ci('วัน'), time:ci('เวลา'), uid:ci('email'), sname:ci('ชื่อ-สกุล'), scode:ci('รหัสเซลล์'),
    wh:ci('คลัง'), whship:ci('คลังส่ง'), cname:ci('ชื่อร้าน'), ccode:ci('รหัสร้าน'),
    type:ci('รูปแบบ'), barcode:ci('Barcode'), pname:ci('ชื่อสินค้า'),
    cancel:ci('ยกเลิก'), qty:ci('จำนวน'), unit:ci('หน่วย'), price:ci('ราคา'), total:ci('ยอดเงินรวม'),
    oid:ci('orderId'), note:ci('หมายเหตุ'), promo:ci('โปรที่ใช้'),
    shipDate:ci('วันกำหนดส่ง'), apprStatus:ci('สถานะอนุมัติ'), apprUser:ci('ผู้อนุมัติ'), apprTime:ci('เวลาอนุมัติ'),
    saleNote:ci('เหตุผลที่ขอ'), diffPrice:ci('ส่วนต่างราคา'), recPrice:ci('ราคาแนะนำ'), reqPrice:ci('ราคาขอขาย')
  };
  if (c.oid < 0) return;
  function g(r, idx){ return idx>=0 ? r[idx] : ''; }
  function toISO(v){
    if (v instanceof Date) return Utilities.formatDate(v,'Asia/Bangkok','yyyy-MM-dd');
    var s=String(v||''); var m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? (m[3]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[1]).slice(-2)) : s;
  }
  function txt(v){ var s=String(v==null?'':v); return s===''?null:s; }                                            // text → null ถ้าว่าง
  function numOrNull(v){ var s=String(v==null?'':v).replace(/,/g,'').trim(); if(s==='') return null; var n=Number(s); return isNaN(n)?null:n; }
  function dOrNull(v){ if(v==null||String(v)==='') return null; return toISO(v); }
  var data = sh.getRange(2, 1, last-1, headers.length).getValues();
  var rows = [];
  data.forEach(function(r){
    if (String(g(r,c.oid)).trim() !== String(orderId).trim()) return;
    rows.push({
      date:toISO(g(r,c.date)), time:String(g(r,c.time)||''), email:String(g(r,c.uid)||''),
      salesman_name:String(g(r,c.sname)||''), salesman_code:String(g(r,c.scode)||''),
      wh:String(g(r,c.wh)||''), customer_name:String(g(r,c.cname)||''), customer_code:String(g(r,c.ccode)||''),
      tran_type:String(g(r,c.type)||''), barcode:String(g(r,c.barcode)||''), product_name:String(g(r,c.pname)||''),
      status:String(g(r,c.cancel)||''), qty:Number(g(r,c.qty))||0, unit:String(g(r,c.unit)||''),
      price:Number(g(r,c.price))||0, total:Number(g(r,c.total))||0, orderid:String(orderId),
      note:String(g(r,c.note)||''), wh_ship:String(g(r,c.whship)||g(r,c.wh)||''),
      promotion:String(g(r,c.promo)||''),
      approve_status:String(g(r,c.apprStatus)||''),
      approve_user:txt(g(r,c.apprUser)), approve_time:txt(g(r,c.apprTime)), ship_date:dOrNull(g(r,c.shipDate)),
      sale_note:txt(g(r,c.saleNote)),
      diff_price:numOrNull(g(r,c.diffPrice)), recommend_price:numOrNull(g(r,c.recPrice)), request_price:numOrNull(g(r,c.reqPrice))
    });
  });
  var base = SUPABASE_URL + '/rest/v1/roo_sales';
  UrlFetchApp.fetch(base + '?orderid=eq.' + encodeURIComponent(orderId), {
    method:'delete', headers:{ apikey:SUPABASE_KEY, Authorization:'Bearer '+SUPABASE_KEY, Prefer:'return=minimal' }, muteHttpExceptions:true
  });
  if (rows.length) UrlFetchApp.fetch(base, {
    method:'post', contentType:'application/json',
    headers:{ apikey:SUPABASE_KEY, Authorization:'Bearer '+SUPABASE_KEY, Prefer:'return=minimal' },
    payload: JSON.stringify(rows), muteHttpExceptions:true
  });
}

/* ───────── ส่งสรุปออเดอร์เป็น Flex Message เข้าไลน์ลูกค้า ───────── */
function numFmt(n){ n=Math.round(Number(n)||0); return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function cumulativeFor(sh, uid){
  var out={spend:0, items:0};
  if(!uid) return out;
  var H = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(function(x){return String(x).trim();});
  var emailC=H.indexOf('email'), billC=H.indexOf('ยอดเงินรวม'), nameC=H.indexOf('ชื่อสินค้า'), typeC=H.indexOf('รูปแบบ');
  if(emailC<0) return out;
  var last=sh.getLastRow(); if(last<2) return out;
  var vals=sh.getRange(2,1,last-1,sh.getLastColumn()).getValues();
  vals.forEach(function(r){
    if(String(r[emailC])===uid){
      if(billC>=0 && r[billC]!=='' && !isNaN(Number(r[billC]))) out.spend+=Number(r[billC]);
      if(nameC>=0 && String(r[nameC]).trim() && (typeC<0 || r[typeC]!=='แถม')) out.items+=1;
    }
  });
  return out;
}
/* รวม User ID ทุกไลน์ของร้าน (เบอร์เดียวกัน): User ID + User ID เพิ่ม จากชีทลงทะเบียน + d.uid */
function allUidsForShop(phone, fallbackUid){
  var recips = {};
  if(fallbackUid){ var f=String(fallbackUid).trim(); if(f) recips[f]=1; }
  phone = String(phone||'').replace(/\D/g,'');
  if(phone){ try{
    var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
    var sh = getSheetByGid(ss, REG_SHEET_GID);
    if(sh){
      var H = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(function(h){return String(h).trim();});
      var pC=H.indexOf('เบอร์โทรศัพท์'), uC=H.indexOf('User ID'), eC=H.indexOf('User ID เพิ่ม');
      var last=sh.getLastRow();
      if(pC>=0 && last>=2){
        var vals=sh.getRange(2,1,last-1,sh.getLastColumn()).getValues();
        for(var i=0;i<vals.length;i++){
          if(String(vals[i][pC]).replace(/\D/g,'')===phone){
            if(uC>=0){ var u=String(vals[i][uC]||'').trim(); if(u) recips[u]=1; }
            if(eC>=0){ String(vals[i][eC]||'').split(/[,\n;]+/).forEach(function(s){ s=s.trim(); if(s) recips[s]=1; }); }
            break;
          }
        }
      }
    }
  }catch(e){} }
  return Object.keys(recips);
}
function pushLineOrder(d, sh){
  if(!LINE_TOKEN || LINE_TOKEN.indexOf('PASTE')===0) return;   // ยังไม่ตั้ง token
  var recipients = allUidsForShop(d.phone, d.uid);            // ส่งทุกไลน์ของร้าน (เบอร์เดียวกัน)
  if(!recipients.length) return;                              // ไม่มีใครเข้าผ่านไลน์
  var items = d.items || [];

  // ── พาเลตต์แบรนด์ (ฟ้าพาสเทลสดใส) ──
  var NAVY='#2b6fd0', GOLD='#bfe0ff', GREEN='#2ecc71', INK='#3a4663', MUTE='#8a94ad', LINE='#e3edf9', CREAM='#eef5fd';

  // ── แถวรายการสินค้า (zebra + ไอคอน) ──
  var rows = items.map(function(it, i){
    var isGift = it.type==='แถม';
    var bg = isGift ? '#f1fbf4' : (i%2 ? '#f7f8fc' : '#ffffff');
    return { type:'box', layout:'vertical', paddingAll:'10px', cornerRadius:'10px', backgroundColor:bg, margin:'sm',
      contents:[
        { type:'box', layout:'baseline', contents:[
          { type:'text', text:(isGift?'🎁':'🛍️'), size:'sm', flex:0 },
          { type:'text', text:String(it.name||''), size:'sm', weight:'bold', wrap:true, color:(isGift?'#1e9e57':NAVY), margin:'sm' }
        ]},
        { type:'box', layout:'horizontal', margin:'sm', contents:[
          { type:'text', text:'× '+(it.qty||0)+' '+(it.unit||''), size:'xs', color:MUTE, flex:3, wrap:true, gravity:'center' },
          { type:'text', text:(isGift?'ฟรี ♥':numFmt(it.total)+' ฿'), size:'sm', align:'end', weight:'bold', color:(isGift?'#1e9e57':NAVY), flex:2, gravity:'center' }
        ]}
      ]};
  });

  var dateStr = Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yyyy • HH:mm');

  // helper: แถวข้อมูลหัวบิล
  function infoRow(label, val){ return { type:'box', layout:'horizontal', margin:'sm', contents:[
    { type:'text', text:label, size:'xs', color:MUTE, flex:2 },
    { type:'text', text:String(val||'-'), size:'xs', color:INK, flex:4, align:'end', wrap:true, weight:'bold' } ]}; }

  // ── HEADER (navy + gold) ──
  var header = { type:'box', layout:'vertical', backgroundColor:NAVY, paddingAll:'18px', paddingBottom:'16px', contents:[
    { type:'box', layout:'horizontal', contents:[
      { type:'text', text:'RATTANA', size:'sm', weight:'bold', color:GOLD, flex:1, gravity:'center' },
      { type:'text', text:'OFFICIAL', size:'xs', color:'#aeb8d4', align:'end', flex:1, gravity:'center' }
    ]},
    { type:'text', text:'🧾 สรุปคำสั่งซื้อ', size:'xl', weight:'bold', color:'#ffffff', margin:'md' },
    { type:'box', layout:'baseline', margin:'sm', contents:[
      { type:'text', text:'เลขที่ออเดอร์', size:'xs', color:'#aeb8d4', flex:0 },
      { type:'text', text:String(d.orderId||'-'), size:'sm', weight:'bold', color:GOLD, align:'end', margin:'sm' }
    ]}
  ]};

  // ── BODY ──
  var body = [];
  body.push({ type:'box', layout:'vertical', backgroundColor:'#f7f8fc', cornerRadius:'12px', paddingAll:'12px', contents:[
    infoRow('🗓️ วันที่', dateStr),
    infoRow('🏪 ร้าน', d.customerName),
    infoRow('🚚 คลังส่ง', d.warehouse),
    infoRow('👤 ฝ่ายขาย', d.salemanName)
  ].filter(function(r){ return r.contents[1].text!=='-'; }) });

  body.push({ type:'text', text:'รายการสินค้า', weight:'bold', size:'sm', color:NAVY, margin:'lg' });
  body = body.concat(rows);

  // ── ยอดรวม (กล่องทองเด่น) ──
  body.push({ type:'box', layout:'horizontal', margin:'lg', backgroundColor:CREAM, cornerRadius:'12px', paddingAll:'14px',
    borderWidth:'1px', borderColor:'#cfe2f7', contents:[
    { type:'text', text:'ยอดเงินรวม', weight:'bold', size:'md', color:NAVY, gravity:'center' },
    { type:'text', text:numFmt(d.total)+' ฿', weight:'bold', size:'xl', align:'end', color:'#1d4e9e', gravity:'center' }
  ]});
  body.push({ type:'text', text:'* ราคาอ้างอิง ยอดจริงยืนยันโดยฝ่ายขาย', size:'xxs', color:MUTE, wrap:true, margin:'sm', align:'center' });

  if(d.note){
    body.push({ type:'box', layout:'vertical', margin:'lg', backgroundColor:'#fff8f3', cornerRadius:'10px', paddingAll:'10px',
      borderWidth:'1px', borderColor:'#ffe0cc', contents:[
      { type:'text', text:'📝 หมายเหตุ', size:'xxs', color:'#c0392b', weight:'bold' },
      { type:'text', text:String(d.note), size:'xs', color:INK, wrap:true, margin:'xs' }
    ]});
  }

  // ── FOOTER ──
  var footer = { type:'box', layout:'vertical', paddingAll:'16px', backgroundColor:'#fafbfd', spacing:'xs', contents:[
    { type:'text', text:'ขอบคุณที่อุดหนุนนะคะ 🙏💛', size:'sm', weight:'bold', color:NAVY, align:'center' },
    { type:'text', text:'ฝ่ายขาย ☎ 080-389-7765 · จ–ส 08:00–17:00', size:'xxs', color:MUTE, align:'center', wrap:true, margin:'sm' },
    { type:'text', text:'ส่งโดยระบบอัตโนมัติ RATTANA OFFICIAL', size:'xxs', color:NAVY, align:'center', weight:'bold', margin:'sm' }
  ]};

  var bubble = { type:'bubble',
    header: header,
    body: { type:'box', layout:'vertical', spacing:'sm', paddingAll:'16px', contents:body },
    footer: footer,
    styles:{ header:{ backgroundColor:NAVY }, footer:{ separator:true, separatorColor:LINE } }
  };

  recipients.forEach(function(uid){
    var msg = { to: uid, messages:[ { type:'flex', altText:'🧾 สรุปคำสั่งซื้อ '+(d.orderId||''), contents:bubble } ] };
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method:'post', contentType:'application/json',
      headers:{ Authorization:'Bearer '+LINE_TOKEN },
      payload: JSON.stringify(msg), muteHttpExceptions:true
    });
  });
}
/* ───────── เชื่อม LINE User ID เข้ากับลูกค้าที่ลงทะเบียนด้วยเบอร์แล้ว ─────────
   ร้านเดียวกัน (เบอร์เดียวกัน) มีหลายไลน์ได้:
   - uid ตัวแรก → เก็บที่คอลัมน์ 'User ID' (ไม่เคยทับ)
   - uid ตัวถัดไป → ต่อท้ายคอลัมน์ 'User ID เพิ่ม' (คั่น , กันซ้ำ) — สร้างคอลัมน์ให้อัตโนมัติถ้ายังไม่มี */
function handleLinkUid(d) {
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = getSheetByGid(ss, REG_SHEET_GID);
  if (!sh) return { ok:false, error:'reg sheet not found' };
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function(h){ return String(h).trim(); });
  var phoneCol = headers.indexOf('เบอร์โทรศัพท์'), uidCol = headers.indexOf('User ID');
  var extraCol = headers.indexOf('User ID เพิ่ม');
  if (phoneCol < 0 || uidCol < 0) return { ok:false, error:'columns not found' };
  var uid = String(d.uid || '').trim();
  if (!uid) return { ok:false, error:'no uid' };
  // สร้างคอลัมน์ 'User ID เพิ่ม' อัตโนมัติถ้ายังไม่มี (ต่อท้ายหัวตาราง)
  if (extraCol < 0) { extraCol = headers.length; sh.getRange(1, extraCol + 1).setValue('User ID เพิ่ม'); }
  var last = sh.getLastRow(); if (last < 2) return { ok:false, error:'no data' };
  var width = Math.max(headers.length, extraCol + 1);
  var vals = sh.getRange(2, 1, last - 1, width).getValues();
  var target = String(d.phone || '').replace(/\D/g, '');
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][phoneCol]).replace(/\D/g, '') === target) {
      var primary = String(vals[i][uidCol] || '').trim();
      if (!primary) { sh.getRange(i + 2, uidCol + 1).setValue(uid); return { ok:true, linked:'primary' }; }
      if (primary === uid) return { ok:true, linked:'already' };
      var extra = String(vals[i][extraCol] || '');
      var listed = extra.split(/[,\n;]+/).map(function(s){ return s.trim(); }).filter(String);
      if (listed.indexOf(uid) >= 0) return { ok:true, linked:'already' };
      listed.push(uid);
      sh.getRange(i + 2, extraCol + 1).setValue(listed.join(', '));
      return { ok:true, linked:'extra' };
    }
  }
  return { ok:false, error:'phone not found' };
}
function normHead(s){ return String(s).replace(/\s+/g,'').replace(/[​-‍﻿]/g,'').toLowerCase(); }

/* ───────── utils ───────── */
function getSheetByGid(ss, gid) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === gid) return sheets[i];
  }
  return null;
}
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
