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

// ───── LINE Messaging API (ส่งสรุปออเดอร์เข้าไลน์ลูกค้า) ─────
// เอา Channel access token (long-lived) จาก LINE Developers > channel Messaging API ของ OA Rattana_Official
var LINE_TOKEN = 'PASTE_LINE_MESSAGING_API_CHANNEL_ACCESS_TOKEN';

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.action === 'register') return json(handleRegister(data));
    if (data.action === 'order')    return json(handleOrder(data));
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
  return json({ ok:true, service:'Rattana Online Order', time:new Date() });
}
function jsonp(cb, obj){ return ContentService.createTextOutput(cb + '(' + JSON.stringify(obj) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT); }

/* ───────── ตะกร้าร่วม (ซิงค์ข้ามเครื่องของร้านเดียวกัน ผูกด้วยเบอร์) ───────── */
function getCartSheet(){
  var ss = SpreadsheetApp.openById(REG_SPREADSHEET_ID);
  var sh = ss.getSheetByName('ตะกร้า');
  if(!sh){ sh = ss.insertSheet('ตะกร้า'); sh.appendRow(['เบอร์','ชื่อร้าน','User ID','อัปเดตเมื่อ','จำนวนรายการ','ยอดรวม','รายการ(JSON)','ts']); }
  return sh;
}
function handleSaveCart(d){
  var sh = getCartSheet();
  var phone = String(d.phone||'').replace(/\D/g,''); if(!phone) return { ok:false, error:'no phone' };
  var cartStr = d.cart || '[]'; var cart=[]; try{ cart=JSON.parse(cartStr); }catch(e){}
  var count=0, total=0; cart.forEach(function(it){ var q=Number(it.qty)||0; count+=q; total+=q*(Number(it.price)||0); });
  var ts = Number(d.ts) || (new Date().getTime());
  var now = Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yyyy HH:mm');
  var last = sh.getLastRow(), rowIdx=-1;
  if(last>=2){ var col=sh.getRange(2,1,last-1,1).getValues();
    for(var i=0;i<col.length;i++){ if(String(col[i][0]).replace(/\D/g,'')===phone){ rowIdx=i+2; break; } } }
  if(!cart.length){ if(rowIdx>0) sh.deleteRow(rowIdx); return { ok:true, cleared:true }; }   // ตะกร้าว่าง -> ลบแถว
  var row = [ "'"+phone, d.name||'', d.uid||'', now, count, total, cartStr, ts ];
  if(rowIdx>0) sh.getRange(rowIdx,1,1,row.length).setValues([row]); else sh.appendRow(row);
  return { ok:true, ts:ts };
}
function getCartFor(phone){
  var target=String(phone||'').replace(/\D/g,''); if(!target) return { ok:true, cart:[], ts:0 };
  var sh=getCartSheet(); var last=sh.getLastRow(); if(last<2) return { ok:true, cart:[], ts:0 };
  var vals=sh.getRange(2,1,last-1,8).getValues();
  for(var i=0;i<vals.length;i++){
    if(String(vals[i][0]).replace(/\D/g,'')===target){
      var cart=[]; try{ cart=JSON.parse(String(vals[i][6]||'[]')); }catch(e){}
      return { ok:true, cart:cart, ts:Number(vals[i][7])||0, name:vals[i][1]||'' };
    }
  }
  return { ok:true, cart:[], ts:0 };
}
function clearCartFor(phone){
  var target=String(phone||'').replace(/\D/g,''); if(!target) return;
  var sh=getCartSheet(); var last=sh.getLastRow(); if(last<2) return;
  var col=sh.getRange(2,1,last-1,1).getValues();
  for(var i=0;i<col.length;i++){ if(String(col[i][0]).replace(/\D/g,'')===target){ sh.deleteRow(i+2); return; } }
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
      'โปรที่ใช้': it.promo || '',        // โปร/ของแถมที่ใช้ -> คอลัมน์ "โปรที่ใช้"
      'หมายเหตุ': d.note || ''            // หมายเหตุที่ลูกค้าพิมพ์ถึงร้านค้า
    };
    // map ไม่สนเรื่องช่องว่าง/ตัวพิมพ์
    var vmap = {};
    for (var k in v) vmap[normHead(k)] = v[k];
    var row = headers.map(function(h){ var n = normHead(h); return vmap.hasOwnProperty(n) ? vmap[n] : ''; });
    sh.appendRow(row);
  });
  try { pushLineOrder(d, sh); } catch (e) {}   // ส่งสรุปเข้าไลน์ลูกค้า (ไม่ให้ล้มถ้า push พลาด)
  clearCartFor(d.phone);   // ยืนยันแล้ว -> ล้างตะกร้าร่วมของร้าน (ทุกเครื่องตะกร้าว่างพร้อมกัน)
  return { ok:true, message:'order saved', count:items.length };
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
function pushLineOrder(d, sh){
  if(!LINE_TOKEN || LINE_TOKEN.indexOf('PASTE')===0) return;   // ยังไม่ตั้ง token
  var uid = d.uid; if(!uid) return;                            // ส่งได้เฉพาะลูกค้าที่เข้าผ่านไลน์
  var items = d.items || [];
  var lines = items.map(function(it){
    var isGift = it.type==='แถม';
    return { type:'box', layout:'vertical', margin:'sm', contents:[
      { type:'text', text:String(it.name||''), size:'sm', wrap:true, color:(isGift?'#2ecc71':'#0d1b3e') },
      { type:'box', layout:'horizontal', contents:[
        { type:'text', text:(it.qty||0)+' '+(it.unit||''), size:'xs', color:'#6b7896', flex:3, wrap:true },
        { type:'text', text:(isGift?'🎁 ฟรี':numFmt(it.total)+' .-'), size:'xs', align:'end', color:(isGift?'#2ecc71':'#0d1b3e'), flex:2 }
      ]}
    ]};
  });
  var cum = cumulativeFor(sh, uid);
  var dateStr = Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yyyy');
  var body = [
    { type:'text', text:'สรุปรายการสั่งซื้อสินค้า', weight:'bold', size:'lg', color:'#0d1b3e', align:'center' },
    { type:'text', text:'NO. '+(d.orderId||''), size:'sm', weight:'bold', color:'#2ecc71' },
    { type:'text', text:'วันที่: '+dateStr, size:'sm', color:'#6b7896' },
    { type:'text', text:'ร้าน: '+(d.customerName||''), size:'sm', color:'#6b7896', wrap:true },
    { type:'separator', margin:'md' },
    { type:'text', text:'รายการสินค้า', weight:'bold', size:'sm', margin:'md' }
  ].concat(lines).concat([
    { type:'separator', margin:'md' },
    { type:'box', layout:'horizontal', margin:'md', contents:[
      { type:'text', text:'ยอดเงินรวม', weight:'bold', color:'#0d1b3e' },
      { type:'text', text:numFmt(d.total)+' บาท', weight:'bold', align:'end', color:'#0d1b3e' }
    ]},
    { type:'text', text:'* ราคาอ้างอิง ยอดจริงยืนยันโดยฝ่ายขาย', size:'xxs', color:'#9aa6c0', wrap:true, margin:'sm' }
  ]);
  if(cum.spend>0 || cum.items>0){
    body.push({ type:'separator', margin:'md' });
    body.push({ type:'box', layout:'horizontal', margin:'sm', contents:[
      { type:'text', text:'🛒 ยอดซื้อสะสม', size:'xs', color:'#6b7896' },
      { type:'text', text:numFmt(cum.spend)+' บาท', size:'xs', align:'end', weight:'bold', color:'#1a6fb8' } ]});
    body.push({ type:'box', layout:'horizontal', contents:[
      { type:'text', text:'⭐ รายการสินค้าสะสม', size:'xs', color:'#6b7896' },
      { type:'text', text:String(cum.items), size:'xs', align:'end', weight:'bold', color:'#a87800' } ]});
  }
  body.push({ type:'separator', margin:'md' });
  body.push({ type:'text', text:'ระบบอัตโนมัติ RATTANA OFFICIAL', size:'xs', color:'#e74c3c', align:'center', weight:'bold', margin:'md' });

  var msg = { to: uid, messages:[ { type:'flex', altText:'สรุปคำสั่งซื้อ '+(d.orderId||''),
    contents:{ type:'bubble', body:{ type:'box', layout:'vertical', spacing:'sm', contents:body } } } ] };
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
