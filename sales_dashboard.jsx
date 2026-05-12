import { useState, useRef, useEffect, useCallback } from "react";

// ── CONFIG ─────────────────────────────────────────────────
const PDDT_FILE_ID  = "1vKG6LbKv01S-WqkYyTQMNTzYCGdvDXKJ89ERYNdfBc8";
const BQ_PROJECT    = "project-test-471907";
const BQ_TABLE      = "`project-test-471907.Testimport.BQ_2024_2025`";
const WHS           = ["W1","W2","W3","W4","SM","C4"];

// ── UTIL ───────────────────────────────────────────────────
function fmt(n){ const v=Number(n||0); if(!v)return"-"; return v.toLocaleString("th-TH",{maximumFractionDigits:0}); }
function fmtZ(n){ const v=Number(n||0); return isNaN(v)?"-":v.toLocaleString("th-TH",{maximumFractionDigits:0}); }
function avg(obj,months){ if(!months.length)return 0; return Math.round(months.reduce((a,m)=>a+Number(obj?.[m]||0),0)/months.length); }

// ── FETCH HELPERS ──────────────────────────────────────────
async function callClaude(prompt, mcpServers){
  const res = await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:8000,
      system:"Return ONLY valid JSON. No markdown, no explanation, no code fences.",
      messages:[{role:"user",content:prompt}],
      mcp_servers: mcpServers
    })
  });
  const d = await res.json();
  if(d.error) throw new Error(d.error.message);
  // Extract text from response
  const texts = d.content?.filter(b=>b.type==="text").map(b=>b.text)||[];
  const mcpTexts = d.content?.filter(b=>b.type==="mcp_tool_result")
    .flatMap(b=>b.content||[]).map(c=>c.text||"")||[];
  return [...texts,...mcpTexts].join("\n");
}

function parseJSON(txt){
  // Try direct parse
  try { return JSON.parse(txt.trim()); } catch{}
  // Try extract first JSON object or array
  const m = txt.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if(m) try { return JSON.parse(m[1]); } catch{}
  throw new Error("ไม่สามารถแปลง JSON ได้");
}

// ── COMPONENTS ─────────────────────────────────────────────
function Dropdown({ id, label, children, minWidth=160 }){
  const [open,setOpen]=useState(false);
  const ref=useRef(null);
  useEffect(()=>{
    const h=e=>{ if(ref.current&&!ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown",h); return()=>document.removeEventListener("mousedown",h);
  },[]);
  return(
    <div ref={ref} style={{position:"relative"}}>
      <div onClick={()=>setOpen(o=>!o)}
        style={{padding:"7px 12px",borderRadius:7,border:"1px solid #c9a84c",background:"#0d1b40",
          color:"#e2c06b",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",
          gap:8,userSelect:"none",minWidth,justifyContent:"space-between"}}>
        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</span>
        <span style={{opacity:.5,fontSize:9,flexShrink:0}}>{open?"▲":"▼"}</span>
      </div>
      {open&&(
        <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,zIndex:500,background:"#0d1b40",
          border:"1px solid #c9a84c",borderRadius:9,boxShadow:"0 8px 28px rgba(0,0,0,.65)",
          overflow:"hidden",minWidth:Math.max(minWidth,200),maxHeight:340,
          display:"flex",flexDirection:"column"}}>
          {children}
        </div>
      )}
    </div>
  );
}

function DDItem({on,onClick,children}){
  return(
    <div onClick={onClick}
      style={{padding:"8px 13px",cursor:"pointer",fontSize:12,color:on?"#e2c06b":"#f5d98a",
        background:on?"#1a2e75":"transparent",borderBottom:"1px solid #132258",
        display:"flex",alignItems:"center",gap:8}}
      onMouseEnter={e=>!on&&(e.currentTarget.style.background="#132258")}
      onMouseLeave={e=>!on&&(e.currentTarget.style.background="transparent")}>
      <span style={{width:14,height:14,borderRadius:3,border:"2px solid #c9a84c",display:"flex",
        alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:900,flexShrink:0,
        background:on?"#c9a84c":"transparent",color:on?"#06102a":"transparent"}}>{on?"✓":""}</span>
      {children}
    </div>
  );
}

