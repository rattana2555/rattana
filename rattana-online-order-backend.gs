/****************************************************************
 * Rattana Online Order — Apps Script Backend  v1.0
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

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.action === 'register') return json(handleRegister(data));
    if (data.action === 'order')    return json(handleOrder(data));
    return json({ ok:false, error:'unknown action' });
  } catch (err) {
    return json({ ok:false, error:String(err) });
  }
}

function doGet() {
  return json({ ok:true, service:'Rattana Online Order', time:new Date() });
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
    'Saleman Code':    '',
    'Saleman Name':    ''
  };

  var row = headers.map(function(h){ return values.hasOwnProperty(h) ? values[h] : ''; });
  sh.appendRow(row);
  return { ok:true, message:'registered' };
}

/* ───────── บันทึกออเดอร์ → แท็บ gid 1594322176 (แมปตามชื่อหัวคอลัมน์) ───────── */
function handleOrder(d) {
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = ss.getSheetByName(ORDER_SHEET_NAME) || getSheetByGid(ss, ORDER_SHEET_GID);
  if (!sh) return { ok:false, error:'order sheet "' + ORDER_SHEET_NAME + '" not found' };
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var now = new Date();
  var dateStr = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy');
  var timeStr = Utilities.formatDate(now, 'Asia/Bangkok', 'HH.mm');
  var items = d.items || [];

  items.forEach(function(it, idx){
    var v = {
      'วัน': dateStr, 'เวลา': timeStr, 'email': d.uid || '',
      'ชื่อ-สกุล': d.salemanName || '', 'รหัสเซลล์': d.salemanCode || '', 'คลัง': d.warehouse || '',
      'ชื่อร้าน': d.customerName || '', 'รหัสร้าน': '',
      'รูปแบบ': it.type || '', 'Barcode': "'" + (it.barcode || ''), 'ชื่อสินค้า': it.name || '',
      'ยกเลิก': '', 'จำนวน': it.qty || 0, 'หน่วย': it.unit || '', 'ราคา': it.price || 0,
      'ยอดเงินรวม': (it.total || 0), 'orderId': d.orderId || '',
      'หมายเหตุ': it.promo || ''
    };
    // map ไม่สนเรื่องช่องว่าง/ตัวพิมพ์
    var vmap = {};
    for (var k in v) vmap[normHead(k)] = v[k];
    var row = headers.map(function(h){ var n = normHead(h); return vmap.hasOwnProperty(n) ? vmap[n] : ''; });
    sh.appendRow(row);
  });
  return { ok:true, message:'order saved', count:items.length };
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
