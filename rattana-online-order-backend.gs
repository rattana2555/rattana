/****************************************************************
 * Rattana Online Order — Apps Script Backend  v1.13
 * --------------------------------------------------------------
 * รับข้อมูลจากแอป rattana-online-order.html แล้วบันทึกลง Google Sheet
 *   action: "register"  -> เขียนแถวลงชีทลงทะเบียน (gid 1357794184)
 *   action: "order"     -> เขียนรายการลงชีท "Orders" (สร้างให้อัตโนมัติถ้ายังไม่มี)
 *   LINE webhook        -> follow/unfollow เก็บ User ID ผู้ติดตามลงแท็บ "ผู้ติดตาม"
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

// ───── Discord (แจ้งเตือน "เปิดร้านค้าใหม่" เข้าห้อง Discord) ─────
// วิธีเอา URL: ใน Discord → คลิกขวาห้องที่จะให้เด้ง → แก้ไขช่อง → Integrations → Webhooks → New Webhook → Copy Webhook URL
var DISCORD_WEBHOOK = 'PASTE_DISCORD_WEBHOOK_URL';

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
    if (Array.isArray(data.events)) return handleLineWebhook(data);   // LINE webhook (follow/unfollow) — เก็บ User ID
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
  if (p.action === 'getPending') {                       // ตะกร้าร่วม = รายการ "รออนุมัติ" ของร้าน (ซิงค์ทุกเครื่องผ่านสถานะ)
    var rp = getPendingFor(p.shop);
    return p.callback ? jsonp(p.callback, rp) : json(rp);
  }
  if (p.action === 'getOrderStatus') {                   // เช็คว่า orderId นี้ถูกเขียน "อนุมัติ" ลงหลังบ้านแล้วยัง (ใช้ยืนยันการส่งออเดอร์)
    var os = getOrderStatus(p.orderId);
    return p.callback ? jsonp(p.callback, os) : json(os);
  }
  if (p.action === 'getHistory') {                       // ยอดซื้อย้อนหลังจริงจาก BigQuery (จับด้วยรหัสร้าน = Customer_Code)
    var gh = getHistoryFor(p.code);
    return p.callback ? jsonp(p.callback, gh) : json(gh);
  }
  return json({ ok:true, service:'Rattana Online Order', time:new Date() });
}
function jsonp(cb, obj){ return ContentService.createTextOutput(cb + '(' + JSON.stringify(obj) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT); }

/* ───────── ประวัติซื้อย้อนหลังจาก BigQuery — โหมด SNAPSHOT เดือนละครั้ง ─────────
   • ไม่ยิง BQ ต่อคำขอ (กันเปลือง quota) — ดึงครั้งเดียว "ทุกวันที่ 5 ของเดือน" ลงแท็บ 'ประวัติซื้อBQ'
   • ดึงเฉพาะร้านที่ลงทะเบียนในแอป (อ่านรหัสร้านจากชีทลงทะเบียน) top 120 สินค้า/ร้าน เรียงยอดขายมาก→น้อย
   • getHistoryFor อ่านจากแท็บ snapshot (เร็ว ไม่แตะ BQ) + แคช 6 ชม./ร้าน
   ⚠️ SETUP ครั้งเดียว: (1) เอดิเตอร์ → บริการ (Services) → + → "BigQuery API" → เพิ่ม
                        (2) รัน setupHistoryTrigger() 1 ครั้ง (สร้าง trigger รายเดือน + ดึงรอบแรกทันที) */
var BQ_PROJECT = 'project-test-471907';
var BQ_HISTORY_TABLE = '`project-test-471907.Testimport.BQ_2024_2025`';
var HIST_SHEET_NAME = 'ประวัติซื้อBQ';