// ── MAIN ───────────────────────────────────────────────────
export default function App(){
  // Data
  const [pddt, setPddt] = useState([]);   // [{name, vendor, W1..C4}]
  const [bqSales, setBqSales] = useState({}); // {productName: {monthYear: {cs,ex}}}
  const [allMonths, setAllMonths] = useState([]);
  const [loadingPDDT, setLoadingPDDT] = useState(false);
  const [loadingBQ, setLoadingBQ] = useState(false);
  const [loadingBP, setLoadingBP] = useState(false);
  const [bpData, setBpData] = useState([]);  // [{name, vendor, cs, ex, wh}]
  const [bpLabel, setBpLabel] = useState("ปัจจุบัน");
  const [err, setErr] = useState(null);
  const [pddtLoaded, setPddtLoaded] = useState(false);
  const [bqLoaded, setBqLoaded] = useState(false);
  const [bpLoaded, setBpLoaded] = useState(false);

  // Filters
  const [selMonths, setSelMonths] = useState([]);
  const [selWH, setSelWH] = useState([...WHS]);
  const [selVendor, setSelVendor] = useState("all");
  const [vendorQ, setVendorQ] = useState("");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("sales");
  const [sort, setSort] = useState({col:"totCS",dir:"desc"});

  // ── FETCH PDDT ────────────────────────────────────────────
  async function fetchPDDT(){
    setLoadingPDDT(true); setErr(null);
    try{
      const prompt = `Read the Google Drive spreadsheet file ID "${PDDT_FILE_ID}".
Find the sheet named "Product Detail A" or "PDDT".
Extract ALL product rows and return a JSON array where each object has EXACTLY these fields:
- "name": value from column "ชื่อสินค้า"
- "vendor": value from column "Sup Vendor 1 (จัดจำหน่าย)" or "Sup\\nVendor 1\\n(จัดจำหน่าย)"
- "W1": numeric value from column "Stock W1" (0 if empty)
- "W2": numeric value from column "Stock W2" (0 if empty)
- "W3": numeric value from column "Stock W3" (0 if empty)
- "W4": numeric value from column "Stock W4" (0 if empty)
- "SM": numeric value from column "Stock SM" (0 if empty)
- "C4": numeric value from column "Stock C4" (0 if empty)

Return ONLY the JSON array, nothing else.`;
      const raw = await callClaude(prompt,[{type:"url",url:"https://drivemcp.googleapis.com/mcp/v1",name:"gdrive"}]);
      const data = parseJSON(raw);
      if(!Array.isArray(data)||!data.length) throw new Error("PDDT: ไม่พบข้อมูลสินค้า");
      // Normalize
      const clean = data.filter(r=>r.name).map(r=>({
        name: String(r.name||"").trim(),
        vendor: String(r.vendor||"").trim(),
        W1:Number(r.W1||0), W2:Number(r.W2||0), W3:Number(r.W3||0),
        W4:Number(r.W4||0), SM:Number(r.SM||0), C4:Number(r.C4||0)
      }));
      setPddt(clean);
      setPddtLoaded(true);
    }catch(e){ setErr("PDDT: "+e.message); }
    finally{ setLoadingPDDT(false); }
  }

  // ── FETCH BQ SALES ────────────────────────────────────────
  async function fetchBQ(){
    setLoadingBQ(true); setErr(null);
    try{
      // First get all months
      const monthsSQL = `SELECT DISTINCT Month_Year FROM ${BQ_TABLE} WHERE Month_Year IS NOT NULL ORDER BY Month_Year`;
      const mRaw = await callClaude(
        `Run this BigQuery SQL on project ${BQ_PROJECT} and return ONLY a JSON array of Month_Year strings:\n${monthsSQL}`,
        [{type:"url",url:"https://bigquery.googleapis.com/mcp",name:"bq"}]
      );
      let months = [];
      try{
        const mp = parseJSON(mRaw);
        months = Array.isArray(mp) ? mp.flat().map(x=>typeof x==="string"?x:Object.values(x)[0]).filter(Boolean) : [];
      }catch(e){
        // fallback: extract YYYY/MM patterns
        months = [...new Set(mRaw.match(/\d{4}\/\d{2}/g)||[])];
      }
      months = months.filter(m=>m&&m!=="null").sort();
      if(!months.length) throw new Error("ไม่พบเดือนใน BQ");
      setAllMonths(months);
      setSelMonths(months.slice(-6)); // default last 6 months

      // Fetch sales data
      const salesSQL = `
        SELECT TRIM(Product_Name) AS name, Month_Year AS month,
          SUM(CASE WHEN Sales_CS>0 THEN Sales_CS ELSE 0 END) AS cs,
          SUM(CASE WHEN Exvat>0 THEN Exvat ELSE 0 END) AS ex
        FROM ${BQ_TABLE}
        WHERE Product_Name IS NOT NULL AND Product_Name != ''
          AND Cat_Pack NOT IN ('Non-Product','Non Product','Premium','')
        GROUP BY Product_Name, Month_Year
        ORDER BY SUM(Sales_CS) DESC`;

      const sRaw = await callClaude(
        `Run this BigQuery SQL on project ${BQ_PROJECT}. Return ONLY a JSON array of objects with fields: name, month, cs, ex.\n${salesSQL}`,
        [{type:"url",url:"https://bigquery.googleapis.com/mcp",name:"bq"}]
      );
      const sData = parseJSON(sRaw);
      if(!Array.isArray(sData)) throw new Error("BQ Sales: ไม่พบข้อมูล");

      // Build map: {name: {month: {cs, ex}}}
      const map = {};
      for(const r of sData){
        const n = String(r.name||"").trim();
        const m = String(r.month||"").trim();
        if(!n||!m) continue;
        if(!map[n]) map[n]={};
        map[n][m]={cs:Number(r.cs||0), ex:Number(r.ex||0)};
      }
      setBqSales(map);
      setBqLoaded(true);
    }catch(e){ setErr("BQ: "+e.message); }
    finally{ setLoadingBQ(false); }
  }

  // ── FETCH BP SHEET ────────────────────────────────────────
  async function fetchBP(){
    setLoadingBP(true); setErr(null);
    try{
      const prompt = `Read Google Drive file ID "${PDDT_FILE_ID}", find sheet named "BP".
Extract all rows and return JSON array with fields:
- "name": ชื่อสินค้า
- "vendor": Cat_Vendor
- "wh": WS (warehouse column)
- "cs": Sales_CS (number)
- "ex": EXVat (number)
- "date": Doc_Date
Return ONLY JSON array.`;
      const raw = await callClaude(prompt,[{type:"url",url:"https://drivemcp.googleapis.com/mcp/v1",name:"gdrive"}]);
      const data = parseJSON(raw);
      if(!Array.isArray(data)||!data.length) throw new Error("BP: ไม่พบข้อมูล");
      const clean = data.filter(r=>r.name).map(r=>({
        name:String(r.name||"").trim(), vendor:String(r.vendor||"").trim(),
        wh:String(r.wh||"").trim(), cs:Number(r.cs||0), ex:Number(r.ex||0)
      }));
      const dates = data.map(r=>r.date).filter(Boolean).sort();
      if(dates.length) setBpLabel(`ปัจจุบัน (${dates.at(-1)})`);
      setBpData(clean);
      setBpLoaded(true);
    }catch(e){ setErr("BP: "+e.message); }
    finally{ setLoadingBP(false); }
  }

  // ── VENDORS from PDDT ────────────────────────────────────
  const vendors = [...new Set(pddt.map(r=>r.vendor).filter(Boolean))].sort();

  // ── FILTER & BUILD TABLE DATA ─────────────────────────────
  const filteredPDDT = pddt.filter(r=>{
    if(selVendor!=="all"&&r.vendor!==selVendor) return false;
    if(search&&!r.name.toLowerCase().includes(search.toLowerCase())&&
       !r.vendor.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Build sales rows: each PDDT product → look up BQ sales
  const salesRows = filteredPDDT.map(p=>{
    const salesMap = bqSales[p.name]||{};
    const cs={}, ex={};
    for(const m of selMonths){ cs[m]=salesMap[m]?.cs||0; ex[m]=salesMap[m]?.ex||0; }
    const totCS6 = selMonths.reduce((a,m)=>a+(cs[m]||0),0);
    const totEX6 = selMonths.reduce((a,m)=>a+(ex[m]||0),0);
    const avgCS  = avg(cs,selMonths), avgEX = avg(ex,selMonths);
    // BP data
    const bpRows = bpData.filter(b=>b.name===p.name);
    const bpCS   = bpRows.reduce((a,b)=>a+b.cs,0);
    const bpEX   = bpRows.reduce((a,b)=>a+b.ex,0);
    return{name:p.name, vendor:p.vendor, cs, ex, totCS6, totEX6, avgCS, avgEX,
           bpCS, bpEX, totCS:totCS6+bpCS, totEX:totEX6+bpEX};
  });

  // Stock rows
  const stockRows = filteredPDDT.map(p=>{
    const whFilter = selWH.length===WHS.length ? true : selWH.some(w=>p[w]>0);
    if(!whFilter) return null;
    const tot = selWH.reduce((a,w)=>a+(p[w]||0),0);
    return{name:p.name, vendor:p.vendor, ...Object.fromEntries(WHS.map(w=>[w,p[w]||0])), tot};
  }).filter(Boolean);

  // Sort
  function doSort(rows){ return [...rows].sort((a,b)=>{
    const va=a[sort.col]??0, vb=b[sort.col]??0;
    return sort.dir==="asc"?va-vb:vb-va;
  });}
  const SS=doSort(salesRows), ST=doSort(stockRows);

  function srt(col){ setSort(s=>s.col===col?{col,dir:s.dir==="asc"?"desc":"asc"}:{col,dir:"desc"}); }
  const SI=({col})=><span style={{opacity:.4,fontSize:8,marginLeft:2}}>{sort.col===col?(sort.dir==="asc"?"▲":"▼"):"⇅"}</span>;

  // Month management
  function toggleMonth(m){ setSelMonths(s=>s.includes(m)?s.filter(x=>x!==m):[...s,m].sort()); }
  function toggleAllMonths(){ setSelMonths(s=>s.length===allMonths.length?[]:allMonths.slice()); }
  // WH management
  function toggleWH(w){ setSelWH(s=>s.includes(w)?s.filter(x=>x!==w):[...s,w]); }
  function toggleAllWH(){ setSelWH(s=>s.length===WHS.length?[]:WHS.slice()); }

  const monthLabel = !allMonths.length?"📅 ยังไม่โหลด BQ" :
    selMonths.length===0?"📅 ยังไม่เลือก" :
    selMonths.length===allMonths.length?`📅 ทุกเดือน (${allMonths.length})` :
    selMonths.length<=3?`📅 ${selMonths.join(", ")}` : `📅 ${selMonths.length} เดือน`;

  const whLabel = selWH.length===WHS.length?"🏗️ ทุกคลัง" : selWH.length===0?"🏗️ ยังไม่เลือก" : `🏗️ ${selWH.join(", ")}`;
  const vLabel  = selVendor==="all"?`🏭 ทุก Vendor (${vendors.length})`:`🏭 ${selVendor.slice(0,22)}`;

  const filteredVendors = vendors.filter(v=>v.toLowerCase().includes(vendorQ.toLowerCase()));

  // Totals
  const tCS={},tEX={};
  selMonths.forEach(m=>{ tCS[m]=SS.reduce((a,r)=>a+(r.cs[m]||0),0); tEX[m]=SS.reduce((a,r)=>a+(r.ex[m]||0),0); });
  const gCS=SS.reduce((a,r)=>a+r.totCS,0), gEX=SS.reduce((a,r)=>a+r.totEX,0);
  const gBpCS=SS.reduce((a,r)=>a+r.bpCS,0), gBpEX=SS.reduce((a,r)=>a+r.bpEX,0);

  // Styles
  const S={
    navy:"#06102a", navy2:"#0d1b40", navy3:"#132258", navy4:"#1a2e75",
    gold:"#c9a84c", gold2:"#e2c06b", gold3:"#f5d98a", gold4:"#fdf2cc",
    bpbg:"#081e0d", bptxt:"#45d46e", bpbdr:"#28a048",
    row1:"#f7f3e8", row2:"#ffffff", txt:"#0a1535"
  };
  const th=(col,lbl,sty={})=>(
    <th onClick={()=>srt(col)}
      style={{padding:"6px 8px",border:"1px solid rgba(255,255,255,.12)",fontSize:10,fontWeight:700,
        whiteSpace:"nowrap",cursor:"pointer",userSelect:"none",textAlign:"center",...sty}}>
      {lbl}<SI col={col}/>
    </th>
  );
  const rowTd=(children,sty={})=>(
    <td style={{padding:"6px 8px",border:"1px solid #c8b88a55",whiteSpace:"nowrap",fontSize:12,...sty}}>
      {children}
    </td>
  );

  const loading = loadingPDDT||loadingBQ||loadingBP;

  return(
    <div style={{fontFamily:"'Noto Sans Thai',Sarabun,Arial,sans-serif",background:S.navy,minHeight:"100vh",color:"#f0e6c8"}}>

      {/* Header */}
      <div style={{background:`linear-gradient(135deg,#030a1a,${S.navy3})`,borderBottom:`2px solid ${S.gold}`,
        padding:"13px 18px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontSize:17,fontWeight:800,color:S.gold2}}>📊 Sales & Stock Dashboard</div>
          <div style={{fontSize:11,color:"#b8a88a",marginTop:2}}>
            BQ ยอดขาย · <span style={{color:S.bptxt}}>●</span> PDDT Stock จริง
            {pddtLoaded&&<span style={{color:"#45d46e",marginLeft:8}}>✅ PDDT ({pddt.length})</span>}
            {bqLoaded&&<span style={{color:"#42a5f5",marginLeft:8}}>✅ BQ ({allMonths.length} เดือน)</span>}
            {bpLoaded&&<span style={{color:"#45d46e",marginLeft:8}}>✅ BP</span>}
          </div>
        </div>
        <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
          <button onClick={fetchPDDT} disabled={loadingPDDT}
            style={{background:loadingPDDT?"#546e7a":"#388e3c",color:"#fff",border:"none",borderRadius:7,
              padding:"7px 14px",cursor:loadingPDDT?"not-allowed":"pointer",fontWeight:700,fontSize:12}}>
            {loadingPDDT?"⏳ PDDT...":"📦 โหลด PDDT Stock"}
          </button>
          <button onClick={fetchBQ} disabled={loadingBQ}
            style={{background:loadingBQ?"#546e7a":S.navy4,color:S.gold2,border:`1px solid ${S.gold}`,borderRadius:7,
              padding:"7px 14px",cursor:loadingBQ?"not-allowed":"pointer",fontWeight:700,fontSize:12}}>
            {loadingBQ?"⏳ BQ...":"🔄 โหลด BQ ยอดขาย"}
          </button>
          <button onClick={fetchBP} disabled={loadingBP}
            style={{background:loadingBP?"#546e7a":S.bpbg,color:S.bptxt,border:`1px solid ${S.bpbdr}`,borderRadius:7,
              padding:"7px 14px",cursor:loadingBP?"not-allowed":"pointer",fontWeight:700,fontSize:12}}>
            {loadingBP?"⏳ BP...":"🟢 โหลด BP ปัจจุบัน"}
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div style={{background:`linear-gradient(90deg,#07112a,${S.navy2})`,borderBottom:`1px solid ${S.gold}33`,
        padding:"9px 18px",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>

        {/* Vendor searchable */}
        <Dropdown label={vLabel} minWidth={200}>
          <div style={{padding:"8px 9px",borderBottom:`1px solid ${S.navy4}`}}>
            <input autoFocus value={vendorQ} onChange={e=>setVendorQ(e.target.value)}
              placeholder="🔍 พิมพ์ชื่อ Vendor..."
              style={{width:"100%",padding:"5px 8px",borderRadius:5,border:`1px solid ${S.gold}`,
                background:S.navy3,color:S.gold2,fontSize:12,outline:"none",boxSizing:"border-box"}}/>
          </div>
          <div style={{overflowY:"auto",maxHeight:250}}>
            <DDItem on={selVendor==="all"} onClick={()=>{setSelVendor("all");setVendorQ("");}}>
              ทั้งหมด ({vendors.length})
            </DDItem>
            {filteredVendors.map(v=>(
              <DDItem key={v} on={selVendor===v} onClick={()=>{setSelVendor(v);setVendorQ("");}}>
                {v}
              </DDItem>
            ))}
          </div>
        </Dropdown>

        {/* Month multi-select */}
        <Dropdown label={monthLabel} minWidth={160}>
          <div style={{overflowY:"auto",maxHeight:300}}>
            <DDItem on={selMonths.length===allMonths.length} onClick={toggleAllMonths}>
              ทุกเดือน ({allMonths.length})
            </DDItem>
            {[...allMonths].reverse().map(m=>(
              <DDItem key={m} on={selMonths.includes(m)} onClick={()=>toggleMonth(m)}>{m}</DDItem>
            ))}
          </div>
        </Dropdown>

        {/* WH multi-select */}
        <Dropdown label={whLabel} minWidth={150}>
          <div style={{overflowY:"auto",maxHeight:260}}>
            <DDItem on={selWH.length===WHS.length} onClick={toggleAllWH}>ทุกคลัง</DDItem>
            {WHS.map(w=><DDItem key={w} on={selWH.includes(w)} onClick={()=>toggleWH(w)}>{w}</DDItem>)}
          </div>
        </Dropdown>

        {/* Search */}
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="🔍 ค้นหาสินค้า..."
            style={{padding:"7px 10px",borderRadius:7,border:`1px solid ${S.gold}`,
              background:S.navy2,color:S.gold2,fontSize:12,width:170,outline:"none"}}/>
          {search&&<button onClick={()=>setSearch("")}
            style={{background:"none",border:"none",cursor:"pointer",color:S.gold,fontSize:14,padding:"4px"}}>✕</button>}
        </div>

        {/* Tabs */}
        <div style={{marginLeft:"auto",display:"flex",gap:6}}>
          {[["sales","📈 ยอดขาย"],["stock","📦 Stock"]].map(([t,l])=>(
            <button key={t} onClick={()=>setTab(t)}
              style={{padding:"7px 14px",borderRadius:8,border:"none",cursor:"pointer",fontWeight:700,fontSize:12,
                background:tab===t?`linear-gradient(135deg,${S.gold},#d48a10)`:S.navy3,
                color:tab===t?S.navy:S.gold2,
                boxShadow:tab===t?`0 2px 10px ${S.gold}55`:"none"}}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {err&&<div style={{background:"#3a0a0a",border:"1px solid #ef9a9a",borderRadius:8,
        margin:"10px 18px",padding:"10px 14px",color:"#ff8888",fontSize:12}}>❌ {err}</div>}

      {/* Loading */}
      {loading&&(
        <div style={{textAlign:"center",padding:50,color:S.gold}}>
          <div style={{fontSize:36,marginBottom:10}}>⏳</div>
          <div style={{fontSize:14,fontWeight:600}}>
            {loadingPDDT?"กำลังดึง PDDT Stock จาก Google Sheets...":
             loadingBQ?"กำลังดึงยอดขายจาก BigQuery...":
             "กำลังดึง BP Sheet..."}
          </div>
        </div>
      )}

      {/* Empty */}
      {!loading&&!pddtLoaded&&!bqLoaded&&(
        <div style={{textAlign:"center",padding:"50px 20px",color:"#888"}}>
          <div style={{fontSize:50,marginBottom:12}}>📊</div>
          <div style={{fontSize:16,fontWeight:700,color:S.gold2,marginBottom:6}}>Sales & Stock Dashboard</div>
          <div style={{fontSize:12,color:"#666",marginBottom:24}}>กดปุ่มโหลดข้อมูลด้านบนเพื่อเริ่มต้น</div>
          <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
            <button onClick={fetchPDDT} style={{background:"#388e3c",color:"#fff",border:"none",borderRadius:9,
              padding:"12px 24px",cursor:"pointer",fontWeight:700,fontSize:14}}>📦 โหลด PDDT Stock ก่อน</button>
            <button onClick={fetchBQ} style={{background:S.navy4,color:S.gold2,border:`1px solid ${S.gold}`,borderRadius:9,
              padding:"12px 24px",cursor:"pointer",fontWeight:700,fontSize:14}}>🔄 โหลด BQ ยอดขาย</button>
          </div>
        </div>
      )}

      {/* Content */}
      {!loading&&(pddtLoaded||bqLoaded)&&(
        <div style={{padding:"10px 18px"}}>
          <div style={{fontSize:11,color:"#b8a88a",marginBottom:8}}>
            {tab==="sales"?`📈 ${SS.length} รายการ`:` 📦 ${ST.length} รายการ`}
            {selVendor!=="all"&&` · ${selVendor}`}
            {search&&` · "${search}"`}
            {bpLoaded&&<span style={{color:S.bptxt,marginLeft:8}}>· {bpLabel}</span>}
          </div>

          {/* ── SALES TABLE ── */}
          {tab==="sales"&&selMonths.length===0&&(
            <div style={{textAlign:"center",padding:40,color:S.gold}}>⚠️ กรุณาเลือกเดือนอย่างน้อย 1 เดือน</div>
          )}
          {tab==="sales"&&selMonths.length>0&&(
            <div style={{overflowX:"auto",borderRadius:10,border:`1px solid ${S.gold}33`,
              boxShadow:"0 4px 24px rgba(0,0,0,.5)"}}>
              <table style={{borderCollapse:"collapse",width:"100%",background:S.navy2}}>
                <thead>
                  <tr style={{background:`linear-gradient(135deg,#030a1a,${S.navy3})`}}>
                    <th style={{padding:"6px 8px",border:"1px solid rgba(255,255,255,.08)",fontSize:10,fontWeight:700,
                      position:"sticky",left:0,background:"#030a1a",zIndex:5,textAlign:"left",
                      minWidth:170,color:S.gold2}} rowSpan={2}>ชื่อสินค้า</th>
                    <th colSpan={selMonths.length} style={{padding:"6px 8px",border:"1px solid rgba(255,255,255,.08)",
                      fontSize:10,fontWeight:700,background:`${S.navy4}aa`,color:S.gold3,
                      borderLeft:`2px solid ${S.gold}33`,borderRight:`2px solid ${S.gold}33`}}>
                      📦 ยอดขาย CS (BQ)
                    </th>
                    <th style={{padding:"6px 8px",border:"1px solid rgba(255,255,255,.08)",fontSize:10,fontWeight:700,background:S.navy3,color:S.gold2}} rowSpan={2}>AVG CS</th>
                    {bpLoaded&&<th style={{padding:"6px 8px",border:"1px solid rgba(255,255,255,.08)",fontSize:10,fontWeight:700,background:S.bpbg,color:S.bptxt,borderLeft:`2px solid ${S.bpbdr}`}} rowSpan={2}>BP CS</th>}
                    <th style={{padding:"6px 8px",border:"1px solid rgba(255,255,255,.08)",fontSize:10,fontWeight:700,background:S.gold,color:S.navy,borderLeft:`2px solid ${S.gold}`}} rowSpan={2}>รวม CS</th>
                    <th colSpan={selMonths.length} style={{padding:"6px 8px",border:"1px solid rgba(255,255,255,.08)",
                      fontSize:10,fontWeight:700,background:"#001535aa",color:"#7eb8e0",
                      borderLeft:`2px solid #4080cc33`,borderRight:`2px solid #4080cc33`}}>
                      💰 EXVat ฿ (BQ)
                    </th>
                    <th style={{padding:"6px 8px",border:"1px solid rgba(255,255,255,.08)",fontSize:10,fontWeight:700,background:"#001535",color:"#7eb8e0"}} rowSpan={2}>AVG EXVat</th>
                    {bpLoaded&&<th style={{padding:"6px 8px",border:"1px solid rgba(255,255,255,.08)",fontSize:10,fontWeight:700,background:S.bpbg,color:S.bptxt,borderLeft:`2px solid ${S.bpbdr}`}} rowSpan={2}>BP EXVat</th>}
                    <th style={{padding:"6px 8px",border:"1px solid rgba(255,255,255,.08)",fontSize:10,fontWeight:700,background:"#001535",color:"#7eb8e0",borderLeft:`2px solid #4080cc`}} rowSpan={2}>รวม EXVat</th>
                  </tr>
                  <tr style={{background:`linear-gradient(135deg,${S.navy3},#0d1e45)`}}>
                    {selMonths.map(m=>th(m,m.replace("20",""),{background:`${S.navy4}88`,color:S.gold3,minWidth:72}))}
                    {selMonths.map(m=>th(m+"ex",m.replace("20",""),{background:"#00153588",color:"#5a9fd4",minWidth:92,borderLeft:m===selMonths[0]?`2px solid #4080cc22`:"none"}))}
                  </tr>
                </thead>
                <tbody>
                  {SS.map((r,i)=>{
                    const bg=i%2===0?"#f7f3e8":"#ffffff";
                    return(
                      <tr key={r.name+i} style={{background:bg}}>
                        {rowTd(<><div style={{fontSize:12,fontWeight:700,color:S.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:165}} title={r.name}>{r.name}</div><div style={{fontSize:10,color:"#777",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:165}}>{r.vendor}</div></>,{position:"sticky",left:0,background:bg,zIndex:1,borderRight:`2px solid ${S.gold}33`,minWidth:170,maxWidth:170})}
                        {selMonths.map(m=>rowTd(fmt(r.cs[m]),{textAlign:"right",color:(r.cs[m]||0)===0?"#bbb":S.txt}))}
                        {rowTd(fmt(r.avgCS),{textAlign:"right",fontWeight:700,background:"#fdf2cc",color:S.navy,borderLeft:`2px solid ${S.gold}33`})}
                        {bpLoaded&&rowTd(fmt(r.bpCS),{textAlign:"right",fontWeight:700,background:S.bpbg,color:S.bptxt,borderLeft:`2px solid ${S.bpbdr}`})}
                        {rowTd(fmt(r.totCS),{textAlign:"right",fontWeight:800,background:"#f5d98a",color:S.navy,borderLeft:`2px solid ${S.gold}`})}
                        {selMonths.map((m,idx)=>rowTd(fmt(r.ex[m]),{textAlign:"right",fontSize:11,color:(r.ex[m]||0)===0?"#bbb":S.txt,borderLeft:idx===0?`2px solid #4080cc22`:"none"}))}
                        {rowTd(fmt(r.avgEX),{textAlign:"right",fontWeight:700,background:"#ddeeff",color:"#0a2a5c"})}
                        {bpLoaded&&rowTd(fmt(r.bpEX),{textAlign:"right",fontWeight:700,background:S.bpbg,color:S.bptxt,borderLeft:`2px solid ${S.bpbdr}`})}
                        {rowTd(fmt(r.totEX),{textAlign:"right",fontWeight:800,background:"#c8deff",color:"#0a2a5c",borderLeft:`2px solid #4080cc`})}
                      </tr>
                    );
                  })}
                  {/* Total row */}
                  <tr style={{background:S.navy2}}>
                    <td style={{padding:"7px 8px",position:"sticky",left:0,background:S.navy2,zIndex:1,
                      color:S.gold,fontWeight:800,fontSize:12,borderRight:`2px solid ${S.gold}44`}}>
                      ผลรวม ({SS.length})
                    </td>
                    {selMonths.map(m=><td key={m} style={{padding:"7px 8px",textAlign:"right",color:S.gold3,fontSize:12}}>{fmtZ(tCS[m])}</td>)}
                    <td style={{padding:"7px 8px",textAlign:"right",background:S.gold,color:S.navy,fontWeight:800,fontSize:12}}>{fmtZ(Math.round(SS.reduce((a,r)=>a+r.avgCS,0)/Math.max(SS.length,1)))}</td>
                    {bpLoaded&&<td style={{padding:"7px 8px",textAlign:"right",background:"#061510",color:S.bptxt,fontWeight:800,fontSize:12,borderLeft:`2px solid ${S.bpbdr}`}}>{fmtZ(gBpCS)}</td>}
                    <td style={{padding:"7px 8px",textAlign:"right",background:S.gold,color:S.navy,fontWeight:900,fontSize:13,borderLeft:`2px solid ${S.gold}`}}>{fmtZ(gCS)}</td>
                    {selMonths.map(m=><td key={m+"e"} style={{padding:"7px 8px",textAlign:"right",color:"#7eb8e0",fontSize:12}}>{fmtZ(tEX[m])}</td>)}
                    <td style={{padding:"7px 8px",textAlign:"right",background:"#001840",color:"#7eb8e0",fontWeight:800,fontSize:12}}>{fmtZ(Math.round(SS.reduce((a,r)=>a+r.avgEX,0)/Math.max(SS.length,1)))}</td>
                    {bpLoaded&&<td style={{padding:"7px 8px",textAlign:"right",background:"#061510",color:S.bptxt,fontWeight:800,fontSize:12,borderLeft:`2px solid ${S.bpbdr}`}}>{fmtZ(gBpEX)}</td>}
                    <td style={{padding:"7px 8px",textAlign:"right",background:"#001840",color:"#7eb8e0",fontWeight:900,fontSize:13,borderLeft:`2px solid #4080cc`}}>{fmtZ(gEX)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* ── STOCK TABLE ── */}
          {tab==="stock"&&selWH.length===0&&(
            <div style={{textAlign:"center",padding:40,color:S.gold}}>⚠️ กรุณาเลือกคลัง</div>
          )}
          {tab==="stock"&&selWH.length>0&&(
            <div style={{overflowX:"auto",borderRadius:10,border:`1px solid ${S.gold}33`,
              boxShadow:"0 4px 24px rgba(0,0,0,.5)"}}>
              <div style={{padding:"6px 10px",fontSize:11,color:"#888",background:S.navy2,
                borderBottom:`1px solid ${S.gold}22`}}>
                📦 Stock จาก PDDT โดยตรง (ชื่อสินค้า + Sup Vendor 1 + Stock W1-W4/SM/C4)
              </div>
              <table style={{borderCollapse:"collapse",width:"100%",background:S.navy2}}>
                <thead>
                  <tr style={{background:`linear-gradient(135deg,#030a1a,#0a2a12)`}}>
                    {th("name","ชื่อสินค้า",{textAlign:"left",minWidth:170,position:"sticky",left:0,background:"#030a1a",zIndex:5,color:S.gold2})}
                    {th("vendor","Sup Vendor 1 (จัดจำหน่าย)",{background:"#0a2a12",color:S.bptxt,textAlign:"left",minWidth:180})}
                    {selWH.map(w=>th(w,w,{color:S.gold3,minWidth:80}))}
                    {th("tot","รวม Stock",{background:"#1b5e20",color:"#a5d6a7",minWidth:90})}
                  </tr>
                </thead>
                <tbody>
                  {ST.map((r,i)=>{
                    const bg=i%2===0?"#f7f3e8":"#ffffff";
                    return(
                      <tr key={r.name+i} style={{background:bg}}>
                        {rowTd(<div style={{fontSize:12,fontWeight:700,color:S.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:165}} title={r.name}>{r.name}</div>,{position:"sticky",left:0,background:bg,zIndex:1,borderRight:`2px solid ${S.gold}33`,minWidth:170,maxWidth:170})}
                        {rowTd(<span style={{fontSize:11,color:"#555",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"block",maxWidth:178}} title={r.vendor}>{r.vendor||"-"}</span>,{})}
                        {selWH.map(w=>{
                          const v=r[w]||0;
                          const bg2=v<=0?"#fafafa":v<50?"#fff8e1":v<500?"#f1f8e9":"#e8f5e9";
                          const clr=v<=0?"#ccc":v<50?"#e65100":v<500?"#2e7d32":"#1b5e20";
                          return rowTd(v>0?fmt(v):"-",{textAlign:"right",fontWeight:v>0?700:400,background:bg2,color:clr});
                        })}
                        {rowTd(r.tot>0?fmt(r.tot):"-",{textAlign:"right",fontWeight:800,
                          background:r.tot>0?"#c8e6c9":"#fafafa",color:r.tot>0?"#1b5e20":"#ccc",
                          borderLeft:`2px solid #a5d6a7`})}
                      </tr>
                    );
                  })}
                  <tr style={{background:S.navy2}}>
                    <td style={{padding:"7px 8px",position:"sticky",left:0,background:S.navy2,zIndex:1,
                      color:S.gold,fontWeight:800,fontSize:12}} colSpan={2}>ผลรวม</td>
                    {selWH.map(w=><td key={w} style={{padding:"7px 8px",textAlign:"right",color:S.gold3,fontSize:12}}>
                      {fmtZ(ST.reduce((a,r)=>a+(r[w]||0),0))}
                    </td>)}
                    <td style={{padding:"7px 8px",textAlign:"right",background:"#1b5e20",color:"#a5d6a7",fontWeight:900,fontSize:13}}>
                      {fmtZ(ST.reduce((a,r)=>a+r.tot,0))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      <div style={{padding:"6px 18px 14px",display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
        {[
          ["#fdf2cc","#c9a84c","AVG (BQ)"],
          ["#081e0d","#28a048","ยอดปัจจุบัน (BP)"],
          ["#c8deff","#4080cc","รวม EXVat"],
          ["#e8f5e9","#2e7d32","Stock มาก (≥500)"],
          ["#fff8e1","#e65100","Stock น้อย (<50)"],
        ].map(([bg,bdr,lbl])=>(
          <div key={lbl} style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:"#b8a88a"}}>
            <div style={{width:12,height:12,borderRadius:3,background:bg,border:`1px solid ${bdr}`,flexShrink:0}}></div>
            {lbl}
          </div>
        ))}
      </div>
    </div>
  );
}
