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
var ORDER_SHEET_NAME   = 'Orders';     // แท็บเก็บออเดอร์ (จะสร้างถ้ายังไม่มี)

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

/* ───────── บันทึกออเดอร์ ───────── */
function handleOrder(d) {
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = ss.getSheetByName(ORDER_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(ORDER_SHEET_NAME);
    sh.appendRow(['เลขที่ออเดอร์','วันที่เวลา','ชื่อ/ร้านค้า','เบอร์โทร','User ID',
                  'Saleman Code','Saleman Name','คลังส่ง','ชื่อสินค้า','จำนวน','หน่วย',
                  'ราคา/หน่วย','รวมเงิน','โปรโมชั่น','ยอดรวมทั้งบิล','สถานะ']);
  }
  var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');
  var items = d.items || [];
  items.forEach(function(it, idx){
    sh.appendRow([
      d.orderId || '', now, d.customerName || '', "'" + (d.phone || ''), d.uid || '',
      d.salemanCode || '', d.salemanName || '', d.warehouse || '',
      it.name || '', it.qty || 0, it.unit || '',
      it.price || 0, it.total || 0, it.promo || '',
      idx === 0 ? (d.total || 0) : '', 'ใหม่'
    ]);
  });
  return { ok:true, message:'order saved', count:items.length };
}

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