/* ดึง BQ → เขียนแท็บ snapshot (เรียกโดย trigger ทุกวันที่ 5 หรือรันมือ) */
function refreshHistorySnapshot() {
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  // 1) รวบรวมรหัสร้านที่ลงทะเบียนในแอป
  var reg = getSheetByGid(ss, REG_SHEET_GID);
  var H = reg.getRange(1,1,1,reg.getLastColumn()).getValues()[0].map(function(h){return String(h).trim();});
  var codeCol = H.indexOf('รหัสร้าน');
  if (codeCol < 0) return { ok:false, error:'no รหัสร้าน column' };
  var last = reg.getLastRow(), codes = [];
  if (last >= 2) {
    reg.getRange(2, codeCol+1, last-1, 1).getValues().forEach(function(r){
      var c = String(r[0]||'').trim(); if (c && codes.indexOf(c) < 0) codes.push(c);
    });
  }
  if (!codes.length) return { ok:false, error:'no shop codes' };
  // 2) query BQ ครั้งเดียว: top 120 สินค้า/ร้าน เรียงยอดขาย
  var sql = "SELECT Customer_Code, barcode, name, unit, baht, last FROM (" +
            " SELECT Customer_Code, REGEXP_REPLACE(Product_Code, r'^BC-', '') AS barcode," +
            " ANY_VALUE(Product_Name) AS name, ANY_VALUE(Rattana_Unit) AS unit," +
            " ROUND(SUM(TotalBaht),0) AS baht, MAX(Month_Year) AS last," +
            " ROW_NUMBER() OVER (PARTITION BY Customer_Code ORDER BY SUM(TotalBaht) DESC) AS rn" +
            " FROM " + BQ_HISTORY_TABLE +
            " WHERE Customer_Code IN UNNEST(@codes)" +
            " GROUP BY Customer_Code, barcode) WHERE rn <= 120 ORDER BY Customer_Code, baht DESC";
  var res = BigQuery.Jobs.query({
    query: sql, useLegacySql: false, parameterMode: 'NAMED',
    queryParameters: [{ name:'codes', parameterType:{ type:'ARRAY', arrayType:{ type:'STRING' } },
      parameterValue:{ arrayValues: codes.map(function(c){ return { value:c }; }) } }]
  }, BQ_PROJECT);
  var rows = (res.rows || []).map(function(r){ var f = r.f;
    return [ String(f[0].v||''), String(f[1].v||''), String(f[2].v||''), String(f[3].v||''), Number(f[4].v)||0, String(f[5].v||'') ];
  });
  // 3) เขียนทับแท็บ snapshot
  var sh = ss.getSheetByName(HIST_SHEET_NAME) || ss.insertSheet(HIST_SHEET_NAME);
  sh.clearContents();
  sh.getRange(1,1,1,7).setValues([['รหัสร้าน','barcode','ชื่อสินค้า','หน่วย','ยอดซื้อสะสม','ซื้อล่าสุด','อัปเดตเมื่อ']]);
  var now = Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yyyy HH:mm');
  if (rows.length) {
    sh.getRange(2,1,rows.length,6).setValues(rows);
    sh.getRange(2,7).setValue(now);
    sh.getRange(2,1,rows.length,2).setNumberFormat('@');   // รหัสร้าน/บาร์โค้ด เป็น TEXT กัน 0 หาย
  }
  try { CacheService.getScriptCache().removeAll(codes.map(function(c){ return 'hist2_'+c; })); } catch(e) {}
  return { ok:true, shops: codes.length, rows: rows.length, at: now };
}

/* ตั้ง trigger รายเดือน (วันที่ 5 เวลา ~06:00) — รันครั้งเดียวพอ */
function setupHistoryTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'refreshHistorySnapshot') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshHistorySnapshot').timeBased().onMonthDay(5).atHour(6).create();
  return refreshHistorySnapshot();   // ดึงรอบแรกทันที ไม่ต้องรอวันที่ 5
}

/* อ่านประวัติร้านจากแท็บ snapshot (ไม่แตะ BQ) — ให้แอปเรียกผ่าน doGet action=getHistory */
function getHistoryFor(code) {
  code = String(code || '').trim();
  if (!code) return { ok:false, error:'no code' };
  var cache = CacheService.getScriptCache(), ck = 'hist2_' + code;
  try { var hit = cache.get(ck); if (hit) return JSON.parse(hit); } catch (e) {}
  try {
    var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
    var sh = ss.getSheetByName(HIST_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return { ok:true, code:code, items:[], note:'snapshot ยังไม่ถูกสร้าง — รัน setupHistoryTrigger()' };
    var vals = sh.getRange(2, 1, sh.getLastRow()-1, 6).getValues();
    var items = [];
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim() !== code) continue;
      items.push({ barcode:String(vals[i][1]||''), name:String(vals[i][2]||''), unit:String(vals[i][3]||''), baht:Number(vals[i][4])||0, last:String(vals[i][5]||'') });
    }
    var out = { ok:true, code:code, items:items };   // เรียงมาแล้วตอนเขียน snapshot (ยอดขายมาก→น้อย)
    try { cache.put(ck, JSON.stringify(out), 21600); } catch (e) {}
    return out;
  } catch (err) { return { ok:false, error:String(err && err.message || err) }; }
}

/* ───────── ตะกร้าร่วม (ซิงค์ข้ามเครื่องของร้านเดียวกัน ผูกด้วยเบอร์) ───────── */
function getCartSheet(){
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = ss.getSheetByName('ตะกร้า');
  if(!sh){ sh = ss.insertSheet('ตะกร้า'); sh.appendRow(['เบอร์','ชื่อร้าน','User ID','อัปเดตเมื่อ','จำนวนรายการ','ยอดรวม','รายการ(JSON)','ts','orderId']); }
  return sh;
}
// เลิกใช้แท็บ "ตะกร้า" แล้ว — ตะกร้าร่วมซิงค์ผ่านสถานะ "รออนุมัติ" ในชีท order (getPendingFor) แทน
function handleSaveCart(d){ return { ok:true, disabled:true }; }
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

/* ───────── ตะกร้าร่วม (ซิงค์ผ่านสถานะ): รายการ "รออนุมัติ" ของร้าน — ทุกเครื่องเห็นเหมือนกัน, พออนุมัติแล้วหาย ─────────
   เลือก orderId ของออเดอร์รออนุมัติ "ใหม่สุด" ของร้าน (รวมเป็นออเดอร์เดียว) แล้วคืนรายการขายในนั้น */
