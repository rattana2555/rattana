// ══════════════════════════════════════════════════════════════
// Rattana Order — Google Apps Script (วาง code นี้ใน Apps Script)
// วิธีติดตั้ง:
//   1. เปิด Google Sheet: 18RSfuDdCadccWS_3v_Ggi70_X8FGEIVGrGUedkQLYUw
//   2. เมนู Extensions > Apps Script
//   3. ลบ code เดิมทั้งหมด → วาง code นี้แทน
//   4. กด Save (💾)
//   5. Deploy > New deployment
//      - Type: Web App
//      - Execute as: Me
//      - Who has access: Anyone
//   6. Copy "Web app URL" ที่ได้
//   7. วาง URL นั้นใน rattana-order.html บรรทัด: const APPS_SCRIPT_URL = '...'
// ══════════════════════════════════════════════════════════════

const SPREADSHEET_ID = '18RSfuDdCadccWS_3v_Ggi70_X8FGEIVGrGUedkQLYUw';
const REG_SHEET_NAME = 'ลงทะเบียน'; // ชื่อ Sheet ที่จะบันทึกข้อมูล

// Headers สำหรับ row แรก
const HEADERS = [
  'วันที่ลงทะเบียน',
  'ชื่อ / ร้านค้า',
  'เบอร์โทรศัพท์',
  'บ้านเลขที่',
  'หมู่',
  'ตำบล',
  'อำเภอ',
  'จังหวัด',
  'รหัสไปรษณีย์',
  'ปีเกิด (พ.ศ.)',
  'เดือนเกิด',
  'วันเกิด',
  'หมายเหตุ',
  'Latitude',
  'Longitude',
  'Google Maps Link',
  'สถานะ',
];

// ── รับ POST จาก HTML app ──
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.action === 'register') {
      return handleRegister(data);
    }

    return jsonResponse({ success: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ── GET endpoint สำหรับทดสอบว่า Script ทำงานได้ ──
function doGet(e) {
  return jsonResponse({ status: 'Rattana Order API v1.1 ready ✓' });
}

// ── บันทึกการลงทะเบียน ──
function handleRegister(data) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // หา Sheet ชื่อ "ลงทะเบียน" ถ้าไม่มีให้สร้างใหม่
  let sheet = ss.getSheetByName(REG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(REG_SHEET_NAME);
  }

  // ถ้า Sheet ว่าง ให้ใส่ header row ก่อน
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#0d1b3e').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }

  // ตรวจสอบเบอร์ซ้ำ
  const existingPhones = sheet.getLastRow() > 1
    ? sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues().flat().map(String)
    : [];
  if (existingPhones.includes(String(data.phone || ''))) {
    return jsonResponse({ success: false, error: 'phone_exists', message: 'เบอร์นี้ลงทะเบียนแล้ว' });
  }

  // เวลาประเทศไทย (UTC+7)
  const now = new Date();
  const thaiDate = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');

  // สร้าง Google Maps link ถ้ามี GPS
  const lat = data.lat || '';
  const lng = data.lng || '';
  const mapsLink = (lat && lng) ? `https://www.google.com/maps?q=${lat},${lng}` : '';

  // เพิ่ม row ข้อมูล
  sheet.appendRow([
    thaiDate,
    data.name      || '',
    String(data.phone || ''),  // เก็บเป็น String ป้องกัน 0 หาย
    data.houseNo   || '',
    data.moo       || '',
    data.tambon    || '',
    data.amphoe    || '',
    data.province  || '',
    data.zipcode   || '',
    data.birthYear || '',
    data.birthMonth|| '',
    data.birthDay  || '',
    data.note      || '',
    lat,
    lng,
    mapsLink,
    'รอยืนยัน',    // สถานะเริ่มต้น — Admin เปลี่ยนเป็น "ยืนยัน" ได้
  ]);

  // Format เบอร์โทรให้เป็น plain text (ป้องกัน Sheets ตัด 0)
  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 3).setNumberFormat('@');

  return jsonResponse({ success: true, message: 'บันทึกเรียบร้อย' });
}

// ── Helper: สร้าง JSON response ──
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
