// ══════════════════════════════════════════════════════════════
// Rattana Order — Google Apps Script v2.0
// วิธีติดตั้ง:
//   1. เปิด Google Sheet: 18RSfuDdCadccWS_3v_Ggi70_X8FGEIVGrGUedkQLYUw
//   2. เมนู Extensions > Apps Script
//   3. ลบ code เดิม → วาง code นี้แทน
//   4. ⚠️ เปิด BigQuery API:
//      - ซ้ายมือกด + ข้าง "Services"
//      - หา "BigQuery API" → กด Add
//   5. Save (💾) → Deploy > Manage deployments > Edit (✏️) > New version > Deploy
// ══════════════════════════════════════════════════════════════

const SPREADSHEET_ID = '18RSfuDdCadccWS_3v_Ggi70_X8FGEIVGrGUedkQLYUw';
const REG_SHEET_NAME = 'ลงทะเบียน';

// ── BigQuery config ──
const BQ_PROJECT = 'project-test-471907';
const BQ_DATASET = 'Testimport';
const BQ_TABLE   = 'BQ_2024_2025';   // เปลี่ยนถ้าต้องการตารางอื่น
const BQ_QTY_COL = 'Qty';            // ⚠️ แก้ชื่อคอลัมน์ Quantity ถ้าต่างกัน

// Headers สำหรับ sheet ลงทะเบียน
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

// ══════════════════════════════════════
// GET — ทดสอบ + ดึงประวัติ BigQuery
// ══════════════════════════════════════
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'getHistory') return handleGetHistory(e.parameter);
  return jsonResponse({ status: 'Rattana Order API v2.0 ready ✓' });
}

// ══════════════════════════════════════
// POST — บันทึกลงทะเบียน
// ══════════════════════════════════════
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'register') return handleRegister(data);
    return jsonResponse({ success: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ══════════════════════════════════════
// BigQuery — ดึงประวัติซื้อของร้านค้า
// ══════════════════════════════════════
function handleGetHistory(params) {
  const phone = String(params.phone || '').replace(/\D/g, '');
  const name  = String(params.name  || '').replace(/'/g, "''");  // SQL escape

  if (!phone && !name) {
    return jsonResponse({ success: false, error: 'ไม่มีข้อมูลร้านค้า' });
  }

  // WHERE: ค้นจาก Customer_Code (ตัด BC- ออก) หรือ Customer_Name
  const conds = [];
  if (phone) conds.push(`REPLACE(Customer_Code, 'BC-', '') = '${phone}'`);
  if (name)  conds.push(`LOWER(Customer_Name) LIKE LOWER('%${name}%')`);
  const where = conds.join(' OR ');

  const fullTable = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.' + BQ_TABLE + '`';

  const sql = [
    'SELECT',
    "  REPLACE(COALESCE(Product_Code, ''), 'BC-', '') AS BarCode,",
    '  Product_Code,',
    "  COALESCE(Product_Name, '')  AS Product_Name,",
    "  COALESCE(Unit, '')          AS Unit,",
    '  COALESCE(EAPerUnit, 0)      AS EAPerUnit,',
    '  SUM(COALESCE(' + BQ_QTY_COL + ', 0)) AS TotalQty,',
    '  COUNT(DISTINCT Doc_No)          AS NumOrders',
    'FROM ' + fullTable,
    'WHERE ' + where,
    'GROUP BY BarCode, Product_Code, Product_Name, Unit, EAPerUnit',
    'ORDER BY TotalQty DESC',
    'LIMIT 100',
  ].join('\n');

  try {
    const response = BigQuery.Jobs.query(
      { query: sql, useLegacySql: false, timeoutMs: 30000 },
      BQ_PROJECT
    );

    const fields    = (response.schema && response.schema.fields) || [];
    const fieldNames = fields.map(function(f){ return f.name; });

    const rows = (response.rows || []).map(function(row) {
      var obj = {};
      fieldNames.forEach(function(n, i) {
        obj[n] = (row.f && row.f[i]) ? row.f[i].v : null;
      });
      return obj;
    });

    return jsonResponse({ success: true, data: rows });

  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ══════════════════════════════════════
// บันทึกการลงทะเบียน → Google Sheet
// ══════════════════════════════════════
function handleRegister(data) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let   sheet = ss.getSheetByName(REG_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(REG_SHEET_NAME);

  // สร้าง header row ถ้ายังว่าง
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length)
         .setFontWeight('bold')
         .setBackground('#0d1b3e')
         .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }

  // ตรวจเบอร์ซ้ำ
  const existingPhones = sheet.getLastRow() > 1
    ? sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues().flat().map(String)
    : [];
  if (existingPhones.includes(String(data.phone || ''))) {
    return jsonResponse({ success: false, error: 'phone_exists', message: 'เบอร์นี้ลงทะเบียนแล้ว' });
  }

  // เวลาไทย UTC+7
  const thaiDate = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');

  // Google Maps link
  const lat      = data.lat || '';
  const lng      = data.lng || '';
  const mapsLink = (lat && lng) ? 'https://www.google.com/maps?q=' + lat + ',' + lng : '';

  sheet.appendRow([
    thaiDate,
    data.name       || '',
    String(data.phone || ''),
    data.houseNo    || '',
    data.moo        || '',
    data.tambon     || '',
    data.amphoe     || '',
    data.province   || '',
    data.zipcode    || '',
    data.birthYear  || '',
    data.birthMonth || '',
    data.birthDay   || '',
    data.note       || '',
    lat,
    lng,
    mapsLink,
    'รอยืนยัน',
  ]);

  // เบอร์โทรเป็น plain text
  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 3).setNumberFormat('@');

  return jsonResponse({ success: true, message: 'บันทึกเรียบร้อย' });
}

// ── Helper ──
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