function getPendingFor(shop){
  var out = { ok:true, items:[], orderId:'' };
  shop = String(shop||'').trim(); if(!shop) return out;
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = ss.getSheetByName(ORDER_SHEET_NAME) || getSheetByGid(ss, ORDER_SHEET_GID);
  if(!sh) return out;
  var headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  function col(n){ for(var i=0;i<headers.length;i++){ if(normHead(headers[i])===normHead(n)) return i; } return -1; }
  var c = { shop:col('ชื่อร้าน'), type:col('รูปแบบ'), bc:col('Barcode'), name:col('ชื่อสินค้า'),
            qty:col('จำนวน'), unit:col('หน่วย'), price:col('ราคา'), oid:col('orderId'),
            status:col('สถานะอนุมัติ'), promo:col('โปรที่ใช้') };
  if(c.shop<0 || c.status<0 || c.oid<0) return out;
  var last = sh.getLastRow(); if(last<2) return out;
  var data = sh.getRange(2,1,last-1,headers.length).getValues();
  function isPending(r){ return String(data[r][c.shop]).trim()===shop && String(data[r][c.status]||'').trim()==='รออนุมัติ'; }
  // ใหม่สุด = orderId มากสุด (ORD+เวลา ความยาวเท่ากัน เทียบสตริงได้)
  var bestOid='';
  for(var r=0;r<data.length;r++){ if(isPending(r)){ var oid=String(data[r][c.oid]||'').trim(); if(oid>bestOid) bestOid=oid; } }
  if(!bestOid) return out;
  out.orderId = bestOid;
  for(var r=0;r<data.length;r++){
    if(!isPending(r)) continue;
    if(String(data[r][c.oid]||'').trim()!==bestOid) continue;
    if(c.type>=0 && String(data[r][c.type]).trim()==='แถม') continue;   // ของแถมคำนวณเองในแอป
    out.items.push({ name:String(data[r][c.name]||''), barcode:String(data[r][c.bc]||''),
      qty:Number(data[r][c.qty])||0, unit:String(data[r][c.unit]||''), price:Number(data[r][c.price])||0,
      promo: c.promo>=0 ? String(data[r][c.promo]||'') : '' });
  }
  return out;
}

/* ───────── เช็คสถานะออเดอร์ (ใช้ยืนยันว่าส่งถึงหลังบ้านจริง กันออเดอร์หาย/ส่งซ้ำ) ───────── */
function getOrderStatus(orderId){
  var out = { ok:true, orderId:String(orderId||''), approved:false, pending:false };
  orderId = String(orderId||'').trim(); if(!orderId) return out;
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = ss.getSheetByName(ORDER_SHEET_NAME) || getSheetByGid(ss, ORDER_SHEET_GID);
  if(!sh) return out;
  var headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  function col(n){ for(var i=0;i<headers.length;i++){ if(normHead(headers[i])===normHead(n)) return i; } return -1; }
  var oidC=col('orderId'), stC=col('สถานะอนุมัติ');
  if(oidC<0) return out;
  var last=sh.getLastRow(); if(last<2) return out;
  var data=sh.getRange(2,1,last-1,headers.length).getValues();
  for(var r=0;r<data.length;r++){
    if(String(data[r][oidC]).trim()!==orderId) continue;
    var st = stC>=0 ? String(data[r][stC]||'').trim() : '';
    if(st==='อนุมัติ') out.approved=true;
    else if(st==='รออนุมัติ') out.pending=true;
  }
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
  try { pushDiscordNewShop(d); } catch (e) {}   // เด้งแจ้ง "เปิดร้านค้าใหม่" เข้า Discord
  try { syncFollowerShops(); } catch (e) {}     // จับคู่ชื่อร้านให้ผู้ติดตามที่ uid ตรงกับร้านนี้
  return { ok:true, message:'registered' };
}

/* ───────── แจ้งเตือน "เปิดร้านค้าใหม่" เข้า Discord (ตอนลงทะเบียน) ───────── */
function pushDiscordNewShop(d){
  if(!DISCORD_WEBHOOK || DISCORD_WEBHOOK.indexOf('PASTE')>=0) return;   // ยังไม่ตั้ง webhook
  var addr = [ d['บ้านเลขที่'], d['หมู่']?('หมู่ '+d['หมู่']):'', d['ตำบล'], d['อำเภอ'], d['จังหวัด'], d['รหัสไปรษณีย์'] ]
    .map(function(x){ return String(x||'').trim(); }).filter(String).join(' ');
  var hasGeo = d['Latitude'] && d['Longitude'];
  var mapLink = hasGeo ? ('https://www.google.com/maps?q=' + d['Latitude'] + ',' + d['Longitude']) : '';
  var lines = [
    '**ชื่อร้านค้า :** ' + (d['ชื่อ / ร้านค้า'] || '-'),
    '**ที่อยู่ :** ' + (addr || '-'),
    '**เบอร์โทร :** ' + (d['เบอร์โทรศัพท์'] || '-'),
    '**พิกัด :** ' + (hasGeo ? ('[เปิดแผนที่](' + mapLink + ')') : 'ไม่มี'),
    '**เลขภพ.20 :** ' + (d['เลขบัตร/ภพ.20'] || '-')
  ];
  if (d['หมายเหตุ']) lines.push('**หมายเหตุ :** ' + d['หมายเหตุ']);
  lines.push('**ที่มา :** ลงทะเบียนผ่านแอป Rattana Online Order');
  var payload = { embeds:[ {
    title: '🏠 เปิดร้านค้าใหม่',
    description: lines.join('\n'),
    color: 0x2b6fd0,
    footer: { text: 'Rattana Online Order • รอแอดมินยืนยัน' }
  } ] };
  UrlFetchApp.fetch(DISCORD_WEBHOOK, {
    method:'post', contentType:'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions:true
  });
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
    'billId': d.orderId || '',                     // เลขที่ออเดอร์ (ORD...) ลงช่อง billId ให้แอดมิน/Roo จับกลุ่มบิล
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
  // ยืนยันแล้ว = แถวกลายเป็น "อนุมัติ" → เครื่องอื่น getPending ไม่เจอ "รออนุมัติ" → เคลียร์ตะกร้าเอง (ไม่ต้องแตะแท็บตะกร้า)
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

  // ── พาเลตต์แบรนด์ (navy/gold = สีหลักแอป) ──
  var NAVY='#0d1b3e', GOLD='#c9a84c', GREEN='#2ecc71', INK='#3a4663', MUTE='#8a94ad', LINE='#e8e2d2', CREAM='#f6f1e3';

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
    infoRow('👤 ฝ่ายขาย', d.salemanName)
  ].filter(function(r){ return r.contents[1].text!=='-'; }) });

  body.push({ type:'text', text:'รายการสินค้า', weight:'bold', size:'sm', color:NAVY, margin:'lg' });
  body = body.concat(rows);

  // ── ยอดรวม (กล่องทองเด่น) ──
  body.push({ type:'box', layout:'horizontal', margin:'lg', backgroundColor:CREAM, cornerRadius:'12px', paddingAll:'14px',
    borderWidth:'1px', borderColor:'#cfe2f7', contents:[
    { type:'text', text:'ยอดเงินรวม', weight:'bold', size:'md', color:NAVY, gravity:'center' },
    { type:'text', text:numFmt(d.total)+' ฿', weight:'bold', size:'xl', align:'end', color:NAVY, gravity:'center' }
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
/* ═══════════════════════════════════════════════════════════════════
   ⏰ เตือนร้านที่ "ลืมกดยืนยันออเดอร์" — รันทุกวัน 17:00 (เวลาไทย)
   เงื่อนไข: วันนี้ = "วันจด" (รูท) ของร้าน + มีออเดอร์ "รออนุมัติ" ค้างในตะกร้า + ยังไม่เคยเตือนออเดอร์นี้
   ส่งไลน์เข้า "User ID ตัวหลัก" ของร้าน  → ตั้ง trigger ครั้งเดียวด้วย setupRemindTrigger()
   ═══════════════════════════════════════════════════════════════════ */
function setupRemindTrigger(){
  ScriptApp.getProjectTriggers().forEach(function(t){ if(t.getHandlerFunction()==='remindUnconfirmedOrders') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('remindUnconfirmedOrders').timeBased().everyDays(1).atHour(17).inTimezone('Asia/Bangkok').create();
  return 'ตั้งเตือน 17:00 ทุกวันแล้ว';
}
// ชื่อวันไทยของวันนี้ (โซนเวลาไทย)
function thaiWeekday_(){
  var en = Utilities.formatDate(new Date(),'Asia/Bangkok','EEEE');   // Monday..Sunday
  var map = {Monday:'จันทร์',Tuesday:'อังคาร',Wednesday:'พุธ',Thursday:'พฤหัสบดี',Friday:'ศุกร์',Saturday:'เสาร์',Sunday:'อาทิตย์'};
  return map[en] || '';
}
function normDay_(v){
  var s = String(v||'').trim().replace(/^วัน/,'');
  if(s==='พฤหัส'||s==='พฤหัสฯ') s='พฤหัสบดี';
  if(s==='อาทิตย์'||s==='อา') s='อาทิตย์';
  return s;
}
// อ่านชีท order ครั้งเดียว → map ชื่อร้าน → orderId ของออเดอร์ "รออนุมัติ" ใหม่สุด (มีสินค้าขายค้างอยู่)
function pendingByShop_(){
  var out = {};
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = ss.getSheetByName(ORDER_SHEET_NAME) || getSheetByGid(ss, ORDER_SHEET_GID);
  if(!sh) return out;
  var headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  function col(n){ for(var i=0;i<headers.length;i++){ if(normHead(headers[i])===normHead(n)) return i; } return -1; }
  var shopC=col('ชื่อร้าน'), stC=col('สถานะอนุมัติ'), oidC=col('orderId'), typeC=col('รูปแบบ');
  if(shopC<0||stC<0||oidC<0) return out;
  var last=sh.getLastRow(); if(last<2) return out;
  var data=sh.getRange(2,1,last-1,headers.length).getValues();
  for(var r=0;r<data.length;r++){
    if(String(data[r][stC]||'').trim()!=='รออนุมัติ') continue;
    if(typeC>=0 && String(data[r][typeC]).trim()==='แถม') continue;   // ของแถมไม่นับ
    var shop=String(data[r][shopC]||'').trim(); if(!shop) continue;
    var oid=String(data[r][oidC]||'').trim();
    if(!out[shop] || oid>out[shop]) out[shop]=oid;                    // เก็บ orderId ใหม่สุด
  }
  return out;
}
function remindUnconfirmedOrders(){
  if(!LINE_TOKEN || LINE_TOKEN.indexOf('PASTE')===0) return;
  var today = thaiWeekday_(); if(!today) return;
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var reg = getSheetByGid(ss, REG_SHEET_GID); if(!reg) return;
  var H = reg.getRange(1,1,1,reg.getLastColumn()).getValues()[0].map(function(h){ return String(h).trim(); });
  var nameC=H.indexOf('ชื่อ / ร้านค้า'), uidC=H.indexOf('User ID'), dayC=H.indexOf('วันจด');
  if(nameC<0||uidC<0||dayC<0) return;          // ไม่มีคอลัมน์ที่ต้องใช้
  var last=reg.getLastRow(); if(last<2) return;
  var rows=reg.getRange(2,1,last-1,reg.getLastColumn()).getValues();
  var pending=pendingByShop_();                 // ชื่อร้าน → orderId ค้าง
  var props=PropertiesService.getScriptProperties();
  for(var i=0;i<rows.length;i++){
    var shop=String(rows[i][nameC]||'').trim();
    var uid=String(rows[i][uidC]||'').trim();
    if(!shop || !uid) continue;
    if(normDay_(rows[i][dayC]) !== today) continue;     // ไม่ใช่วันจดของร้านนี้
    var oid=pending[shop];
    if(!oid) continue;                                  // ไม่มีออเดอร์ค้าง → ไม่เตือน
    var rkey='reminded_'+oid;
    if(props.getProperty(rkey)) continue;               // เตือนออเดอร์นี้ไปแล้ว (ครั้งเดียว)
    pushLineRemind_(uid);
    props.setProperty(rkey,'1');
  }
}
// Flex น่ารักๆ เตือนลืมกดยืนยัน + ปุ่มเปิดแอป
function pushLineRemind_(uid){
  var LIFF='https://liff.line.me/2010518208-qWNksPcn';
  var bubble = { type:'bubble',
    header:{ type:'box', layout:'vertical', backgroundColor:'#2b6fd0', paddingAll:'16px', contents:[
      { type:'text', text:'🛍️ ลืมกดยืนยันออเดอร์รึเปล่าคะ?', weight:'bold', size:'md', color:'#ffffff', wrap:true } ]},
    body:{ type:'box', layout:'vertical', spacing:'md', paddingAll:'18px', contents:[
      { type:'text', text:'🥺 น้องสินค้าแอบบอกว่า...', size:'sm', weight:'bold', color:'#2b6fd0', wrap:true },
      { type:'text', text:'“พาผมกลับบ้านด้วยได้ไหม~” 🛍️💕', size:'sm', weight:'bold', color:'#3a4663', wrap:true },
      { type:'text', text:'เหมือนจะยังมีสินค้าอยู่ในตะกร้าของคุณลูกค้านะคะ หากลืมกดยืนยันออเดอร์ สามารถกลับมากดได้ทุกเมื่อเลยค่ะ', size:'sm', color:'#3a4663', wrap:true },
      { type:'text', text:'หากต้องการสอบถามเพิ่มเติม แอดมินพร้อมช่วยเสมอนะคะ 😊', size:'xs', color:'#8a94ad', wrap:true }
    ]},
    footer:{ type:'box', layout:'vertical', paddingAll:'12px', contents:[
      { type:'button', style:'primary', color:'#2b6fd0', height:'sm',
        action:{ type:'uri', label:'🛒 เปิดแอป กดยืนยันออเดอร์', uri:LIFF } } ]}
  };
  var msg = { to:uid, messages:[ { type:'flex', altText:'🛍️ ลืมกดยืนยันออเดอร์รึเปล่าคะ? มีสินค้าค้างในตะกร้านะคะ', contents:bubble } ] };
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method:'post', contentType:'application/json',
    headers:{ Authorization:'Bearer '+LINE_TOKEN },
    payload: JSON.stringify(msg), muteHttpExceptions:true
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

/* ═══════════════════════════════════════════════════════════════════
   👥 LINE Webhook — เก็บ User ID ลูกค้าที่ "แอด OA" (follow) + มาร์คคน "บล็อก" (unfollow)
   ───────────────────────────────────────────────────────────────────
   ตั้งค่า: LINE Developers > channel Messaging API ของ OA Rattana_Official
            > ตั้ง Webhook URL = GAS_URL (อันเดียวกับที่ใส่ในแอป) + เปิด "Use webhook" = ON
   เก็บลงแท็บ "ผู้ติดตาม" (สร้างให้อัตโนมัติครั้งแรก) ในสเปรดชีต REG_SPREADSHEET_ID
   ข้อจำกัด:
     - LINE แยก "บล็อก" กับ "ลบเพื่อน" ไม่ได้ → ทั้งคู่ส่ง unfollow เหมือนกัน
     - ตอนถูกบล็อก ดึงชื่อ/รูปไม่ได้แล้ว → ต้องเก็บชื่อไว้ตั้งแต่ตอน follow
     - Apps Script อ่าน HTTP header ไม่ได้ → verify ลายเซ็น X-Line-Signature เป๊ะๆ ไม่ได้
   ═══════════════════════════════════════════════════════════════════ */
var FOLLOWERS_SHEET_NAME = 'ผู้ติดตาม';

// แท็บเก็บผู้ติดตาม (สร้างอัตโนมัติถ้ายังไม่มี) — 9 คอลัมน์
// User ID | ชื่อ | รูป | วันที่แอด | สถานะ | เคยบล็อกล่าสุด | จำนวนครั้งบล็อก | จำนวนครั้งกลับมา | อัปเดตล่าสุด
function getFollowersSheet_(){
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = ss.getSheetByName(FOLLOWERS_SHEET_NAME);
  if(!sh){
    sh = ss.insertSheet(FOLLOWERS_SHEET_NAME);
    sh.appendRow(['User ID','ชื่อโปรไฟล์','รูปโปรไฟล์','วันที่แอด','สถานะ','เคยบล็อกล่าสุด','จำนวนครั้งบล็อก','จำนวนครั้งกลับมา','อัปเดตล่าสุด','ชื่อร้าน']);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');   // กัน User ID เพี้ยน (ขึ้นต้น U + ตัวเลขยาว)
  }
  return sh;
}

// รับ webhook ของ LINE (payload เป็น { destination, events:[...] } — ไม่มี action)
// คืน 200 เปล่าๆ เสมอ (LINE ต้องการ 200 ไม่งั้นจะ retry / ปิด webhook)
function handleLineWebhook(data){
  var didFollow = false;
  try{
    (data.events || []).forEach(function(ev){
      try{
        var uid = ev && ev.source && ev.source.userId;
        if(!uid) return;                         // ไม่ใช่ event ของผู้ใช้ (เช่น group) → ข้าม
        if(ev.type === 'follow')        { onFollow_(uid, ev.timestamp); didFollow = true; }
        else if(ev.type === 'unfollow') onUnfollow_(uid, ev.timestamp);
        else                            onInteract_(uid, ev.timestamp);   // ทักแชท/กดปุ่ม ฯลฯ → เก็บ uid ถ้ายังไม่มี
      }catch(e){}
    });
    if(didFollow) syncFollowerShops();           // จับคู่ชื่อร้านให้ผู้ติดตามใหม่ทันที
  }catch(e){}
  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
}

// ดึงโปรไฟล์ลูกค้า (ชื่อ+รูป) — ใช้ได้เฉพาะตอน follow (ตอนถูกบล็อกดึงไม่ได้แล้ว)
function fetchLineProfile_(uid){
  if(!LINE_TOKEN || LINE_TOKEN.indexOf('PASTE')===0) return {};   // ยังไม่ใส่ token → ข้าม (เก็บแค่ User ID)
  try{
    var resp = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/'+encodeURIComponent(uid), {
      method:'get', headers:{ Authorization:'Bearer '+LINE_TOKEN }, muteHttpExceptions:true
    });
    if(resp.getResponseCode()!==200) return {};
    var p = JSON.parse(resp.getContentText());
    return { name:p.displayName||'', pic:p.pictureUrl||'' };
  }catch(e){ return {}; }
}

// timestamp (ms) ของ event → ข้อความวันเวลาไทย
function tsToStr_(ts){
  var d = ts ? new Date(Number(ts)) : new Date();
  return Utilities.formatDate(d,'Asia/Bangkok','dd/MM/yyyy HH:mm');
}

// หาแถวของ uid ในแท็บผู้ติดตาม (คืนเลขแถวจริง, -1 ถ้าไม่เจอ)
function findFollowerRow_(sh, uid){
  var last = sh.getLastRow(); if(last<2) return -1;
  var col = sh.getRange(2,1,last-1,1).getValues();
  var t = String(uid).trim();
  for(var i=0;i<col.length;i++){ if(String(col[i][0]).trim()===t) return i+2; }
  return -1;
}

// คนแอดเพื่อนใหม่ / ปลดบล็อก / กลับมาแอด → follow event
//   - แถวใหม่ : เก็บ User ID + ชื่อ/รูป + วันที่แอด (ตัวนับเริ่ม 0)
//   - แถวเดิม : สถานะ→เป็นเพื่อน, "เคยบล็อกล่าสุด" คงไว้ (ไม่ล้าง), +1 จำนวนครั้งกลับมา (ถ้าก่อนหน้าบล็อกอยู่)
function onFollow_(uid, ts){
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(e){}
  try{
    var sh   = getFollowersSheet_();
    var prof = fetchLineProfile_(uid);
    var when = tsToStr_(ts);
    var row  = findFollowerRow_(sh, uid);
    if(row < 0){
      sh.appendRow([ uid, prof.name||'', prof.pic||'', when, 'เป็นเพื่อน', '', 0, 0, when ]);
      var lr = sh.getLastRow(); sh.getRange(lr,1).setNumberFormat('@').setValue(uid);
    } else {
      var prevStatus = String(sh.getRange(row,5).getValue()||'').trim();
      sh.getRange(row,5).setValue('เป็นเพื่อน');                 // สถานะ → เป็นเพื่อน
      // ถ้า "วันที่แอด" ว่าง (แถวนี้เคยถูกสร้างจาก unfollow ของเพื่อนเก่า) → เติมวันที่ที่เห็นเป็นเพื่อนครั้งนี้
      if(!String(sh.getRange(row,4).getValue()||'').trim()) sh.getRange(row,4).setValue(when);
      // คอลัมน์ 6 "เคยบล็อกล่าสุด" — ไม่ล้าง เก็บประวัติไว้ตลอด
      if(prevStatus === 'บล็อก/ลบเพื่อน'){                        // กลับมาจริง (กันนับซ้ำถ้า follow ยิงซ้ำ)
        var back = Number(sh.getRange(row,8).getValue())||0;
        sh.getRange(row,8).setValue(back+1);                      // +1 จำนวนครั้งกลับมา
      }
      sh.getRange(row,9).setValue(when);                          // อัปเดตล่าสุด
      if(prof.name) sh.getRange(row,2).setValue(prof.name);
      if(prof.pic)  sh.getRange(row,3).setValue(prof.pic);
    }
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// คนบล็อก/ลบเพื่อน → unfollow event (ดึงชื่อไม่ได้แล้ว ใช้ User ID จับคู่แถวเดิม)
//   - สถานะ→บล็อก, อัปเดต "เคยบล็อกล่าสุด", +1 จำนวนครั้งบล็อก (กันนับซ้ำถ้า unfollow ยิงซ้ำ)
function onUnfollow_(uid, ts){
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(e){}
  try{
    var sh   = getFollowersSheet_();
    var when = tsToStr_(ts);
    var row  = findFollowerRow_(sh, uid);
    if(row < 0){
      // ไม่เคยอยู่ในชีท (แอดมาก่อนติดตั้ง webhook) → เพิ่มแถวพร้อมสถานะบล็อก + นับ 1
      sh.appendRow([ uid, '', '', '', 'บล็อก/ลบเพื่อน', when, 1, 0, when ]);
      var lr = sh.getLastRow(); sh.getRange(lr,1).setNumberFormat('@').setValue(uid);
    } else {
      var prevStatus = String(sh.getRange(row,5).getValue()||'').trim();
      sh.getRange(row,5).setValue('บล็อก/ลบเพื่อน');             // สถานะ
      sh.getRange(row,6).setValue(when);                          // เคยบล็อกล่าสุด (เก็บไว้ตลอด)
      if(prevStatus !== 'บล็อก/ลบเพื่อน'){                        // กันนับซ้ำ
        var cnt = Number(sh.getRange(row,7).getValue())||0;
        sh.getRange(row,7).setValue(cnt+1);                       // +1 จำนวนครั้งบล็อก
      }
      sh.getRange(row,9).setValue(when);                          // อัปเดตล่าสุด
    }
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// คนทักแชท/กดปุ่ม (message/postback ฯลฯ) → เก็บ uid ถ้ายังไม่มีในชีท (เว้นวันที่แอดได้ — แค่เก็บ uid+ชื่อ)
function onInteract_(uid, ts){
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(15000); }catch(e){}
  try{
    var sh   = getFollowersSheet_();
    var when = tsToStr_(ts);
    var row  = findFollowerRow_(sh, uid);
    if(row < 0){
      var prof = fetchLineProfile_(uid);
      // วันที่แอด (คอลัมน์ 4) เว้นว่าง — ไม่รู้วันแอดจริง รู้แค่ว่าเป็นเพื่อน/ทักแชท
      sh.appendRow([ uid, prof.name||'', prof.pic||'', '', 'เป็นเพื่อน', '', 0, 0, when, '' ]);
      var lr = sh.getLastRow(); sh.getRange(lr,1).setNumberFormat('@').setValue(uid);
    } else {
      sh.getRange(row,9).setValue(when);                          // อัปเดตล่าสุด (= active ล่าสุด)
      // เติมชื่อ/รูป ถ้าแถวเดิมยังว่าง (เช่นแถวที่เคยถูกสร้างจากตอนบล็อก)
      var hasName = String(sh.getRange(row,2).getValue()||'').trim();
      var hasPic  = String(sh.getRange(row,3).getValue()||'').trim();
      if(!hasName || !hasPic){
        var p = fetchLineProfile_(uid);
        if(p.name && !hasName) sh.getRange(row,2).setValue(p.name);
        if(p.pic  && !hasPic)  sh.getRange(row,3).setValue(p.pic);
      }
    }
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

/* ── ทดสอบในเครื่อง: Run ตามลำดับ testFollow → testBlock → testFollow → testBlock
   จะเห็นตัวนับ "จำนวนครั้งบล็อก" และ "จำนวนครั้งกลับมา" เพิ่มขึ้นในแท็บ "ผู้ติดตาม" ── */
function testFollow(){
  onFollow_('Utest0000000000000000000000000001', new Date().getTime());
  Logger.log('follow ทดสอบแล้ว — ไปดูแท็บ "ผู้ติดตาม"');
}
function testBlock(){
  onUnfollow_('Utest0000000000000000000000000001', new Date().getTime());
  Logger.log('block ทดสอบแล้ว — ไปดูแท็บ "ผู้ติดตาม"');
}

/* ═══════════════════════════════════════════════════════════════════
   🔗 จับคู่ผู้ติดตาม → ชื่อร้าน (คอลัมน์ J) จากชีทลงทะเบียน
   uid ของผู้ติดตาม ไปหาในชีทลงทะเบียนทั้ง "User ID" และ "User ID เพิ่ม"
   เจอแล้วเอา "ชื่อ / ร้านค้า" มาใส่ → ไลน์หลายตัวของร้านเดียวกันได้ชื่อร้านเดียวกัน
   ทำงานอัตโนมัติเมื่อ: มีคนแอดใหม่ / ลงทะเบียน / และ trigger ทุก 10 นาที (setupFollowerSyncTrigger)
   ═══════════════════════════════════════════════════════════════════ */
var FOLLOWER_SHOP_COL = 10;   // คอลัมน์ J

// map: uid → ชื่อร้าน (รวม User ID + User ID เพิ่ม จากชีทลงทะเบียน)
function buildUidToShopMap_(){
  var map = {};
  try{
    var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
    var sh = getSheetByGid(ss, REG_SHEET_GID);
    if(!sh) return map;
    var H = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(function(h){ return String(h).trim(); });
    var nameC = H.indexOf('ชื่อ / ร้านค้า'), uidC = H.indexOf('User ID'), extraC = H.indexOf('User ID เพิ่ม');
    if(nameC<0 || uidC<0) return map;
    var last = sh.getLastRow(); if(last<2) return map;
    var vals = sh.getRange(2,1,last-1,sh.getLastColumn()).getValues();
    for(var i=0;i<vals.length;i++){
      var shop = String(vals[i][nameC]||'').trim(); if(!shop) continue;
      var u = String(vals[i][uidC]||'').trim(); if(u && !map[u]) map[u]=shop;
      if(extraC>=0){
        String(vals[i][extraC]||'').split(/[,\n;]+/).forEach(function(s){ s=s.trim(); if(s && !map[s]) map[s]=shop; });
      }
    }
  }catch(e){}
  return map;
}

// เติม "ชื่อร้าน" คอลัมน์ J ให้ทุกแถวในแท็บผู้ติดตาม (ไม่มี "_" ท้ายชื่อ → เรียกจาก trigger / Run มือได้)
function syncFollowerShops(){
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(20000); }catch(e){}
  try{
    var sh = getFollowersSheet_();
    var last = sh.getLastRow(); if(last<2) return;
    if(String(sh.getRange(1,FOLLOWER_SHOP_COL).getValue()||'').trim()!=='ชื่อร้าน')
      sh.getRange(1,FOLLOWER_SHOP_COL).setValue('ชื่อร้าน');     // ใส่หัวคอลัมน์ J ถ้ายังไม่มี
    var map  = buildUidToShopMap_();
    var uids = sh.getRange(2,1,last-1,1).getValues();
    var cur  = sh.getRange(2,FOLLOWER_SHOP_COL,last-1,1).getValues();
    var out  = [], changed = false;
    for(var i=0;i<uids.length;i++){
      var uid  = String(uids[i][0]||'').trim();
      var shop = map[uid] || '';
      var val  = shop ? shop : String(cur[i][0]||'');          // เจอ→ทับด้วยชื่อร้านจริง, ไม่เจอ→คงค่าเดิม
      out.push([val]);
      if(val!==String(cur[i][0]||'')) changed=true;
    }
    if(changed) sh.getRange(2,FOLLOWER_SHOP_COL,out.length,1).setValues(out);
  } finally { try{ lock.releaseLock(); }catch(e){} }
}

// ตั้ง trigger ให้ sync ชื่อร้านทุก 10 นาที (เผื่อกรณีลงทะเบียน/ลิงก์ uid ทีหลัง) — Run ครั้งเดียว
function setupFollowerSyncTrigger(){
  ScriptApp.getProjectTriggers().forEach(function(t){ if(t.getHandlerFunction()==='syncFollowerShops') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncFollowerShops').timeBased().everyMinutes(10).create();
  return 'ตั้ง sync ชื่อร้านทุก 10 นาทีแล้ว';
}

/* ═══════════════════════════════════════════════════════════════════
   📥 นำเข้า "เพื่อนเก่าทั้งหมด" (รวมคนที่ไม่เคยทัก) — Run ครั้งเดียว
   ใช้ LINE API /v2/bot/followers/ids → ได้เฉพาะบัญชี OA "Verified / Premium"
   ถ้าบัญชีไม่ผ่านเงื่อนไข จะขึ้น HTTP error ใน log (ดู View > Logs)
   *รายชื่อเยอะ อาจเกิน 6 นาทีแล้วหยุด → Run ซ้ำได้ (ข้ามคนที่นำเข้าแล้ว ทำต่อจากเดิม)
   ═══════════════════════════════════════════════════════════════════ */
function importAllFollowers(){
  if(!LINE_TOKEN || LINE_TOKEN.indexOf('PASTE')===0){ Logger.log('ยังไม่ใส่ LINE_TOKEN'); return; }
  var sh = getFollowersSheet_();
  var existing = {};
  var last = sh.getLastRow();
  if(last>=2){ sh.getRange(2,1,last-1,1).getValues().forEach(function(r){ var u=String(r[0]||'').trim(); if(u) existing[u]=1; }); }
  var base = 'https://api.line.me/v2/bot/followers/ids?limit=1000';
  var url = base, added = 0, pages = 0;
  while(url && pages < 50){
    var resp = UrlFetchApp.fetch(url, { method:'get', headers:{ Authorization:'Bearer '+LINE_TOKEN }, muteHttpExceptions:true });
    var code = resp.getResponseCode();
    if(code !== 200){
      Logger.log('❌ ดึงรายชื่อไม่ได้ HTTP '+code+' : '+resp.getContentText());
      Logger.log('   ส่วนใหญ่แปลว่าบัญชี OA ยังไม่ Verified/Premium → ใช้ followers/ids ไม่ได้');
      return;
    }
    var data = JSON.parse(resp.getContentText());
    (data.userIds||[]).forEach(function(uid){
      if(existing[uid]) return;
      existing[uid] = 1;
      var prof = fetchLineProfile_(uid);
      sh.appendRow([ uid, prof.name||'', prof.pic||'', '', 'เป็นเพื่อน', '', 0, 0, '', '' ]);   // วันที่แอดเว้นว่าง
      var lr = sh.getLastRow(); sh.getRange(lr,1).setNumberFormat('@').setValue(uid);
      added++;
    });
    url = data.next ? (base + '&start=' + encodeURIComponent(data.next)) : '';
    pages++;
  }
  try{ syncFollowerShops(); }catch(e){}
  Logger.log('✅ นำเข้าเพื่อนเก่าเพิ่ม '+added+' คน');
}
