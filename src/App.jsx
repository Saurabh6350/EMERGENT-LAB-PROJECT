import { useState, useRef, useCallback, useEffect } from "react";

const GROQ_MODEL = "llama-3.3-70b-versatile";
const COLORS = ["#6ee7b7","#818cf8","#fb923c","#f472b6","#38bdf8","#facc15","#a78bfa","#34d399","#e879f9","#22d3ee"];
const API_KEY = process.env.REACT_APP_GROQ_API_KEY || "";

// ─── CSV Helpers ───────────────────────────────────────────────────────────────
function parseCSV(text){
  const lines=text.trim().split("\n");
  const headers=lines[0].split(",").map(h=>h.trim().replace(/^"|"$/g,""));
  const rows=lines.slice(1).filter(l=>l.trim()).map(line=>{
    const vals=[];let cur="",inQ=false;
    for(let ch of line){if(ch==='"')inQ=!inQ;else if(ch===","&&!inQ){vals.push(cur.trim());cur="";}else cur+=ch;}
    vals.push(cur.trim());
    return Object.fromEntries(headers.map((h,i)=>[h,vals[i]??""]));
  });
  return{headers,rows};
}
function rowsToCSV(rows){
  if(!rows.length)return"";
  const h=Object.keys(rows[0]);
  return[h.join(","),...rows.map(r=>h.map(k=>`"${(r[k]??"").toString().replace(/"/g,'""')}"`).join(","))].join("\n");
}

// ─── NEW: Date/Time Intelligence ──────────────────────────────────────────────
const DATE_RX=[/^\d{4}-\d{2}-\d{2}/,/^\d{2}\/\d{2}\/\d{4}/,/^\d{2}-\d{2}-\d{4}/,/^\d{4}\/\d{2}\/\d{2}/,/^[A-Za-z]{3,9}\s\d{1,2},?\s\d{4}/,/^\d{4}-\d{2}$/];
function looksDate(v){return DATE_RX.some(r=>r.test(String(v||"").trim()));}
function parseFlexDate(v){
  if(!v)return null;
  const s=String(v).trim();
  const ddmm=s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if(ddmm)return new Date(`${ddmm[3]}-${ddmm[2]}-${ddmm[1]}`);
  const d=new Date(s);return isNaN(d)?null:d;
}

// ─── Type Inference ────────────────────────────────────────────────────────────
function inferTypes(headers,rows){
  return headers.map(h=>{
    const vals=rows.map(r=>r[h]).filter(v=>v!==""&&v!=null);
    if(!vals.length)return{name:h,type:"string"};
    const numN=vals.filter(v=>!isNaN(Number(v))).length;
    if(numN/vals.length>0.8)return{name:h,type:"number"};
    const sample=vals.slice(0,30);
    const dateN=sample.filter(v=>looksDate(v)).length;
    if(dateN/sample.length>0.6)return{name:h,type:"date"};
    return{name:h,type:"string"};
  });
}

// ─── Stats ─────────────────────────────────────────────────────────────────────
function computeStats(rows,col){
  const vals=rows.map(r=>Number(r[col])).filter(v=>!isNaN(v));
  if(!vals.length)return null;
  const sorted=[...vals].sort((a,b)=>a-b);
  const mean=vals.reduce((s,v)=>s+v,0)/vals.length;
  const variance=vals.reduce((s,v)=>s+(v-mean)**2,0)/vals.length;
  const q1=sorted[Math.floor(sorted.length*0.25)];
  const q3=sorted[Math.floor(sorted.length*0.75)];
  const iqr=q3-q1;
  const outliers=vals.filter(v=>v<q1-1.5*iqr||v>q3+1.5*iqr);
  return{
    mean:mean.toFixed(2),min:sorted[0].toFixed(2),max:sorted[sorted.length-1].toFixed(2),
    median:sorted[Math.floor(sorted.length/2)].toFixed(2),std:Math.sqrt(variance).toFixed(2),
    count:vals.length,q1:q1?.toFixed(2),q3:q3?.toFixed(2),
    outlierCount:outliers.length,outlierPct:((outliers.length/vals.length)*100).toFixed(1),
  };
}

// ─── NEW: Anomaly Detection ────────────────────────────────────────────────────
function detectAnomalies(rows,colTypes){
  const anomalies=[];
  colTypes.forEach(c=>{
    const missing=rows.filter(r=>r[c.name]===""||r[c.name]==null).length;
    if(missing>0){
      const pct=((missing/rows.length)*100).toFixed(1);
      anomalies.push({type:"missing",col:c.name,count:missing,pct,
        severity:missing/rows.length>0.15?"warning":"neutral",
        message:`${pct}% missing values in "${c.name}" (${missing} rows)`,fix:"Fill Missing Values → Clean tab"});
    }
  });
  colTypes.filter(c=>c.type==="number").forEach(c=>{
    const s=computeStats(rows,c.name);
    if(s&&s.outlierCount>0){
      anomalies.push({type:"outlier",col:c.name,count:s.outlierCount,pct:s.outlierPct,
        severity:s.outlierCount/s.count>0.05?"warning":"neutral",
        message:`${s.outlierCount} outliers in "${c.name}" (${s.outlierPct}%, IQR method)`,fix:"Investigate → Charts → Histogram"});
    }
  });
  const seen=new Set();let dupes=0;
  rows.forEach(r=>{const k=JSON.stringify(r);if(seen.has(k))dupes++;else seen.add(k);});
  if(dupes>0){
    anomalies.push({type:"duplicate",col:"all",count:dupes,pct:((dupes/rows.length)*100).toFixed(1),
      severity:dupes/rows.length>0.03?"warning":"neutral",
      message:`${dupes} duplicate rows (${((dupes/rows.length)*100).toFixed(1)}%)`,fix:"Remove Duplicates → Clean tab"});
  }
  colTypes.filter(c=>c.type==="number").forEach(c=>{
    const s=computeStats(rows,c.name);
    if(s&&parseFloat(s.std)===0){
      anomalies.push({type:"constant",col:c.name,count:rows.length,pct:"100",severity:"neutral",
        message:`"${c.name}" is constant — all values = ${s.mean}`,fix:"Column may be uninformative"});
    }
  });
  return anomalies;
}

// ─── NEW: Smart Correlation Finder ────────────────────────────────────────────
function computeTopCorrelations(rows,colTypes){
  const numCols=colTypes.filter(c=>c.type==="number");
  const pairs=[];
  for(let i=0;i<numCols.length;i++){
    for(let j=i+1;j<numCols.length;j++){
      const a=numCols[i],b=numCols[j];
      const av=rows.map(r=>Number(r[a.name])).filter(v=>!isNaN(v));
      const bv=rows.map(r=>Number(r[b.name])).filter(v=>!isNaN(v));
      const n=Math.min(av.length,bv.length);if(n<5)continue;
      const am=av.slice(0,n).reduce((s,v)=>s+v,0)/n;
      const bm=bv.slice(0,n).reduce((s,v)=>s+v,0)/n;
      const num=av.slice(0,n).reduce((s,v,k)=>s+(v-am)*(bv[k]-bm),0);
      const da=Math.sqrt(av.slice(0,n).reduce((s,v)=>s+(v-am)**2,0));
      const db=Math.sqrt(bv.slice(0,n).reduce((s,v)=>s+(v-bm)**2,0));
      const r=da&&db?num/(da*db):0;
      pairs.push({a:a.name,b:b.name,r:parseFloat(r.toFixed(3)),absR:Math.abs(r)});
    }
  }
  return pairs.sort((x,y)=>y.absR-x.absR).slice(0,5);
}

function evalFormula(formula,row){
  try{
    const expr=formula.replace(/\[([^\]]+)\]/g,(_,col)=>{const v=Number(row[col]);return isNaN(v)?`"${row[col]}"`:v;});
    // eslint-disable-next-line no-new-func
    return Function(`"use strict";return(${expr})`)();
  }catch{return"";}
}

function executeSimpleSQL(sql,rows){
  let result=[...rows];
  const whereMatch=sql.match(/WHERE\s+(.+?)(?:\s+GROUP BY|\s+ORDER BY|\s+LIMIT|$)/i);
  if(whereMatch){
    const m=whereMatch[1].trim().match(/(\w+)\s*(=|!=|>|<|>=|<=|LIKE)\s*'?([^']+)'?/i);
    if(m){const[,col,op,val]=m;result=result.filter(r=>{const rv=r[col];const nv=Number(val);if(op==="=")return rv==val;if(op==="!=")return rv!=val;if(op===">")return Number(rv)>nv;if(op==="<")return Number(rv)<nv;if(op===">=")return Number(rv)>=nv;if(op==="<=")return Number(rv)<=nv;if(op.toUpperCase()==="LIKE")return String(rv).toLowerCase().includes(val.toLowerCase().replace(/%/g,""));return true;});}
  }
  const groupMatch=sql.match(/GROUP BY\s+(\w+)/i);
  const selectMatch=sql.match(/SELECT\s+(.+?)\s+FROM/i);
  if(groupMatch&&selectMatch){
    const groupCol=groupMatch[1];
    const aggMatch=selectMatch[1].match(/(COUNT|SUM|AVG|MAX|MIN)\((\*|\w+)\)/i);
    const groups={};result.forEach(r=>{const k=r[groupCol];if(!groups[k])groups[k]=[];groups[k].push(r);});
    return Object.entries(groups).map(([k,grp])=>{
      const row={[groupCol]:k};
      if(aggMatch){const[,fn,col]=aggMatch;const vals=grp.map(r=>Number(r[col==="*"?Object.keys(r)[0]:col])).filter(v=>!isNaN(v));if(fn==="COUNT")row["COUNT"]=grp.length;else if(fn==="SUM")row[`SUM(${col})`]=vals.reduce((s,v)=>s+v,0).toFixed(2);else if(fn==="AVG")row[`AVG(${col})`]=(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(2);else if(fn==="MAX")row[`MAX(${col})`]=Math.max(...vals).toFixed(2);else if(fn==="MIN")row[`MIN(${col})`]=Math.min(...vals).toFixed(2);}
      return row;
    });
  }
  const orderMatch=sql.match(/ORDER BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
  if(orderMatch){const[,col,dir]=orderMatch;result.sort((a,b)=>{const d=isNaN(Number(a[col]))?String(a[col]).localeCompare(String(b[col])):Number(a[col])-Number(b[col]);return dir?.toUpperCase()==="DESC"?-d:d;});}
  const limitMatch=sql.match(/LIMIT\s+(\d+)/i);
  if(limitMatch)result=result.slice(0,Number(limitMatch[1]));
  if(selectMatch&&!sql.toUpperCase().includes("GROUP BY")){const cols=selectMatch[1].split(",").map(c=>c.trim());if(!cols.includes("*"))result=result.map(r=>Object.fromEntries(cols.map(c=>[c,r[c]])));}
  return result;
}

// ─── AI ────────────────────────────────────────────────────────────────────────
async function callAI(messages,system=""){
  const groqMessages=[];
  if(system)groqMessages.push({role:"system",content:system});
  messages.forEach(m=>groqMessages.push({role:m.role==="user"?"user":"assistant",content:typeof m.content==="string"?m.content:JSON.stringify(m.content)}));
  const res=await fetch("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${API_KEY}`},
    body:JSON.stringify({model:GROQ_MODEL,messages:groqMessages,temperature:0.7,max_tokens:1500})
  });
  const data=await res.json();
  if(data.error)throw new Error(data.error.message||"AI error");
  return data.choices?.[0]?.message?.content||"";
}

// ─── Theme ─────────────────────────────────────────────────────────────────────
const themes={
  dark:{bg:"#080f1a",surface:"#0f172a",border:"#1e293b",text:"#e2e8f0",muted:"#94a3b8",faint:"#334155",vfaint:"#1e293b",inputBg:"#080f1a"},
  light:{bg:"#f1f5f9",surface:"#ffffff",border:"#e2e8f0",text:"#0f172a",muted:"#64748b",faint:"#94a3b8",vfaint:"#f1f5f9",inputBg:"#ffffff"}
};

// ─── NEW: SVG-to-PNG Download Helper ──────────────────────────────────────────
function downloadChartAsPNG(containerRef,filename="chart.png"){
  const svg=containerRef.current?.querySelector("svg");
  if(!svg){alert("No chart found to download.");return;}
  const clone=svg.cloneNode(true);
  const W=svg.viewBox?.baseVal?.width||svg.getBoundingClientRect().width||500;
  const H=svg.viewBox?.baseVal?.height||svg.getBoundingClientRect().height||300;
  clone.setAttribute("xmlns","http://www.w3.org/2000/svg");
  const svgStr=new XMLSerializer().serializeToString(clone);
  const canvas=document.createElement("canvas");
  canvas.width=W*2;canvas.height=H*2;
  const ctx=canvas.getContext("2d");
  ctx.scale(2,2);ctx.fillStyle="#080f1a";ctx.fillRect(0,0,W,H);
  const img=new Image();
  img.onload=()=>{ctx.drawImage(img,0,0);const a=document.createElement("a");a.download=filename;a.href=canvas.toDataURL("image/png");a.click();};
  img.src="data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svgStr)));
}

// ─── Style helpers ─────────────────────────────────────────────────────────────
const mkCard=(T,extra={})=>({background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,...extra});
const mkLbl=(T,extra={})=>({fontSize:11,color:T.faint,letterSpacing:"0.1em",...extra});
const mkBtn=(active=true,T)=>({padding:"10px 20px",background:active?"linear-gradient(135deg,#6ee7b7,#818cf8)":"transparent",border:active?"none":`1px solid ${T?.border||"#1e293b"}`,borderRadius:8,color:active?"#080f1a":(T?.muted||"#475569"),fontWeight:700,cursor:active?"pointer":"wait",fontFamily:"inherit",fontSize:11,letterSpacing:"0.06em"});
const mkInput=(T)=>({flex:1,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 14px",color:T.text,fontSize:13,fontFamily:"inherit",outline:"none"});
const mkSel=(T)=>({background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,padding:"7px 11px",color:T.muted,fontSize:12,fontFamily:"inherit",outline:"none"});

// ─── NEW: Floating Tooltip component ──────────────────────────────────────────
function ChartTooltip({visible,x,y,label,value,color,extra,theme}){
  const T=themes[theme];
  if(!visible)return null;
  return(
    <div style={{position:"fixed",left:x+14,top:y-48,zIndex:9999,pointerEvents:"none",
      background:T.surface,border:`1px solid ${color||T.border}`,borderRadius:8,
      padding:"8px 12px",boxShadow:"0 4px 20px rgba(0,0,0,0.5)",minWidth:120}}>
      {label&&<div style={{fontSize:11,fontWeight:700,color:T.text,marginBottom:3,maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</div>}
      {value!==undefined&&<div style={{fontSize:12,color:color||"#6ee7b7",fontWeight:600}}>{typeof value==="number"?value.toLocaleString(undefined,{maximumFractionDigits:2}):value}</div>}
      {extra&&<div style={{fontSize:10,color:T.muted,marginTop:2}}>{extra}</div>}
    </div>
  );
}

// ─── NEW: Chart header with download button ────────────────────────────────────
function ChartHeader({title,subtitle,chartRef,filename,theme}){
  const T=themes[theme];
  if(!title&&!subtitle)return null;
  return(
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
      <div>
        {title&&<div style={{fontSize:12,fontWeight:700,color:T.muted,letterSpacing:"0.05em"}}>{title}</div>}
        {subtitle&&<div style={{fontSize:10,color:T.faint,marginTop:2}}>{subtitle}</div>}
      </div>
      {chartRef&&<button onClick={()=>downloadChartAsPNG(chartRef,filename||`${title||"chart"}.png`)}
        style={{fontSize:10,padding:"4px 10px",background:"transparent",border:`1px solid ${T.border}`,
          borderRadius:5,color:T.faint,cursor:"pointer",fontFamily:"inherit",flexShrink:0,
          transition:"all 0.15s"}}
        onMouseEnter={e=>{e.currentTarget.style.borderColor="#6ee7b7";e.currentTarget.style.color="#6ee7b7";}}
        onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;e.currentTarget.style.color=T.faint;}}>
        ⬇ PNG
      </button>}
    </div>
  );
}

// ─── UPGRADED: BarChart with tooltips + download ───────────────────────────────
function BarChart({data,labelKey,valueKey,color="#6ee7b7",theme,title,subtitle}){
  const T=themes[theme];
  const max=Math.max(...data.map(d=>Number(d[valueKey])||0));
  const [tip,setTip]=useState({visible:false,x:0,y:0,label:"",value:0});
  const ref=useRef();
  return(
    <div>
      <ChartHeader title={title} subtitle={subtitle} chartRef={ref} filename={`${title||"bar"}.png`} theme={theme}/>
      <div ref={ref} style={{overflowX:"auto"}}>
        <div style={{display:"flex",flexDirection:"column",gap:5,minWidth:300}}>
          {/* Y-axis label area */}
          <div style={{fontSize:10,color:T.faint,marginBottom:4,paddingLeft:130}}>{valueKey&&valueKey!=="count"?valueKey:"Count"}</div>
          {data.slice(0,15).map((d,i)=>{
            const val=Number(d[valueKey])||0;const pct=max?(val/max)*100:0;
            return(<div key={i} style={{display:"flex",alignItems:"center",gap:10}}>
              <div title={String(d[labelKey])} style={{width:130,fontSize:11,color:T.muted,textAlign:"right",flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{String(d[labelKey]).slice(0,18)}</div>
              <div style={{flex:1,background:T.vfaint,borderRadius:4,height:22,position:"relative",cursor:"crosshair"}}
                onMouseEnter={e=>setTip({visible:true,x:e.clientX,y:e.clientY,label:String(d[labelKey]),value:val})}
                onMouseMove={e=>setTip(t=>({...t,x:e.clientX,y:e.clientY}))}
                onMouseLeave={()=>setTip(t=>({...t,visible:false}))}>
                <div style={{width:`${pct}%`,background:color,borderRadius:4,height:"100%",transition:"width 0.6s",opacity:0.9}}/>
                <span style={{position:"absolute",right:6,top:3,fontSize:11,color:T.text}}>{val%1===0?val.toLocaleString():Number(val).toFixed(1)}</span>
              </div>
            </div>);
          })}
          {/* Legend */}
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4,paddingLeft:130}}>
            <div style={{width:12,height:12,borderRadius:2,background:color}}/>
            <div style={{fontSize:10,color:T.faint}}>{labelKey||"Category"} → {valueKey||"Value"}</div>
          </div>
        </div>
        <ChartTooltip {...tip} color={color} theme={theme}/>
      </div>
    </div>
  );
}

// ─── UPGRADED: PieChart with tooltips + download ───────────────────────────────
function PieChart({data,labelKey,valueKey,theme,title,subtitle}){
  const T=themes[theme];
  const total=data.reduce((s,d)=>s+(Number(d[valueKey])||0),0);
  let angle=-Math.PI/2;
  const [hovered,setHovered]=useState(null);
  const [tip,setTip]=useState({visible:false,x:0,y:0});
  const ref=useRef();
  const slices=data.slice(0,8).map((d,i)=>{
    const val=Number(d[valueKey])||0;const frac=total?val/total:0;
    const start=angle;angle+=frac*2*Math.PI;
    const x1=Math.cos(start)*80+100,y1=Math.sin(start)*80+100;
    const x2=Math.cos(angle)*80+100,y2=Math.sin(angle)*80+100;
    return{path:`M100,100 L${x1},${y1} A80,80 0 ${frac>0.5?1:0},1 ${x2},${y2} Z`,
      color:COLORS[i%COLORS.length],label:d[labelKey],val,pct:(frac*100).toFixed(1)};
  });
  return(
    <div>
      <ChartHeader title={title} subtitle={subtitle} chartRef={ref} filename={`${title||"pie"}.png`} theme={theme}/>
      <div ref={ref} style={{display:"flex",alignItems:"center",gap:24,flexWrap:"wrap",position:"relative"}}>
        <svg width={200} height={200} style={{flexShrink:0}}>
          {slices.map((s,i)=>(
            <path key={i} d={s.path} fill={s.color} stroke={T.bg} strokeWidth={hovered===i?3:2}
              opacity={hovered===null||hovered===i?0.9:0.5}
              style={{cursor:"pointer",transition:"opacity 0.2s"}}
              onMouseEnter={e=>{setHovered(i);setTip({visible:true,x:e.clientX,y:e.clientY,label:String(s.label),value:s.val,extra:`${s.pct}% of total`,color:s.color});}}
              onMouseMove={e=>setTip(t=>({...t,x:e.clientX,y:e.clientY}))}
              onMouseLeave={()=>{setHovered(null);setTip(t=>({...t,visible:false}));}}/>
          ))}
          {/* Centre label */}
          <text x={100} y={96} fill={T.muted} fontSize={9} textAnchor="middle">{valueKey||"Value"}</text>
          <text x={100} y={108} fill={T.text} fontSize={11} textAnchor="middle" fontWeight="bold">{total%1===0?total.toLocaleString():total.toFixed(1)}</text>
        </svg>
        {/* Legend */}
        <div style={{display:"flex",flexDirection:"column",gap:5}}>
          <div style={{fontSize:10,color:T.faint,marginBottom:4,letterSpacing:"0.06em"}}>LEGEND · {labelKey}</div>
          {slices.map((s,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",opacity:hovered===null||hovered===i?1:0.4,transition:"opacity 0.2s"}}
              onMouseEnter={()=>setHovered(i)} onMouseLeave={()=>setHovered(null)}>
              <div style={{width:10,height:10,borderRadius:2,background:s.color,flexShrink:0}}/>
              <div style={{fontSize:12,color:T.muted,maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{String(s.label).slice(0,22)}</div>
              <div style={{fontSize:11,color:T.faint,marginLeft:"auto",paddingLeft:8}}>{s.pct}%</div>
            </div>
          ))}
        </div>
        <ChartTooltip {...tip} theme={theme}/>
      </div>
    </div>
  );
}

// ─── UPGRADED: ScatterPlot with tooltips + axis labels + download ──────────────
function ScatterPlot({rows,xCol,yCol,colorCol,theme,title,subtitle}){
  const T=themes[theme];
  const [tip,setTip]=useState({visible:false,x:0,y:0});
  const ref=useRef();
  const xVals=rows.map(r=>Number(r[xCol])).filter(v=>!isNaN(v));
  const yVals=rows.map(r=>Number(r[yCol])).filter(v=>!isNaN(v));
  if(!xVals.length||!yVals.length)return<div style={{color:T.muted,padding:20}}>Not enough numeric data</div>;
  const xMin=Math.min(...xVals),xMax=Math.max(...xVals),yMin=Math.min(...yVals),yMax=Math.max(...yVals);
  const W=480,H=300,PL=56,PR=20,PT=20,PB=50;
  const toX=v=>PL+(v-xMin)/(xMax-xMin||1)*(W-PL-PR);
  const toY=v=>H-PB-(v-yMin)/(yMax-yMin||1)*(H-PT-PB);
  const cats=[...new Set(rows.map(r=>r[colorCol]).filter(Boolean))];
  return(
    <div>
      <ChartHeader title={title} subtitle={subtitle} chartRef={ref} filename={`${title||"scatter"}.png`} theme={theme}/>
      <div ref={ref} style={{overflowX:"auto",position:"relative"}}>
        <svg width={W} height={H} style={{background:T.inputBg,borderRadius:8,display:"block"}}>
          {/* Grid lines + Y labels */}
          {[0,0.25,0.5,0.75,1].map(t=>{
            const y=PT+(1-t)*(H-PT-PB);
            const val=(yMin+t*(yMax-yMin));
            return<g key={t}>
              <line x1={PL} y1={y} x2={W-PR} y2={y} stroke={T.border} strokeWidth={1} strokeDasharray="3,3"/>
              <text x={PL-6} y={y+4} fill={T.faint} fontSize={9} textAnchor="end">{val>=1000?`${(val/1000).toFixed(1)}k`:val.toFixed(val<10?1:0)}</text>
            </g>;
          })}
          {/* X labels */}
          {[0,0.25,0.5,0.75,1].map(t=>{
            const x=PL+t*(W-PL-PR);
            const val=(xMin+t*(xMax-xMin));
            return<g key={t}>
              <line x1={x} y1={PT} x2={x} y2={H-PB} stroke={T.border} strokeWidth={1} strokeDasharray="3,3"/>
              <text x={x} y={H-PB+14} fill={T.faint} fontSize={9} textAnchor="middle">{val>=1000?`${(val/1000).toFixed(1)}k`:val.toFixed(val<10?1:0)}</text>
            </g>;
          })}
          {/* Axis titles */}
          <text x={W/2} y={H-4} fill={T.muted} fontSize={11} textAnchor="middle" fontWeight="600">{xCol}</text>
          <text x={14} y={H/2} fill={T.muted} fontSize={11} textAnchor="middle" fontWeight="600" transform={`rotate(-90,14,${H/2})`}>{yCol}</text>
          {/* Dots */}
          {rows.slice(0,500).map((r,i)=>{
            const x=toX(Number(r[xCol])),y=toY(Number(r[yCol]));
            if(isNaN(x)||isNaN(y))return null;
            const ci=cats.indexOf(r[colorCol]);
            return<circle key={i} cx={x} cy={y} r={4} fill={COLORS[ci>=0?ci%COLORS.length:0]} opacity={0.75}
              style={{cursor:"crosshair"}}
              onMouseEnter={e=>setTip({visible:true,x:e.clientX,y:e.clientY,
                label:colorCol&&r[colorCol]?String(r[colorCol]):`Row ${i+1}`,
                value:`${xCol}: ${Number(r[xCol]).toFixed(2)}, ${yCol}: ${Number(r[yCol]).toFixed(2)}`,
                color:COLORS[ci>=0?ci%COLORS.length:0]})}
              onMouseMove={e=>setTip(t=>({...t,x:e.clientX,y:e.clientY}))}
              onMouseLeave={()=>setTip(t=>({...t,visible:false}))}/>;
          })}
          {/* Color legend */}
          {cats.length>0&&cats.slice(0,5).map((cat,i)=>(
            <g key={i} transform={`translate(${PL+i*90},${PT-5})`}>
              <rect width={8} height={8} fill={COLORS[i%COLORS.length]} rx={2}/>
              <text x={12} y={8} fill={T.faint} fontSize={9}>{String(cat).slice(0,10)}</text>
            </g>
          ))}
        </svg>
        <ChartTooltip {...tip} theme={theme}/>
      </div>
    </div>
  );
}

// ─── UPGRADED: LineChart with tooltips + axis labels + download ────────────────
function LineChart({rows,xCol,yCol,theme,title,subtitle}){
  const T=themes[theme];
  const [tip,setTip]=useState({visible:false,x:0,y:0});
  const ref=useRef();
  const pts=rows.slice(0,300).map(r=>({x:Number(r[xCol]),y:Number(r[yCol]),raw:r})).filter(p=>!isNaN(p.x)&&!isNaN(p.y));
  if(pts.length<2)return<div style={{color:T.muted,padding:20}}>Need at least 2 data points</div>;
  pts.sort((a,b)=>a.x-b.x);
  const xMin=pts[0].x,xMax=pts[pts.length-1].x,yMin=Math.min(...pts.map(p=>p.y)),yMax=Math.max(...pts.map(p=>p.y));
  const W=480,H=280,PL=56,PR=20,PT=20,PB=50;
  const toX=v=>PL+(v-xMin)/(xMax-xMin||1)*(W-PL-PR);
  const toY=v=>H-PB-(v-yMin)/(yMax-yMin||1)*(H-PT-PB);
  const pathD="M"+pts.map(p=>`${toX(p.x)},${toY(p.y)}`).join(" L");
  return(
    <div>
      <ChartHeader title={title} subtitle={subtitle} chartRef={ref} filename={`${title||"line"}.png`} theme={theme}/>
      <div ref={ref} style={{overflowX:"auto",position:"relative"}}>
        <svg width={W} height={H} style={{background:T.inputBg,borderRadius:8,display:"block"}}>
          <defs>
            <linearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.35"/>
              <stop offset="100%" stopColor="#6ee7b7" stopOpacity="0"/>
            </linearGradient>
          </defs>
          {/* Grid */}
          {[0,0.25,0.5,0.75,1].map(t=>{
            const y=PT+(1-t)*(H-PT-PB);
            const val=yMin+t*(yMax-yMin);
            return<g key={t}>
              <line x1={PL} y1={y} x2={W-PR} y2={y} stroke={T.border} strokeWidth={1} strokeDasharray="3,3"/>
              <text x={PL-6} y={y+4} fill={T.faint} fontSize={9} textAnchor="end">{val>=1000?`${(val/1000).toFixed(1)}k`:val.toFixed(val<10?1:0)}</text>
            </g>;
          })}
          {/* X labels */}
          {[0,0.33,0.66,1].map(t=>{
            const pt=pts[Math.round(t*(pts.length-1))];
            const x=toX(pt.x);
            return<g key={t}>
              <text x={x} y={H-PB+14} fill={T.faint} fontSize={9} textAnchor="middle">{pt.x>=1000?`${(pt.x/1000).toFixed(1)}k`:String(pt.x).slice(0,8)}</text>
            </g>;
          })}
          {/* Axis titles */}
          <text x={W/2} y={H-4} fill={T.muted} fontSize={11} textAnchor="middle" fontWeight="600">{xCol}</text>
          <text x={14} y={H/2} fill={T.muted} fontSize={11} textAnchor="middle" fontWeight="600" transform={`rotate(-90,14,${H/2})`}>{yCol}</text>
          {/* Area + line */}
          <path d={`${pathD} L${toX(pts[pts.length-1].x)},${H-PB} L${toX(pts[0].x)},${H-PB} Z`} fill="url(#lineGrad)"/>
          <path d={pathD} fill="none" stroke="#6ee7b7" strokeWidth={2.5}/>
          {/* Interactive points */}
          {pts.map((p,i)=>(
            <circle key={i} cx={toX(p.x)} cy={toY(p.y)} r={5} fill="#6ee7b7" opacity={0}
              style={{cursor:"crosshair"}}
              onMouseEnter={e=>setTip({visible:true,x:e.clientX,y:e.clientY,label:`${xCol}: ${p.x}`,value:`${yCol}: ${p.y.toFixed(2)}`,color:"#6ee7b7"})}
              onMouseMove={e=>setTip(t=>({...t,x:e.clientX,y:e.clientY}))}
              onMouseLeave={()=>setTip(t=>({...t,visible:false}))}/>
          ))}
        </svg>
        <ChartTooltip {...tip} theme={theme}/>
      </div>
    </div>
  );
}

// ─── UPGRADED: Heatmap with tooltips + download ────────────────────────────────
function Heatmap({rows,colTypes,theme,title,subtitle}){
  const T=themes[theme];
  const [tip,setTip]=useState({visible:false,x:0,y:0});
  const ref=useRef();
  const numCols=colTypes.filter(c=>c.type==="number").slice(0,8);
  if(numCols.length<2)return<div style={{color:T.muted,padding:20}}>Need at least 2 numeric columns</div>;
  const corr=numCols.map(a=>numCols.map(b=>{
    const av=rows.map(r=>Number(r[a.name])).filter(v=>!isNaN(v));
    const bv=rows.map(r=>Number(r[b.name])).filter(v=>!isNaN(v));
    const n=Math.min(av.length,bv.length);if(!n)return 0;
    const am=av.slice(0,n).reduce((s,v)=>s+v,0)/n,bm=bv.slice(0,n).reduce((s,v)=>s+v,0)/n;
    const num=av.slice(0,n).reduce((s,v,i)=>s+(v-am)*(bv[i]-bm),0);
    const da=Math.sqrt(av.slice(0,n).reduce((s,v)=>s+(v-am)**2,0));
    const db=Math.sqrt(bv.slice(0,n).reduce((s,v)=>s+(v-bm)**2,0));
    return da&&db?num/(da*db):0;
  }));
  const cell=56;
  return(
    <div>
      <ChartHeader title={title||"Correlation Matrix"} subtitle={subtitle||"Pearson r · Green=positive · Red=negative"} chartRef={ref} filename="heatmap.png" theme={theme}/>
      <div ref={ref} style={{overflowX:"auto",position:"relative"}}>
        <svg width={numCols.length*cell+140} height={numCols.length*cell+80}>
          {numCols.map((col,i)=><text key={i} x={140+i*cell+cell/2} y={22} fill={T.faint} fontSize={9} textAnchor="middle" transform={`rotate(-35,${140+i*cell+cell/2},22)`}>{col.name.slice(0,11)}</text>)}
          {corr.map((row,i)=>row.map((val,j)=>{
            const r=val>0?0:Math.round(-val*200),g=val>0?Math.round(val*180):0,b=val>0?Math.round(val*120):Math.round(-val*80);
            return<g key={`${i}-${j}`}
              style={{cursor:"crosshair"}}
              onMouseEnter={e=>setTip({visible:true,x:e.clientX,y:e.clientY,label:`${numCols[i].name} × ${numCols[j].name}`,value:`r = ${val.toFixed(3)}`,color:val>0?"#6ee7b7":"#fb923c"})}
              onMouseMove={e=>setTip(t=>({...t,x:e.clientX,y:e.clientY}))}
              onMouseLeave={()=>setTip(t=>({...t,visible:false}))}>
              <rect x={140+j*cell} y={35+i*cell} width={cell} height={cell} fill={`rgb(${r},${g},${b})`} opacity={0.85}/>
              <text x={140+j*cell+cell/2} y={35+i*cell+cell/2+5} fill="#fff" fontSize={9} textAnchor="middle">{val.toFixed(2)}</text>
            </g>;
          }))}
          {numCols.map((col,i)=><text key={i} x={135} y={35+i*cell+cell/2+4} fill={T.faint} fontSize={9} textAnchor="end">{col.name.slice(0,14)}</text>)}
        </svg>
        <ChartTooltip {...tip} theme={theme}/>
      </div>
    </div>
  );
}

// ─── Histogram (uses BarChart) ─────────────────────────────────────────────────
function Histogram({rows,col,theme,title,subtitle}){
  const vals=rows.map(r=>Number(r[col])).filter(v=>!isNaN(v));
  if(!vals.length)return null;
  const min=Math.min(...vals),max=Math.max(...vals),bins=12,step=(max-min)/bins||1;
  const buckets=Array.from({length:bins},(_,i)=>({label:(min+i*step).toFixed(1),count:0}));
  vals.forEach(v=>{const idx=Math.min(Math.floor((v-min)/step),bins-1);buckets[idx].count++;});
  return<BarChart data={buckets} labelKey="label" valueKey="count" color="#818cf8" theme={theme} title={title||col+" distribution"} subtitle={subtitle||`${vals.length} values, bin width ${step.toFixed(2)}`}/>;
}

// ─── Mini chart renderer for Dashboard ────────────────────────────────────────
function MiniChartRenderer({chart,allData,theme}){
  const T=themes[theme];
  const data=allData[chart.fileIdx]||allData[0];
  if(!data)return<div style={{color:T.muted,padding:16,fontSize:12}}>No data</div>;
  const{rows,colTypes}=data;
  if(chart.type==="bar"){const cnt={};rows.forEach(r=>{const v=r[chart.col]||"(empty)";cnt[v]=(cnt[v]||0)+1;});const d=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([label,count])=>({label,count}));return<BarChart data={d} labelKey="label" valueKey="count" color={chart.color||"#6ee7b7"} theme={theme}/>;}
  if(chart.type==="pie"){const cnt={};rows.forEach(r=>{const k=r[chart.labelCol];const v=Number(r[chart.valueCol])||0;cnt[k]=(cnt[k]||0)+v;});const d=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([label,value])=>({label,value}));return<PieChart data={d} labelKey="label" valueKey="value" theme={theme}/>;}
  if(chart.type==="scatter")return<ScatterPlot rows={rows} xCol={chart.xCol} yCol={chart.yCol} colorCol={chart.colorCol} theme={theme}/>;
  if(chart.type==="line")return<LineChart rows={rows} xCol={chart.xCol} yCol={chart.yCol} theme={theme}/>;
  if(chart.type==="histogram")return<Histogram rows={rows} col={chart.col} theme={theme}/>;
  if(chart.type==="heatmap")return<Heatmap rows={rows} colTypes={colTypes} theme={theme}/>;
  return null;
}

// ─── Main App ──────────────────────────────────────────────────────────────────
export default function App(){
  const[theme,setTheme]=useState("dark");
  const T=themes[theme];

  const[files,setFiles]=useState([]);
  const[activeFile,setActiveFile]=useState(0);
  const data=files[activeFile]||null;

  const[activeTab,setActiveTab]=useState("overview");
  const[dragOver,setDragOver]=useState(false);
  const fileRef=useRef();

  // SQL
  const[nlQuery,setNlQuery]=useState("");
  const[nlResult,setNlResult]=useState(null);
  const[genSQL,setGenSQL]=useState("");
  const[nlLoading,setNlLoading]=useState(false);
  const[sqlHistory,setSqlHistory]=useState([]);
  const[sqlChartType,setSqlChartType]=useState("bar");

  // Insights
  const[insights,setInsights]=useState({});
  const[insightsLoading,setInsightsLoading]=useState(false);

  // Charts
  const[chartMode,setChartMode]=useState("scatter");
  const[scatterX,setScatterX]=useState("");
  const[scatterY,setScatterY]=useState("");
  const[scatterC,setScatterC]=useState("");
  const[lineX,setLineX]=useState("");
  const[lineY,setLineY]=useState("");
  const[pieLabel,setPieLabel]=useState("");
  const[pieValue,setPieValue]=useState("");

  // AI Chart
  const[aiChartPrompt,setAiChartPrompt]=useState("");
  const[aiChartLoading,setAiChartLoading]=useState(false);
  const[aiChartConfig,setAiChartConfig]=useState(null);
  const[aiChartError,setAiChartError]=useState("");
  const[suggestions,setSuggestions]=useState([]);
  const[suggestionsLoading,setSuggestionsLoading]=useState(false);

  // Dashboard
  const[dashboardCharts,setDashboardCharts]=useState([]);
  const[dashboardName,setDashboardName]=useState("");

  // Clean
  const[cleanLog,setCleanLog]=useState([]);
  const[renameCol,setRenameCol]=useState("");
  const[renameTo,setRenameTo]=useState("");
  const[calcName,setCalcName]=useState("");
  const[calcFormula,setCalcFormula]=useState("");
  const[calcPreview,setCalcPreview]=useState(null);
  const[calcError,setCalcError]=useState("");

  // Filter
  const[searchQuery,setSearchQuery]=useState("");
  const[filterCol,setFilterCol]=useState("");
  const[filterOp,setFilterOp]=useState("contains");
  const[filterVal,setFilterVal]=useState("");

  // Chat
  const[chatMessages,setChatMessages]=useState([]);
  const[chatInput,setChatInput]=useState("");
  const[chatLoading,setChatLoading]=useState(false);
  const chatEndRef=useRef();

  // Compare
  const[compareA,setCompareA]=useState(0);
  const[compareB,setCompareB]=useState(1);
  const[compareResult,setCompareResult]=useState(null);
  const[compareLoading,setCompareLoading]=useState(false);

  // ── NEW state ──
  const[anomalies,setAnomalies]=useState({});          // per file
  const[correlations,setCorrelations]=useState({});    // per file
  const[corrNarrative,setCorrNarrative]=useState({});  // AI text per file
  const[corrLoading,setCorrLoading]=useState(false);
  const[goalInput,setGoalInput]=useState("");
  const[goalResult,setGoalResult]=useState(null);
  const[goalLoading,setGoalLoading]=useState(false);
  const[segResult,setSegResult]=useState(null);        // per file
  const[segLoading,setSegLoading]=useState(false);
  // Date intelligence
  const[dateCol,setDateCol]=useState("");
  const[dateGroupBy,setDateGroupBy]=useState("month");
  const[dateValueCol,setDateValueCol]=useState("");

  useEffect(()=>{chatEndRef.current?.scrollIntoView({behavior:"smooth"});},[chatMessages]);

  const loadFile=useCallback((text,name)=>{
    const parsed=parseCSV(text);
    const colTypes=inferTypes(parsed.headers,parsed.rows);
    const d={name,...parsed,colTypes,rawRows:[...parsed.rows]};
    setFiles(f=>{
      const existing=f.findIndex(x=>x.name===name);
      if(existing>=0){const nf=[...f];nf[existing]=d;return nf;}
      return[...f,d];
    });
    const nums=colTypes.filter(c=>c.type==="number");
    const cats=colTypes.filter(c=>c.type==="string");
    const dates=colTypes.filter(c=>c.type==="date");
    setScatterX(nums[0]?.name||"");setScatterY(nums[1]?.name||nums[0]?.name||"");setScatterC(cats[0]?.name||"");
    setLineX(nums[0]?.name||"");setLineY(nums[1]?.name||nums[0]?.name||"");
    setPieLabel(cats[0]?.name||"");setPieValue(nums[0]?.name||"");
    if(dates[0])setDateCol(dates[0].name);
    if(nums[0])setDateValueCol(nums[0].name);
    setNlResult(null);setGenSQL("");setSearchQuery("");setFilterVal("");
    setChatMessages(m=>[...m,{role:"assistant",text:`Loaded "${name}" — ${parsed.rows.length} rows, ${parsed.headers.length} columns. ${dates.length?" 📅 Date columns detected: "+dates.map(c=>c.name).join(", "):""}`.trim()}]);
    setActiveTab("overview");
    // Auto-run anomaly detection
    const det=detectAnomalies(parsed.rows,colTypes);
    setAnomalies(a=>({...a,[name]:det}));
    // Auto-compute correlations
    const corrs=computeTopCorrelations(parsed.rows,colTypes);
    setCorrelations(c=>({...c,[name]:corrs}));
  },[files.length]);

  const onFile=f=>{if(!f)return;const r=new FileReader();r.onload=e=>loadFile(e.target.result,f.name);r.readAsText(f);};

  const numCols=data?.colTypes.filter(c=>c.type==="number")||[];
  const catCols=data?.colTypes.filter(c=>c.type==="string")||[];
  const dateCols=data?.colTypes.filter(c=>c.type==="date")||[];

  const filteredRows=useCallback(()=>{
    if(!data)return[];
    let rows=[...data.rows];
    if(searchQuery.trim()){const q=searchQuery.toLowerCase();rows=rows.filter(r=>Object.values(r).some(v=>String(v).toLowerCase().includes(q)));}
    if(filterCol&&filterVal.trim()){rows=rows.filter(r=>{const rv=r[filterCol];const nv=Number(filterVal);if(filterOp==="contains")return String(rv).toLowerCase().includes(filterVal.toLowerCase());if(filterOp==="equals")return rv==filterVal;if(filterOp===">")return Number(rv)>nv;if(filterOp==="<")return Number(rv)<nv;if(filterOp===">=")return Number(rv)>=nv;if(filterOp==="<=")return Number(rv)<=nv;return true;});}
    return rows;
  },[data,searchQuery,filterCol,filterOp,filterVal]);

  // ── NL SQL ──
  const handleNLQuery=async()=>{
    if(!nlQuery.trim()||!data)return;
    setNlLoading(true);setNlResult(null);setGenSQL("");
    try{
      const colInfo=data.colTypes.map(c=>`${c.name}(${c.type})`).join(", ");
      const sample=data.rows.slice(0,3).map(r=>JSON.stringify(r)).join("\n");
      const sql=(await callAI([{role:"user",content:`Convert to SQL for table "data".\nColumns: ${colInfo}\nSample:\n${sample}\nQuestion: "${nlQuery}"\nReturn ONLY the SQL query, no markdown, no explanation.`}],"You are a precise SQL generator. Output only valid SQLite SQL.")).trim().replace(/```sql|```/g,"").trim();
      setGenSQL(sql);
      const result=executeSimpleSQL(sql,data.rows);
      setNlResult(result);
      setSqlHistory(h=>[{query:nlQuery,sql,rowCount:result.length},...h.slice(0,9)]);
    }catch(e){setGenSQL("Error: "+e.message);setNlResult([]);}
    setNlLoading(false);
  };

  // ── Insights ──
  const handleInsights=async()=>{
    if(!data)return;
    setInsightsLoading(true);
    try{
      const statsText=numCols.map(c=>{const s=computeStats(data.rows,c.name);return s?`${c.name}: mean=${s.mean},min=${s.min},max=${s.max},std=${s.std}`:""}).filter(Boolean).join("\n");
      const catText=catCols.map(c=>{const cnt={};data.rows.forEach(r=>{const v=r[c.name];cnt[v]=(cnt[v]||0)+1;});const top=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k}(${v})`).join(",");return`${c.name}: ${top}`;}).join("\n");
      const text=await callAI([{role:"user",content:`Analyze this dataset and return exactly 6 sharp business insights as JSON array. Each object must have: title(5 words max), insight(2 sentences with actual numbers), severity(positive|warning|neutral), recommendation(1 action sentence).\n\nFile: ${data.name}\nRows: ${data.rows.length}\nNumeric stats:\n${statsText}\nCategorical:\n${catText}\n\nReturn ONLY valid JSON array, no markdown.`}],"You are a senior data analyst. Respond with valid JSON only.");
      const parsed=JSON.parse(text.replace(/```json|```/g,"").trim());
      setInsights(ins=>({...ins,[activeFile]:parsed}));
    }catch(e){setInsights(ins=>({...ins,[activeFile]:[{title:"Error generating insights",insight:"Error: "+e.message,severity:"warning",recommendation:"Check your API connection."}]}));}
    setInsightsLoading(false);
  };

  // ── AI Chart ──
  const handleAIChart=async()=>{
    if(!aiChartPrompt.trim()||!data)return;
    setAiChartLoading(true);setAiChartConfig(null);setAiChartError("");
    try{
      const colInfo=data.colTypes.map(c=>`${c.name}(${c.type})`).join(", ");
      const text=await callAI([{role:"user",content:`The user wants to create a chart. Based on their description, return a JSON config.\n\nAvailable columns: ${colInfo}\n\nUser request: "${aiChartPrompt}"\n\nReturn a JSON object with these fields:\n- type: one of "bar","pie","scatter","line","histogram","heatmap"\n- title: chart title string\n- xCol: column name for x axis\n- yCol: column name for y axis\n- col: column for single-column charts\n- labelCol: label column for pie\n- valueCol: value column for pie\n- colorCol: optional color grouping\n- color: hex color like #6ee7b7\n\nReturn ONLY valid JSON, no markdown.`}],"You are a data visualization expert. Output only valid JSON.");
      const config=JSON.parse(text.replace(/```json|```/g,"").trim());
      setAiChartConfig(config);
    }catch(e){setAiChartError("Could not build chart: "+e.message);}
    setAiChartLoading(false);
  };

  // ── Suggestions ──
  const handleSuggestions=async()=>{
    if(!data)return;
    setSuggestionsLoading(true);setSuggestions([]);
    try{
      const colInfo=data.colTypes.map(c=>`${c.name}(${c.type})`).join(", ");
      const text=await callAI([{role:"user",content:`Given these columns: ${colInfo}\n\nSuggest 5 interesting visualizations to explore this dataset. Return a JSON array where each item has:\n- title: short suggestion title\n- description: one sentence why this is interesting\n- type: chart type (scatter/bar/pie/line/histogram/heatmap)\n- cols: array of column names to use\n\nReturn ONLY valid JSON array.`}],"You are a data visualization expert. Output only valid JSON.");
      setSuggestions(JSON.parse(text.replace(/```json|```/g,"").trim()));
    }catch(e){setSuggestions([{title:"Error",description:e.message,type:"bar",cols:[]}]);}
    setSuggestionsLoading(false);
  };

  // ── Compare ──
  const handleCompare=async()=>{
    if(files.length<2)return;
    setCompareLoading(true);setCompareResult(null);
    try{
      const fA=files[compareA];const fB=files[compareB];
      const statsA=fA.colTypes.filter(c=>c.type==="number").map(c=>{const s=computeStats(fA.rows,c.name);return s?`${c.name}: mean=${s.mean},std=${s.std}`:""}).filter(Boolean).join("; ");
      const statsB=fB.colTypes.filter(c=>c.type==="number").map(c=>{const s=computeStats(fB.rows,c.name);return s?`${c.name}: mean=${s.mean},std=${s.std}`:""}).filter(Boolean).join("; ");
      const text=await callAI([{role:"user",content:`Compare these two datasets and return a JSON object with:\n- summary: 2 sentence overall comparison\n- similarities: array of 3 similarity strings\n- differences: array of 3 difference strings\n- recommendation: 1 sentence actionable insight\n\nDataset A (${fA.name}): ${fA.rows.length} rows, columns: ${fA.headers.join(", ")}\nStats: ${statsA}\n\nDataset B (${fB.name}): ${fB.rows.length} rows, columns: ${fB.headers.join(", ")}\nStats: ${statsB}\n\nReturn ONLY valid JSON.`}],"You are a data analyst. Output only valid JSON.");
      setCompareResult(JSON.parse(text.replace(/```json|```/g,"").trim()));
    }catch(e){setCompareResult({summary:"Error: "+e.message,similarities:[],differences:[],recommendation:""});}
    setCompareLoading(false);
  };

  // ── Calculator ──
  const handleCalcPreview=()=>{
    if(!calcFormula.trim()||!data){setCalcPreview(null);return;}
    try{const preview=data.rows.slice(0,5).map(r=>({...r,[calcName||"new_col"]:evalFormula(calcFormula,r)}));setCalcPreview(preview);setCalcError("");}
    catch(e){setCalcError("Formula error: "+e.message);setCalcPreview(null);}
  };
  const handleCalcApply=()=>{
    if(!calcFormula.trim()||!calcName.trim()||!data)return;
    try{
      const newRows=data.rows.map(r=>({...r,[calcName]:evalFormula(calcFormula,r)}));
      const newColTypes=[...data.colTypes,{name:calcName,type:"number"}];
      setFiles(f=>{const nf=[...f];nf[activeFile]={...nf[activeFile],rows:newRows,headers:[...nf[activeFile].headers,calcName],colTypes:newColTypes};return nf;});
      setCleanLog(l=>[`✓ Added column "${calcName}" = ${calcFormula}`,...l]);
      setCalcName("");setCalcFormula("");setCalcPreview(null);
    }catch(e){setCalcError("Apply error: "+e.message);}
  };

  // ── Clean ──
  const removeDuplicates=()=>{const before=data.rows.length;const seen=new Set();const deduped=data.rows.filter(r=>{const k=JSON.stringify(r);if(seen.has(k))return false;seen.add(k);return true;});setFiles(f=>{const nf=[...f];nf[activeFile]={...nf[activeFile],rows:deduped};return nf;});setCleanLog(l=>[`✓ Removed ${before-deduped.length} duplicates (${before}→${deduped.length})`,...l]);};
  const fillNulls=()=>{const newRows=data.rows.map(r=>{const nr={...r};data.colTypes.forEach(c=>{if(nr[c.name]===""||nr[c.name]==null){if(c.type==="number"){const vals=data.rows.map(x=>Number(x[c.name])).filter(v=>!isNaN(v));nr[c.name]=vals.length?(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(2):"0";}else{const cnt={};data.rows.forEach(x=>{const v=x[c.name];if(v)cnt[v]=(cnt[v]||0)+1;});nr[c.name]=Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0]?.[0]||"";}}});return nr;});setFiles(f=>{const nf=[...f];nf[activeFile]={...nf[activeFile],rows:newRows};return nf;});setCleanLog(l=>[`✓ Filled missing values`,...l]);};
  const trimStrings=()=>{setFiles(f=>{const nf=[...f];nf[activeFile]={...nf[activeFile],rows:nf[activeFile].rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==="string"?v.trim():v])))};return nf;});setCleanLog(l=>[`✓ Trimmed whitespace`,...l]);};
  const doRename=()=>{if(!renameCol||!renameTo||renameCol===renameTo)return;setFiles(f=>{const nf=[...f];const d=nf[activeFile];nf[activeFile]={...d,headers:d.headers.map(h=>h===renameCol?renameTo:h),rows:d.rows.map(r=>{const nr={...r};nr[renameTo]=nr[renameCol];delete nr[renameCol];return nr;}),colTypes:d.colTypes.map(c=>c.name===renameCol?{...c,name:renameTo}:c)};return nf;});setCleanLog(l=>[`✓ Renamed "${renameCol}"→"${renameTo}"`,...l]);setRenameCol("");setRenameTo("");};
  const resetData=()=>{setFiles(f=>{const nf=[...f];nf[activeFile]={...nf[activeFile],rows:[...nf[activeFile].rawRows]};return nf;});setCleanLog(l=>[`↺ Reset to original`,...l]);};

  // ── Chat ──
  const handleChat=async()=>{
    if(!chatInput.trim())return;
    const userMsg=chatInput.trim();setChatInput("");
    setChatMessages(m=>[...m,{role:"user",text:userMsg}]);
    setChatLoading(true);
    try{
      const ctx=data?`Analyzing "${data.name}" (${data.rows.length} rows, cols: ${data.headers.join(", ")}). Stats: ${numCols.slice(0,5).map(c=>{const s=computeStats(data.rows,c.name);return s?`${c.name}:mean=${s.mean}`:""}).filter(Boolean).join("; ")}. Sample: ${JSON.stringify(data.rows[0]||{})}. `:"No data loaded. ";
      const reply=await callAI([{role:"user",content:ctx+"User question: "+userMsg}],"You are a helpful data analyst. Answer concisely with actual numbers when possible.");
      setChatMessages(m=>[...m,{role:"assistant",text:reply||"I couldn't generate a response."}]);
    }catch(e){setChatMessages(m=>[...m,{role:"assistant",text:"⚠️ "+e.message}]);}
    setChatLoading(false);
  };

  // ── Export ──
  const exportCSV=(rows=data?.rows)=>{if(!rows)return;const blob=new Blob([rowsToCSV(rows)],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`export_${data?.name||"data.csv"}`;a.click();};
  const copyReport=()=>{
    if(!data)return;
    const ins=insights[activeFile]||[];
    const statsText=numCols.map(c=>{const s=computeStats(data.rows,c.name);return s?`• ${c.name}: mean=${s.mean}, min=${s.min}, max=${s.max}, std=${s.std}`:""}).filter(Boolean).join("\n");
    const insText=ins.map(i=>`• ${i.title}: ${i.insight}`).join("\n");
    const report=`DATA REPORT: ${data.name}\nGenerated: ${new Date().toLocaleDateString()}\nRows: ${data.rows.length} | Columns: ${data.headers.length}\n\nCOLUMN STATS:\n${statsText}\n\nAI INSIGHTS:\n${insText}\n\nCOLUMNS: ${data.headers.join(", ")}`;
    navigator.clipboard.writeText(report).then(()=>alert("Report copied to clipboard!"));
  };
  const exportPDF=()=>{
    if(!data)return;
    const win=window.open("","_blank");
    const ins=insights[activeFile]||[];
    const insHTML=ins.map(i=>`<div class="ins ${i.severity}"><strong>${i.title}</strong><p>${i.insight}</p>${i.recommendation?`<em>${i.recommendation}</em>`:""}</div>`).join("");
    const statsHTML=numCols.slice(0,10).map(c=>{const s=computeStats(data.rows,c.name);return s?`<tr><td>${c.name}</td><td>${s.mean}</td><td>${s.min}</td><td>${s.max}</td><td>${s.std}</td><td>${s.count}</td></tr>`:""}).join("");
    win.document.write(`<html><head><title>Report: ${data.name}</title><style>body{font-family:Georgia,serif;max-width:820px;margin:40px auto;color:#1e293b;line-height:1.7}h1{font-size:26px;border-bottom:3px solid #6ee7b7;padding-bottom:10px}h2{font-size:17px;color:#334155;margin-top:28px}table{width:100%;border-collapse:collapse;font-size:13px;margin:12px 0}th{background:#f1f5f9;padding:8px 12px;text-align:left;font-weight:600}td{padding:8px 12px;border-bottom:1px solid #e2e8f0}.metric{display:inline-block;margin:6px;padding:12px 18px;background:#f8fafc;border-radius:8px;text-align:center}.mv{font-size:26px;font-weight:700}.ml{font-size:10px;color:#94a3b8}.ins{padding:12px;margin:8px 0;border-radius:8px;border-left:4px solid #94a3b8}.positive{border-color:#22c55e;background:#f0fdf4}.warning{border-color:#f97316;background:#fff7ed}.neutral{background:#f8fafc}em{font-size:12px;color:#64748b}</style></head><body><h1>📊 ${data.name}</h1><p style="color:#64748b">${new Date().toLocaleDateString()} · ${data.rows.length} rows · ${data.headers.length} columns</p><div><div class="metric"><div class="mv">${data.rows.length.toLocaleString()}</div><div class="ml">ROWS</div></div><div class="metric"><div class="mv">${data.headers.length}</div><div class="ml">COLUMNS</div></div><div class="metric"><div class="mv">${numCols.length}</div><div class="ml">NUMERIC</div></div><div class="metric"><div class="mv">${catCols.length}</div><div class="ml">TEXT</div></div></div>${statsHTML?`<h2>Column Statistics</h2><table><thead><tr><th>Column</th><th>Mean</th><th>Min</th><th>Max</th><th>Std Dev</th><th>Count</th></tr></thead><tbody>${statsHTML}</tbody></table>`:""}${ins.length?`<h2>AI Insights</h2>${insHTML}`:""}<h2>Data Preview</h2><table><thead><tr>${data.headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${data.rows.slice(0,25).map(r=>`<tr>${data.headers.map(h=>`<td>${r[h]??""}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`);
    win.document.close();setTimeout(()=>win.print(),500);
  };

  const addToDashboard=(chartConfig)=>{setDashboardCharts(d=>[...d,{id:Date.now(),...chartConfig,fileIdx:activeFile,fileName:data?.name}]);};
  const sevStyle=s=>({positive:{border:`1px solid #34d399`,bg:"rgba(52,211,153,0.08)",dot:"#34d399"},warning:{border:`1px solid #fb923c`,bg:"rgba(251,146,60,0.08)",dot:"#fb923c"},neutral:{border:`1px solid ${T.faint}`,bg:"transparent",dot:T.faint}}[s]||{border:`1px solid ${T.faint}`,bg:"transparent",dot:T.faint});

  // ── NEW: Smart Correlation Narrative ──
  const handleCorrNarrative=async()=>{
    if(!data)return;
    setCorrLoading(true);
    try{
      const corrs=correlations[data.name]||[];
      if(!corrs.length){setCorrNarrative(n=>({...n,[data.name]:"Not enough numeric columns for correlation analysis."}));setCorrLoading(false);return;}
      const corrText=corrs.map(c=>`${c.a} ↔ ${c.b}: r=${c.r}`).join("\n");
      const statsText=numCols.slice(0,6).map(c=>{const s=computeStats(data.rows,c.name);return s?`${c.name}: mean=${s.mean},std=${s.std}`:""}).filter(Boolean).join("\n");
      const narrative=await callAI([{role:"user",content:`Given these top correlations for dataset "${data.name}" (${data.rows.length} rows):\n\n${corrText}\n\nColumn stats:\n${statsText}\n\nWrite 3 plain-English insights explaining these relationships. For each, say WHY the correlation likely exists, what it means for business decisions, and how strong it is (weak <0.3, moderate 0.3-0.6, strong >0.6). Be specific and actionable. Format as numbered list.`}],"You are a senior data scientist. Write clear, actionable correlation insights for business users.");
      setCorrNarrative(n=>({...n,[data.name]:narrative}));
    }catch(e){setCorrNarrative(n=>({...n,[data.name]:"Error: "+e.message}));}
    setCorrLoading(false);
  };

  // ── NEW: Goal-Based Analysis ──
  const handleGoalAnalysis=async()=>{
    if(!goalInput.trim()||!data)return;
    setGoalLoading(true);setGoalResult(null);
    try{
      const statsText=numCols.map(c=>{const s=computeStats(data.rows,c.name);return s?`${c.name}: mean=${s.mean},min=${s.min},max=${s.max},std=${s.std}`:""}).filter(Boolean).join("\n");
      const catText=catCols.map(c=>{const cnt={};data.rows.forEach(r=>{const v=r[c.name];cnt[v]=(cnt[v]||0)+1;});const top=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${k}(${v})`).join(",");return`${c.name}: ${top}`;}).join("\n");
      const corrs=(correlations[data.name]||[]).map(c=>`${c.a}↔${c.b} r=${c.r}`).join(", ");
      const text=await callAI([{role:"user",content:`The user has a business goal: "${goalInput}"\n\nDataset: "${data.name}" — ${data.rows.length} rows\nColumns: ${data.headers.join(", ")}\nNumeric stats:\n${statsText}\nCategorical:\n${catText}\nTop correlations: ${corrs}\n\nReturn a JSON object with:\n- relevantColumns: array of {column, reason} - which columns are relevant to this goal\n- keyFindings: array of {finding, evidence, impact} - 3 specific findings from the data\n- actionPlan: array of 3 concrete action steps based on the data\n- riskFactors: array of 2 data-based risks to watch\n- targetMetric: which column best measures progress toward this goal\n\nReturn ONLY valid JSON.`}],"You are a strategic business analyst. Output only valid JSON. Be specific about actual data values.");
      setGoalResult(JSON.parse(text.replace(/```json|```/g,"").trim()));
    }catch(e){setGoalResult({error:e.message});}
    setGoalLoading(false);
  };

  // ── NEW: AI Customer Segmentation ──
  const handleSegmentation=async()=>{
    if(!data||numCols.length<2)return;
    setSegLoading(true);setSegResult(null);
    try{
      const statsText=numCols.slice(0,6).map(c=>{const s=computeStats(data.rows,c.name);return s?`${c.name}: mean=${s.mean},min=${s.min},max=${s.max},std=${s.std}`:""}).filter(Boolean).join("\n");
      const sample=data.rows.slice(0,10).map(r=>JSON.stringify(r)).join("\n");
      const text=await callAI([{role:"user",content:`Segment the rows in this dataset into 3-4 meaningful customer/entity segments based on all numeric columns.\n\nDataset: "${data.name}" — ${data.rows.length} rows\nNumeric columns: ${numCols.map(c=>c.name).join(", ")}\nStats:\n${statsText}\nSample rows:\n${sample}\n\nReturn a JSON object with:\n- segments: array of {name, description, size_pct, criteria, color, actionable_insight} — name should be descriptive like "High-value loyalists" or "At-risk occasionals"\n- segmentColumn: suggest a column name for the segment label\n- methodology: 1 sentence explaining how segments were defined\n- topRecommendation: 1 overall strategic recommendation\n\nReturn ONLY valid JSON.`}],"You are a marketing analytics expert. Create actionable, named customer segments. Output only valid JSON.");
      const parsed=JSON.parse(text.replace(/```json|```/g,"").trim());
      setSegResult(parsed);
    }catch(e){setSegResult({error:e.message});}
    setSegLoading(false);
  };

  // ── NEW: Date Time grouping helper ──
  function buildTimeSeries(rows,dateColName,valueColName,groupBy){
    const groups={};
    rows.forEach(r=>{
      const d=parseFlexDate(r[dateColName]);
      if(!d)return;
      const val=Number(r[valueColName]);
      if(isNaN(val))return;
      let key;
      if(groupBy==="year")key=d.getFullYear().toString();
      else if(groupBy==="quarter")key=`${d.getFullYear()}-Q${Math.ceil((d.getMonth()+1)/3)}`;
      else if(groupBy==="month")key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
      else if(groupBy==="week")key=`${d.getFullYear()}-W${String(Math.ceil((d.getDate())/7)).padStart(2,"0")}`;
      else key=r[dateColName];
      if(!groups[key])groups[key]={sum:0,count:0};
      groups[key].sum+=val;groups[key].count++;
    });
    return Object.entries(groups).sort(([a],[b])=>a.localeCompare(b)).map(([label,{sum,count}])=>({label,sum:parseFloat(sum.toFixed(2)),avg:parseFloat((sum/count).toFixed(2)),count}));
  }

  const TABS=["overview","anomalies","charts","ai-charts","sql","insights","correlations","segments","goal","datetime","clean","compare","chat","dashboard","export"];
  const frows=filteredRows();
  const fileAnomalies=data?anomalies[data.name]||[]:[];
  const fileCorrs=data?correlations[data.name]||[]:[];

  return(
    <div style={{minHeight:"100vh",background:T.bg,color:T.text,fontFamily:"'DM Mono','Fira Code',monospace",transition:"background 0.3s,color 0.3s"}}>
      {/* ── HEADER ── */}
      <div style={{borderBottom:`1px solid ${T.border}`,padding:"14px 28px",display:"flex",alignItems:"center",gap:14,background:T.surface,backdropFilter:"blur(8px)",position:"sticky",top:0,zIndex:50}}>
        <div style={{width:30,height:30,background:"linear-gradient(135deg,#6ee7b7,#818cf8)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15}}>◈</div>
        <div><div style={{fontWeight:700,fontSize:14,letterSpacing:"0.05em"}}>DATA STUDIO</div>
          <div style={{fontSize:9,color:T.faint,letterSpacing:"0.08em"}}>POWERED BY GROQ AI · PNG EXPORT · ANOMALY AI · DATE INTEL · GOAL ANALYSIS · SEGMENTS · CORRELATIONS</div>
        </div>
        {files.length>0&&(
          <div style={{display:"flex",gap:4,marginLeft:8,overflowX:"auto"}}>
            {files.map((f,i)=>(
              <button key={i} onClick={()=>setActiveFile(i)} style={{padding:"4px 12px",borderRadius:6,border:`1px solid ${i===activeFile?"#6ee7b7":T.border}`,background:i===activeFile?"rgba(110,231,183,0.1)":"transparent",color:i===activeFile?"#6ee7b7":T.muted,fontSize:10,fontFamily:"inherit",cursor:"pointer",whiteSpace:"nowrap"}}>
                {f.name.slice(0,20)}{files.length>1&&<span onClick={e=>{e.stopPropagation();setFiles(fs=>fs.filter((_,fi)=>fi!==i));setActiveFile(0);}} style={{marginLeft:6,opacity:0.5}}>✕</span>}
              </button>
            ))}
            <button onClick={()=>fileRef.current.click()} style={{padding:"4px 10px",borderRadius:6,border:`1px dashed ${T.border}`,background:"transparent",color:T.faint,fontSize:10,fontFamily:"inherit",cursor:"pointer"}}>+ Add CSV</button>
          </div>
        )}
        <div style={{marginLeft:"auto",display:"flex",gap:10,alignItems:"center"}}>
          {data&&<div style={{fontSize:11,color:T.faint,background:T.bg,border:`1px solid ${T.border}`,borderRadius:6,padding:"4px 10px"}}>◎ {data.rows.length.toLocaleString()} rows</div>}
          {data&&fileAnomalies.filter(a=>a.severity==="warning").length>0&&(
            <div onClick={()=>setActiveTab("anomalies")} style={{fontSize:11,color:"#fb923c",background:"rgba(251,146,60,0.1)",border:"1px solid #fb923c",borderRadius:6,padding:"4px 10px",cursor:"pointer"}}>
              ⚠ {fileAnomalies.filter(a=>a.severity==="warning").length} anomalies
            </div>
          )}
          <button onClick={()=>setTheme(t=>t==="dark"?"light":"dark")} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${T.border}`,background:T.bg,color:T.muted,cursor:"pointer",fontFamily:"inherit",fontSize:12}}>
            {theme==="dark"?"☀ Light":"☾ Dark"}
          </button>
        </div>
      </div>

      <div style={{maxWidth:1200,margin:"0 auto",padding:"22px 18px"}}>
        {!files.length?(
          <div onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={e=>{e.preventDefault();setDragOver(false);[...e.dataTransfer.files].forEach(onFile);}} onClick={()=>fileRef.current.click()} style={{border:`2px dashed ${dragOver?"#6ee7b7":T.border}`,borderRadius:16,padding:"80px 40px",textAlign:"center",cursor:"pointer",background:dragOver?"rgba(110,231,183,0.04)":T.surface,transition:"all 0.2s"}}>
            <input ref={fileRef} type="file" accept=".csv" multiple style={{display:"none"}} onChange={e=>[...e.target.files].forEach(onFile)}/>
            <div style={{fontSize:44,marginBottom:16,opacity:0.35}}>⬡</div>
            <div style={{fontSize:20,fontWeight:600,color:T.muted,marginBottom:8}}>Drop CSV files here</div>
            <div style={{fontSize:12,color:T.faint,marginBottom:6}}>supports multiple files · drag & drop or click to browse</div>
            <div style={{fontSize:11,color:T.faint,opacity:0.7}}>On upload: anomaly detection runs automatically · date columns detected · correlations computed</div>
          </div>
        ):(
          <>
            <input ref={fileRef} type="file" accept=".csv" multiple style={{display:"none"}} onChange={e=>[...e.target.files].forEach(onFile)}/>
            {/* ── TABS ── */}
            <div style={{display:"flex",gap:2,marginBottom:20,background:T.surface,borderRadius:10,padding:4,border:`1px solid ${T.border}`,overflowX:"auto",width:"fit-content",maxWidth:"100%"}}>
              {TABS.map(t=>{
                const isNew=["anomalies","correlations","segments","goal","datetime"].includes(t);
                return<button key={t} onClick={()=>setActiveTab(t)} style={{padding:"7px 12px",borderRadius:7,border:"none",cursor:"pointer",fontSize:10,fontFamily:"inherit",letterSpacing:"0.06em",fontWeight:700,textTransform:"uppercase",background:activeTab===t?T.bg:"transparent",color:activeTab===t?"#6ee7b7":isNew?"#818cf8":T.faint,transition:"all 0.15s",whiteSpace:"nowrap",position:"relative"}}>
                  {t.replace("-"," ")}
                  {isNew&&<span style={{position:"absolute",top:-3,right:-3,width:5,height:5,borderRadius:"50%",background:"#818cf8"}}/>}
                </button>;
              })}
            </div>

            {/* ── OVERVIEW ── */}
            {activeTab==="overview"&&data&&(
              <div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:18}}>
                  {[["ROWS",data.rows.length.toLocaleString(),"#6ee7b7"],["COLUMNS",data.headers.length,"#818cf8"],["NUMERIC",numCols.length,"#fb923c"],["TEXT",catCols.length,"#f472b6"],["DATES",dateCols.length,"#38bdf8"]].map(([l,v,c])=>(
                    <div key={l} style={{...mkCard(T),padding:"16px 18px"}}><div style={{...mkLbl(T),marginBottom:5}}>{l}</div><div style={{fontSize:22,fontWeight:700,color:c}}>{v}</div></div>
                  ))}
                </div>
                {dateCols.length>0&&(
                  <div style={{...mkCard(T),padding:"12px 16px",marginBottom:14,borderColor:"#38bdf8",background:"rgba(56,189,248,0.05)"}}>
                    <div style={{fontSize:11,color:"#38bdf8",fontWeight:700,marginBottom:4}}>📅 DATE COLUMNS DETECTED · CLICK "DATETIME" TAB FOR TIME SERIES</div>
                    <div style={{fontSize:11,color:T.muted}}>{dateCols.map(c=>c.name).join(" · ")}</div>
                  </div>
                )}
                {fileAnomalies.length>0&&(
                  <div onClick={()=>setActiveTab("anomalies")} style={{...mkCard(T),padding:"12px 16px",marginBottom:14,borderColor:"#fb923c",background:"rgba(251,146,60,0.05)",cursor:"pointer"}}>
                    <div style={{fontSize:11,color:"#fb923c",fontWeight:700,marginBottom:6}}>⚠ {fileAnomalies.length} DATA QUALITY ISSUES DETECTED ON UPLOAD · CLICK TO REVIEW</div>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                      {fileAnomalies.slice(0,3).map((a,i)=><div key={i} style={{fontSize:10,color:T.muted,background:T.bg,borderRadius:4,padding:"3px 8px"}}>{a.message.slice(0,50)}…</div>)}
                    </div>
                  </div>
                )}
                <div style={{...mkCard(T),padding:16,marginBottom:14}}>
                  <div style={{...mkLbl(T),marginBottom:10}}>SEARCH & FILTER</div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="🔍 Search all columns..." style={{...mkInput(T),flex:"1 1 200px"}}/>
                    <select value={filterCol} onChange={e=>setFilterCol(e.target.value)} style={mkSel(T)}><option value="">Filter column</option>{data.headers.map(h=><option key={h}>{h}</option>)}</select>
                    <select value={filterOp} onChange={e=>setFilterOp(e.target.value)} style={mkSel(T)}><option value="contains">contains</option><option value="equals">equals</option><option value=">">greater than</option><option value="<">less than</option><option value=">=">≥</option><option value="<=">≤</option></select>
                    <input value={filterVal} onChange={e=>setFilterVal(e.target.value)} placeholder="value..." style={{...mkInput(T),flex:"0 1 140px"}}/>
                    <button onClick={()=>{setSearchQuery("");setFilterVal("");setFilterCol("");}} style={{...mkBtn(true,T),padding:"9px 14px",fontSize:10}}>Clear</button>
                  </div>
                  {(searchQuery||filterVal)&&<div style={{marginTop:8,fontSize:11,color:"#6ee7b7"}}>Showing {frows.length} of {data.rows.length} rows</div>}
                </div>
                <div style={{...mkCard(T),overflow:"hidden",marginBottom:14}}>
                  <div style={{padding:"12px 18px",borderBottom:`1px solid ${T.border}`,...mkLbl(T)}}>COLUMN STATISTICS</div>
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                      <thead><tr style={{background:T.bg}}>{["Column","Type","Mean","Min","Max","Std Dev","Median","Outliers","Count"].map(h=><th key={h} style={{padding:"9px 14px",textAlign:"left",color:T.faint,fontWeight:500,fontSize:10,letterSpacing:"0.08em",borderBottom:`1px solid ${T.border}`}}>{h}</th>)}</tr></thead>
                      <tbody>{data.colTypes.map(col=>{const s=col.type==="number"?computeStats(data.rows,col.name):null;return(
                        <tr key={col.name} style={{borderBottom:`1px solid ${T.vfaint}`}}>
                          <td style={{padding:"9px 14px",color:T.text,fontWeight:600}}>{col.name}</td>
                          <td style={{padding:"9px 14px"}}><span style={{fontSize:10,padding:"2px 7px",borderRadius:4,background:col.type==="number"?"rgba(110,231,183,0.1)":col.type==="date"?"rgba(56,189,248,0.1)":"rgba(129,140,248,0.1)",color:col.type==="number"?"#6ee7b7":col.type==="date"?"#38bdf8":"#818cf8"}}>{col.type}</span></td>
                          {s?<><td style={{padding:"9px 14px",color:T.muted}}>{s.mean}</td><td style={{padding:"9px 14px",color:T.muted}}>{s.min}</td><td style={{padding:"9px 14px",color:T.muted}}>{s.max}</td><td style={{padding:"9px 14px",color:T.muted}}>{s.std}</td><td style={{padding:"9px 14px",color:T.muted}}>{s.median}</td><td style={{padding:"9px 14px",color:s.outlierCount>0?"#fb923c":T.muted}}>{s.outlierCount>0?`${s.outlierCount} (${s.outlierPct}%)`:"-"}</td><td style={{padding:"9px 14px",color:T.muted}}>{s.count}</td></>
                          :[...Array(7)].map((_,i)=><td key={i} style={{padding:"9px 14px",color:T.vfaint}}>—</td>)}
                        </tr>
                      );})}</tbody>
                    </table>
                  </div>
                </div>
                <div style={{...mkCard(T),overflow:"hidden"}}>
                  <div style={{padding:"12px 18px",borderBottom:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={mkLbl(T)}>DATA TABLE · {frows.length} rows shown</div>
                    <button onClick={()=>exportCSV(frows)} style={{...mkBtn(true,T),padding:"6px 12px",fontSize:10}}>⬇ Export filtered</button>
                  </div>
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                      <thead><tr style={{background:T.bg}}>{data.headers.map(h=><th key={h} style={{padding:"9px 14px",textAlign:"left",color:T.faint,fontWeight:500,fontSize:10,borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
                      <tbody>{frows.slice(0,50).map((row,i)=><tr key={i} style={{borderBottom:`1px solid ${T.vfaint}`}} onMouseEnter={e=>e.currentTarget.style.background=T.vfaint} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>{data.headers.map(h=><td key={h} style={{padding:"8px 14px",color:T.muted,whiteSpace:"nowrap",maxWidth:180,overflow:"hidden",textOverflow:"ellipsis"}}>{row[h]}</td>)}</tr>)}</tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* ── NEW: ANOMALIES TAB ── */}
            {activeTab==="anomalies"&&data&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:4}}>Automatic Data Quality Report</div>
                    <div style={{fontSize:12,color:T.faint}}>Scanned on upload · {fileAnomalies.length} issues found in {data.rows.length.toLocaleString()} rows</div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <div style={{padding:"6px 12px",borderRadius:6,background:"rgba(251,146,60,0.1)",border:"1px solid #fb923c",fontSize:11,color:"#fb923c"}}>{fileAnomalies.filter(a=>a.severity==="warning").length} warnings</div>
                    <div style={{padding:"6px 12px",borderRadius:6,background:T.surface,border:`1px solid ${T.border}`,fontSize:11,color:T.muted}}>{fileAnomalies.filter(a=>a.severity==="neutral").length} notices</div>
                  </div>
                </div>
                {fileAnomalies.length===0&&(
                  <div style={{...mkCard(T),padding:60,textAlign:"center"}}>
                    <div style={{fontSize:36,marginBottom:12}}>✅</div>
                    <div style={{fontSize:15,color:T.muted,marginBottom:6}}>No anomalies detected</div>
                    <div style={{fontSize:12,color:T.faint}}>Your data passed all quality checks</div>
                  </div>
                )}
                {fileAnomalies.map((a,i)=>{
                  const icons={missing:"◌",outlier:"◉",duplicate:"⊞",constant:"─"};
                  const s=sevStyle(a.severity);
                  return(
                    <div key={i} style={{background:s.bg,border:s.border,borderRadius:12,padding:20}}>
                      <div style={{display:"flex",alignItems:"flex-start",gap:14}}>
                        <div style={{fontSize:24,flexShrink:0,color:s.dot}}>{icons[a.type]||"◆"}</div>
                        <div style={{flex:1}}>
                          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                            <span style={{fontSize:10,padding:"2px 8px",borderRadius:4,background:a.severity==="warning"?"rgba(251,146,60,0.2)":"rgba(148,163,184,0.15)",color:a.severity==="warning"?"#fb923c":T.muted,fontWeight:700,textTransform:"uppercase"}}>{a.type}</span>
                            {a.col!=="all"&&<span style={{fontSize:11,color:"#818cf8"}}>column: {a.col}</span>}
                            <span style={{fontSize:11,color:T.faint,marginLeft:"auto"}}>{a.count} rows affected ({a.pct}%)</span>
                          </div>
                          <div style={{fontSize:13,color:T.text,marginBottom:6,fontWeight:600}}>{a.message}</div>
                          <div style={{fontSize:11,color:T.faint}}>→ {a.fix}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {/* Quality score */}
                {data&&(()=>{
                  const warnings=fileAnomalies.filter(a=>a.severity==="warning").length;
                  const score=Math.max(0,100-warnings*20-fileAnomalies.filter(a=>a.severity==="neutral").length*5);
                  const scoreColor=score>=80?"#34d399":score>=60?"#facc15":"#fb923c";
                  return(
                    <div style={{...mkCard(T),padding:20}}>
                      <div style={{...mkLbl(T),marginBottom:12}}>DATA QUALITY SCORE</div>
                      <div style={{display:"flex",alignItems:"center",gap:20}}>
                        <div style={{fontSize:48,fontWeight:700,color:scoreColor}}>{score}</div>
                        <div>
                          <div style={{fontSize:13,color:T.text,fontWeight:600}}>{score>=80?"Good quality data":score>=60?"Moderate quality — some issues found":"Poor quality — significant issues need attention"}</div>
                          <div style={{fontSize:11,color:T.faint,marginTop:4}}>Out of 100 · based on {fileAnomalies.length} detected issues</div>
                        </div>
                        <div style={{flex:1,background:T.vfaint,borderRadius:8,height:12,marginLeft:20}}>
                          <div style={{width:`${score}%`,background:`linear-gradient(90deg,${scoreColor},${scoreColor}aa)`,height:"100%",borderRadius:8,transition:"width 1s"}}/>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* ── CHARTS ── */}
            {activeTab==="charts"&&data&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {["scatter","line","bar","pie","heatmap","histogram"].map(m=>(
                    <button key={m} onClick={()=>setChartMode(m)} style={{...mkBtn(chartMode===m,T),padding:"8px 16px",fontSize:10,background:chartMode===m?"linear-gradient(135deg,#6ee7b7,#818cf8)":T.surface,border:chartMode===m?"none":`1px solid ${T.border}`,color:chartMode===m?"#080f1a":T.faint}}>{m.toUpperCase()}</button>
                  ))}
                  <div style={{fontSize:10,color:T.faint,alignSelf:"center",marginLeft:8}}>All charts: hover for tooltips · ⬇ PNG to download</div>
                </div>
                <div style={{...mkCard(T),padding:22}}>
                  {chartMode==="scatter"&&(<><div style={{display:"flex",gap:12,marginBottom:16,flexWrap:"wrap"}}>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>X AXIS</div><select value={scatterX} onChange={e=>setScatterX(e.target.value)} style={mkSel(T)}>{numCols.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>Y AXIS</div><select value={scatterY} onChange={e=>setScatterY(e.target.value)} style={mkSel(T)}>{numCols.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>COLOR BY</div><select value={scatterC} onChange={e=>setScatterC(e.target.value)} style={mkSel(T)}><option value="">None</option>{catCols.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <button onClick={()=>addToDashboard({type:"scatter",xCol:scatterX,yCol:scatterY,colorCol:scatterC,title:`${scatterY} vs ${scatterX}`})} style={{...mkBtn(true,T),padding:"8px 14px",fontSize:10,alignSelf:"flex-end"}}>📌 Pin</button>
                  </div>{scatterX&&scatterY&&<ScatterPlot rows={data.rows} xCol={scatterX} yCol={scatterY} colorCol={scatterC} theme={theme} title={`${scatterY} vs ${scatterX}`}/>}</>)}
                  {chartMode==="line"&&(<><div style={{display:"flex",gap:12,marginBottom:16,flexWrap:"wrap"}}>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>X AXIS</div><select value={lineX} onChange={e=>setLineX(e.target.value)} style={mkSel(T)}>{numCols.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>Y AXIS</div><select value={lineY} onChange={e=>setLineY(e.target.value)} style={mkSel(T)}>{numCols.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <button onClick={()=>addToDashboard({type:"line",xCol:lineX,yCol:lineY,title:`${lineY} over ${lineX}`})} style={{...mkBtn(true,T),padding:"8px 14px",fontSize:10,alignSelf:"flex-end"}}>📌 Pin</button>
                  </div>{lineX&&lineY&&<LineChart rows={data.rows} xCol={lineX} yCol={lineY} theme={theme} title={`${lineY} over ${lineX}`}/>}</>)}
                  {chartMode==="bar"&&(<><div style={{...mkLbl(T),marginBottom:14}}>CATEGORICAL DISTRIBUTIONS</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))",gap:18}}>
                      {catCols.slice(0,4).map((col,ci)=>{const cnt={};data.rows.forEach(r=>{const v=r[col.name]||"(empty)";cnt[v]=(cnt[v]||0)+1;});const sorted=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([label,count])=>({label,count}));
                        return<div key={col.name}><div style={{display:"flex",justifyContent:"flex-end",marginBottom:4}}><button onClick={()=>addToDashboard({type:"bar",col:col.name,title:`${col.name} distribution`,color:COLORS[ci%COLORS.length]})} style={{fontSize:10,background:"transparent",border:"none",color:T.faint,cursor:"pointer"}}>📌</button></div><BarChart data={sorted} labelKey="label" valueKey="count" color={COLORS[ci%COLORS.length]} theme={theme} title={col.name+" distribution"}/></div>;})}
                    </div></>)}
                  {chartMode==="pie"&&(<><div style={{display:"flex",gap:12,marginBottom:16,flexWrap:"wrap"}}>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>LABEL</div><select value={pieLabel} onChange={e=>setPieLabel(e.target.value)} style={mkSel(T)}>{data.colTypes.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>VALUE</div><select value={pieValue} onChange={e=>setPieValue(e.target.value)} style={mkSel(T)}>{numCols.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <button onClick={()=>addToDashboard({type:"pie",labelCol:pieLabel,valueCol:pieValue,title:`${pieValue} by ${pieLabel}`})} style={{...mkBtn(true,T),padding:"8px 14px",fontSize:10,alignSelf:"flex-end"}}>📌 Pin</button>
                  </div>{pieLabel&&pieValue&&(()=>{const cnt={};data.rows.forEach(r=>{const k=r[pieLabel];const v=Number(r[pieValue])||0;cnt[k]=(cnt[k]||0)+v;});const d2=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([label,value])=>({label,value}));return<PieChart data={d2} labelKey="label" valueKey="value" theme={theme} title={`${pieValue} by ${pieLabel}`}/>;})()}</>)}
                  {chartMode==="heatmap"&&<Heatmap rows={data.rows} colTypes={data.colTypes} theme={theme}/>}
                  {chartMode==="histogram"&&(<><div style={{...mkLbl(T),marginBottom:14}}>NUMERIC DISTRIBUTIONS</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))",gap:16}}>
                      {numCols.slice(0,6).map(col=><div key={col.name}><div style={{display:"flex",justifyContent:"flex-end",marginBottom:4}}><button onClick={()=>addToDashboard({type:"histogram",col:col.name,title:`${col.name} distribution`})} style={{fontSize:10,background:"transparent",border:"none",color:T.faint,cursor:"pointer"}}>📌</button></div><Histogram rows={data.rows} col={col.name} theme={theme}/></div>)}
                    </div></>)}
                </div>
              </div>
            )}

            {/* ── AI CHARTS ── */}
            {activeTab==="ai-charts"&&data&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{...mkCard(T),padding:22}}>
                  <div style={{...mkLbl(T),marginBottom:6}}>AI CHART BUILDER</div>
                  <div style={{fontSize:12,color:T.faint,marginBottom:14}}>Describe what you want to see — AI picks the best chart type and columns automatically</div>
                  <div style={{display:"flex",gap:10,marginBottom:14}}>
                    <input value={aiChartPrompt} onChange={e=>setAiChartPrompt(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleAIChart()} placeholder='e.g. "Show me sales by region" or "Compare age and income"' style={mkInput(T)}/>
                    <button onClick={handleAIChart} disabled={aiChartLoading} style={mkBtn(!aiChartLoading,T)}>{aiChartLoading?"BUILDING...":"BUILD CHART →"}</button>
                  </div>
                  {aiChartError&&<div style={{color:"#fb923c",fontSize:12,marginBottom:10}}>{aiChartError}</div>}
                  {aiChartConfig&&(
                    <div>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                        <div style={{fontSize:13,fontWeight:700,color:T.text}}>{aiChartConfig.title}</div>
                        <div style={{display:"flex",gap:8}}>
                          <span style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"rgba(110,231,183,0.1)",color:"#6ee7b7"}}>{aiChartConfig.type}</span>
                          <button onClick={()=>addToDashboard({...aiChartConfig})} style={{...mkBtn(true,T),padding:"6px 12px",fontSize:10}}>📌 Pin to Dashboard</button>
                        </div>
                      </div>
                      <MiniChartRenderer chart={{...aiChartConfig,fileIdx:activeFile}} allData={files} theme={theme}/>
                    </div>
                  )}
                </div>
                <div style={{...mkCard(T),padding:22}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                    <div><div style={{...mkLbl(T),marginBottom:4}}>AI CHART SUGGESTIONS</div><div style={{fontSize:12,color:T.faint}}>AI recommends the most interesting visualizations for your data</div></div>
                    <button onClick={handleSuggestions} disabled={suggestionsLoading} style={mkBtn(!suggestionsLoading,T)}>{suggestionsLoading?"ANALYZING...":"GET SUGGESTIONS →"}</button>
                  </div>
                  {suggestions.length>0&&(
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:10}}>
                      {suggestions.map((s,i)=>(
                        <div key={i} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span style={{fontSize:10,padding:"2px 7px",borderRadius:4,background:"rgba(129,140,248,0.1)",color:"#818cf8"}}>{s.type}</span><div style={{fontSize:12,fontWeight:700,color:T.text}}>{s.title}</div></div>
                          <div style={{fontSize:11,color:T.muted,marginBottom:10,lineHeight:1.5}}>{s.description}</div>
                          <div style={{fontSize:10,color:T.faint}}>Columns: {s.cols?.join(", ")}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── SQL ── */}
            {activeTab==="sql"&&data&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{...mkCard(T),padding:20}}>
                  <div style={{...mkLbl(T),marginBottom:10}}>NATURAL LANGUAGE → SQL</div>
                  <div style={{fontSize:11,color:T.faint,marginBottom:10}}>Table: <span style={{color:"#6ee7b7"}}>"data"</span> · {data.headers.slice(0,6).join(", ")}{data.headers.length>6?` +${data.headers.length-6} more`:""}</div>
                  <div style={{display:"flex",gap:10,marginBottom:10}}>
                    <input value={nlQuery} onChange={e=>setNlQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleNLQuery()} placeholder='"Top 5 by revenue" or "Average salary by department"' style={mkInput(T)}/>
                    <button onClick={handleNLQuery} disabled={nlLoading} style={mkBtn(!nlLoading,T)}>{nlLoading?"THINKING...":"RUN →"}</button>
                  </div>
                  {genSQL&&<div style={{background:T.bg,borderRadius:8,padding:12,border:`1px solid ${T.border}`}}><div style={{...mkLbl(T),marginBottom:5}}>GENERATED SQL</div><code style={{color:"#6ee7b7",fontSize:12,whiteSpace:"pre-wrap",wordBreak:"break-all"}}>{genSQL}</code></div>}
                </div>
                {nlResult&&(
                  <div style={{...mkCard(T),overflow:"hidden"}}>
                    <div style={{padding:"12px 18px",borderBottom:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div style={mkLbl(T)}>{nlResult.length} ROWS</div>
                      <div style={{display:"flex",gap:8}}>
                        <select value={sqlChartType} onChange={e=>setSqlChartType(e.target.value)} style={{...mkSel(T),fontSize:10}}><option value="bar">Bar</option><option value="pie">Pie</option><option value="none">Table only</option></select>
                        <button onClick={()=>exportCSV(nlResult)} style={{...mkBtn(true,T),padding:"6px 12px",fontSize:10}}>⬇ CSV</button>
                      </div>
                    </div>
                    {nlResult.length>0&&sqlChartType!=="none"&&Object.keys(nlResult[0]).length===2&&(()=>{const keys=Object.keys(nlResult[0]);const numKey=keys.find(k=>!isNaN(Number(nlResult[0][k])));const lblKey=keys.find(k=>k!==numKey);return numKey&&lblKey?<div style={{padding:"16px 18px",borderBottom:`1px solid ${T.border}`}}>{sqlChartType==="bar"?<BarChart data={nlResult} labelKey={lblKey} valueKey={numKey} theme={theme} title="Query Results"/>:<PieChart data={nlResult} labelKey={lblKey} valueKey={numKey} theme={theme} title="Query Results"/>}</div>:null;})()}
                    <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}><thead><tr style={{background:T.bg}}>{nlResult[0]&&Object.keys(nlResult[0]).map(h=><th key={h} style={{padding:"9px 14px",textAlign:"left",color:T.faint,fontWeight:500,fontSize:10,borderBottom:`1px solid ${T.border}`}}>{h}</th>)}</tr></thead><tbody>{nlResult.slice(0,50).map((row,i)=><tr key={i} style={{borderBottom:`1px solid ${T.vfaint}`}}>{Object.values(row).map((v,j)=><td key={j} style={{padding:"8px 14px",color:T.muted}}>{v}</td>)}</tr>)}</tbody></table></div>
                  </div>
                )}
                {sqlHistory.length>0&&<div style={{...mkCard(T),padding:16}}><div style={{...mkLbl(T),marginBottom:10}}>HISTORY</div><div style={{display:"flex",flexDirection:"column",gap:5}}>{sqlHistory.map((h,i)=><div key={i} onClick={()=>setNlQuery(h.query)} style={{padding:"9px 12px",background:T.bg,borderRadius:7,border:`1px solid ${T.border}`,cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.borderColor="#6ee7b7"} onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}><div style={{fontSize:12,color:T.muted}}>{h.query}</div><div style={{fontSize:10,color:T.faint}}>{h.rowCount} rows</div></div>)}</div></div>}
              </div>
            )}

            {/* ── INSIGHTS ── */}
            {activeTab==="insights"&&data&&(
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                  <div style={{fontSize:12,color:T.faint}}>AI-powered findings with recommendations</div>
                  <button onClick={handleInsights} disabled={insightsLoading} style={mkBtn(!insightsLoading,T)}>{insightsLoading?"ANALYZING...":(insights[activeFile]?.length?"REFRESH ↺":"GENERATE INSIGHTS →")}</button>
                </div>
                {insightsLoading&&<div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>{Array(6).fill(0).map((_,i)=><div key={i} style={{...mkCard(T),padding:20,animation:"pulse 1.5s ease-in-out infinite"}}><div style={{width:"60%",height:10,background:T.border,borderRadius:4,marginBottom:10}}/><div style={{width:"100%",height:8,background:T.border,borderRadius:4,marginBottom:8}}/><div style={{width:"80%",height:8,background:T.border,borderRadius:4}}/></div>)}</div>}
                {(insights[activeFile]||[]).length>0&&!insightsLoading&&<div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>{(insights[activeFile]||[]).map((ins,i)=>{const s=sevStyle(ins.severity);return(<div key={i} style={{background:s.bg,border:s.border,borderRadius:12,padding:20}}><div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><div style={{width:8,height:8,borderRadius:"50%",background:s.dot}}/><div style={{fontSize:11,fontWeight:700,color:T.text,letterSpacing:"0.08em",textTransform:"uppercase"}}>{ins.title}</div></div><div style={{fontSize:13,color:T.muted,lineHeight:1.6,marginBottom:ins.recommendation?8:0}}>{ins.insight}</div>{ins.recommendation&&<div style={{fontSize:11,color:"#6ee7b7",fontStyle:"italic"}}>→ {ins.recommendation}</div>}</div>);})}</div>}
                {!insights[activeFile]?.length&&!insightsLoading&&<div style={{textAlign:"center",padding:"60px",color:T.faint}}><div style={{fontSize:36,marginBottom:12,opacity:0.2}}>◈</div><div>Click Generate Insights to run AI analysis</div></div>}
              </div>
            )}

            {/* ── NEW: CORRELATIONS TAB ── */}
            {activeTab==="correlations"&&data&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:4}}>Smart Correlation Finder</div>
                <div style={{fontSize:12,color:T.faint,marginBottom:8}}>Top {fileCorrs.length} strongest statistical relationships in your data — computed automatically on upload</div>
                {numCols.length<2&&<div style={{...mkCard(T),padding:40,textAlign:"center",color:T.faint}}>Need at least 2 numeric columns for correlation analysis</div>}
                {fileCorrs.length>0&&(
                  <>
                    <div style={{display:"flex",flexDirection:"column",gap:10}}>
                      {fileCorrs.map((c,i)=>{
                        const strength=c.absR>0.7?"Strong":c.absR>0.4?"Moderate":"Weak";
                        const direction=c.r>0?"positive":"negative";
                        const color=c.r>0?"#6ee7b7":"#fb923c";
                        const pct=Math.round(c.absR*100);
                        return(
                          <div key={i} style={{...mkCard(T),padding:18}}>
                            <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:10}}>
                              <div style={{fontSize:22,fontWeight:700,color,flexShrink:0}}>{c.r>0?"↗":"↘"}</div>
                              <div style={{flex:1}}>
                                <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:3}}>
                                  <span style={{color:"#6ee7b7"}}>{c.a}</span> <span style={{color:T.faint}}>↔</span> <span style={{color:"#818cf8"}}>{c.b}</span>
                                </div>
                                <div style={{fontSize:11,color:T.muted}}>{strength} {direction} correlation · r = {c.r}</div>
                              </div>
                              <div style={{textAlign:"right"}}>
                                <div style={{fontSize:20,fontWeight:700,color}}>{pct}%</div>
                                <div style={{fontSize:10,color:T.faint}}>correlation</div>
                              </div>
                            </div>
                            <div style={{background:T.vfaint,borderRadius:4,height:8}}>
                              <div style={{width:`${pct}%`,background:color,height:"100%",borderRadius:4,transition:"width 1s"}}/>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{...mkCard(T),padding:20}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                        <div>
                          <div style={{...mkLbl(T),marginBottom:4}}>AI NARRATIVE · PLAIN ENGLISH EXPLANATIONS</div>
                          <div style={{fontSize:12,color:T.faint}}>AI explains what these correlations mean for your business</div>
                        </div>
                        <button onClick={handleCorrNarrative} disabled={corrLoading} style={mkBtn(!corrLoading,T)}>{corrLoading?"ANALYZING...":"EXPLAIN CORRELATIONS →"}</button>
                      </div>
                      {corrNarrative[data.name]&&(
                        <div style={{fontSize:13,color:T.muted,lineHeight:1.8,whiteSpace:"pre-wrap",background:T.bg,borderRadius:8,padding:16,border:`1px solid ${T.border}`}}>{corrNarrative[data.name]}</div>
                      )}
                    </div>
                    <div style={{...mkCard(T),padding:20}}>
                      <div style={{...mkLbl(T),marginBottom:12}}>FULL CORRELATION MATRIX</div>
                      <Heatmap rows={data.rows} colTypes={data.colTypes} theme={theme}/>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── NEW: SEGMENTS TAB ── */}
            {activeTab==="segments"&&data&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:4}}>AI Customer / Row Segmentation</div>
                    <div style={{fontSize:12,color:T.faint}}>AI groups rows into named segments based on {numCols.length} numeric columns · actionable for marketing & CRM</div>
                  </div>
                  <button onClick={handleSegmentation} disabled={segLoading||numCols.length<2} style={mkBtn(!segLoading&&numCols.length>=2,T)}>{segLoading?"SEGMENTING...":"RUN SEGMENTATION →"}</button>
                </div>
                {numCols.length<2&&<div style={{...mkCard(T),padding:30,textAlign:"center",color:T.faint}}>Need at least 2 numeric columns for segmentation</div>}
                {segLoading&&<div style={{...mkCard(T),padding:60,textAlign:"center"}}><div style={{fontSize:24,marginBottom:12,animation:"pulse 1.5s infinite"}}>◈</div><div style={{color:T.muted}}>AI is analyzing patterns across {data.rows.length.toLocaleString()} rows…</div></div>}
                {segResult?.error&&<div style={{...mkCard(T),padding:20,color:"#fb923c"}}>Error: {segResult.error}</div>}
                {segResult&&!segResult.error&&(
                  <>
                    <div style={{...mkCard(T),padding:16,borderColor:"#818cf8",background:"rgba(129,140,248,0.05)"}}>
                      <div style={{fontSize:11,color:"#818cf8",fontWeight:700,marginBottom:6}}>METHODOLOGY</div>
                      <div style={{fontSize:12,color:T.muted,marginBottom:8}}>{segResult.methodology}</div>
                      <div style={{fontSize:11,color:"#6ee7b7"}}>→ {segResult.topRecommendation}</div>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
                      {(segResult.segments||[]).map((seg,i)=>{
                        const segColors=["#6ee7b7","#818cf8","#fb923c","#f472b6","#38bdf8"];
                        const c=seg.color||segColors[i%segColors.length];
                        return(
                          <div key={i} style={{background:`${c}08`,border:`1px solid ${c}44`,borderRadius:12,padding:20}}>
                            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                              <div style={{width:12,height:12,borderRadius:"50%",background:c,flexShrink:0}}/>
                              <div style={{fontSize:13,fontWeight:700,color:T.text}}>{seg.name}</div>
                              <div style={{marginLeft:"auto",fontSize:11,color:c,fontWeight:700}}>{seg.size_pct}%</div>
                            </div>
                            <div style={{fontSize:12,color:T.muted,marginBottom:10,lineHeight:1.6}}>{seg.description}</div>
                            {seg.criteria&&<div style={{fontSize:10,color:T.faint,marginBottom:8,background:T.bg,borderRadius:6,padding:"6px 10px"}}><strong style={{color:c}}>Criteria:</strong> {seg.criteria}</div>}
                            {seg.actionable_insight&&<div style={{fontSize:11,color:c,fontStyle:"italic"}}>→ {seg.actionable_insight}</div>}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{...mkCard(T),padding:16}}>
                      <div style={{...mkLbl(T),marginBottom:8}}>SEGMENT COLUMN NAME</div>
                      <div style={{fontSize:12,color:T.muted}}>Add a <span style={{color:"#6ee7b7"}}>"{segResult.segmentColumn||"Segment"}"</span> column to your data using the Column Calculator in the Clean tab based on these criteria.</div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── NEW: GOAL-BASED ANALYSIS TAB ── */}
            {activeTab==="goal"&&data&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:4}}>Goal-Based Analysis</div>
                <div style={{fontSize:12,color:T.faint,marginBottom:4}}>Type a business goal — AI identifies what the data shows about how to achieve it</div>
                <div style={{...mkCard(T),padding:20}}>
                  <div style={{...mkLbl(T),marginBottom:10}}>WHAT IS YOUR BUSINESS GOAL?</div>
                  <div style={{display:"flex",gap:10,marginBottom:14}}>
                    <input value={goalInput} onChange={e=>setGoalInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleGoalAnalysis()} placeholder='e.g. "Reduce churn by 20%" or "Increase revenue by 30%" or "Improve customer satisfaction"' style={mkInput(T)}/>
                    <button onClick={handleGoalAnalysis} disabled={goalLoading} style={mkBtn(!goalLoading,T)}>{goalLoading?"ANALYZING...":"ANALYZE →"}</button>
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {["Reduce churn by 20%","Increase average order value","Improve customer retention","Optimize pricing strategy","Identify top revenue drivers"].map(g=>(
                      <button key={g} onClick={()=>setGoalInput(g)} style={{fontSize:10,padding:"5px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:6,color:T.faint,cursor:"pointer",fontFamily:"inherit"}}>{g}</button>
                    ))}
                  </div>
                </div>
                {goalLoading&&<div style={{...mkCard(T),padding:60,textAlign:"center"}}><div style={{fontSize:24,marginBottom:12,animation:"pulse 1.5s infinite"}}>◈</div><div style={{color:T.muted}}>AI is mapping your goal to the data…</div></div>}
                {goalResult?.error&&<div style={{...mkCard(T),padding:20,color:"#fb923c"}}>Error: {goalResult.error}</div>}
                {goalResult&&!goalResult.error&&(
                  <div style={{display:"flex",flexDirection:"column",gap:12}}>
                    {/* Target metric */}
                    {goalResult.targetMetric&&(
                      <div style={{...mkCard(T),padding:16,borderColor:"#6ee7b7",background:"rgba(110,231,183,0.05)"}}>
                        <div style={{fontSize:11,color:"#6ee7b7",fontWeight:700,marginBottom:4}}>TARGET METRIC TO TRACK</div>
                        <div style={{fontSize:16,fontWeight:700,color:T.text}}>{goalResult.targetMetric}</div>
                      </div>
                    )}
                    {/* Relevant columns */}
                    {goalResult.relevantColumns?.length>0&&(
                      <div style={{...mkCard(T),padding:18}}>
                        <div style={{...mkLbl(T),marginBottom:12}}>RELEVANT COLUMNS FOR THIS GOAL</div>
                        <div style={{display:"flex",flexDirection:"column",gap:8}}>
                          {goalResult.relevantColumns.map((col,i)=>(
                            <div key={i} style={{display:"flex",gap:12,padding:"10px 12px",background:T.bg,borderRadius:8,border:`1px solid ${T.border}`}}>
                              <span style={{color:"#818cf8",fontWeight:700,flexShrink:0}}>{col.column}</span>
                              <span style={{fontSize:12,color:T.muted}}>{col.reason}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Key findings */}
                    {goalResult.keyFindings?.length>0&&(
                      <div style={{...mkCard(T),padding:18}}>
                        <div style={{...mkLbl(T),marginBottom:12}}>KEY FINDINGS FROM THE DATA</div>
                        <div style={{display:"flex",flexDirection:"column",gap:10}}>
                          {goalResult.keyFindings.map((f,i)=>(
                            <div key={i} style={{padding:14,background:"rgba(110,231,183,0.05)",border:"1px solid rgba(110,231,183,0.3)",borderRadius:10}}>
                              <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:5}}>{f.finding}</div>
                              <div style={{fontSize:12,color:T.muted,marginBottom:4}}>{f.evidence}</div>
                              {f.impact&&<div style={{fontSize:11,color:"#6ee7b7"}}>Impact: {f.impact}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Action plan */}
                    {goalResult.actionPlan?.length>0&&(
                      <div style={{...mkCard(T),padding:18}}>
                        <div style={{...mkLbl(T),marginBottom:12}}>DATA-DRIVEN ACTION PLAN</div>
                        <div style={{display:"flex",flexDirection:"column",gap:8}}>
                          {goalResult.actionPlan.map((step,i)=>(
                            <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                              <div style={{width:24,height:24,borderRadius:"50%",background:"linear-gradient(135deg,#6ee7b7,#818cf8)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:"#080f1a",flexShrink:0}}>{i+1}</div>
                              <div style={{fontSize:12,color:T.muted,paddingTop:3,lineHeight:1.6}}>{step}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Risk factors */}
                    {goalResult.riskFactors?.length>0&&(
                      <div style={{...mkCard(T),padding:18,borderColor:"#fb923c",background:"rgba(251,146,60,0.04)"}}>
                        <div style={{...mkLbl(T),marginBottom:12,color:"#fb923c"}}>⚠ RISK FACTORS TO WATCH</div>
                        <div style={{display:"flex",flexDirection:"column",gap:8}}>
                          {goalResult.riskFactors.map((r,i)=>(
                            <div key={i} style={{fontSize:12,color:T.muted,paddingLeft:12,borderLeft:"2px solid #fb923c"}}>{r}</div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── NEW: DATE / TIME TAB ── */}
            {activeTab==="datetime"&&data&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:4}}>Date / Time Intelligence</div>
                <div style={{fontSize:12,color:T.faint,marginBottom:4}}>Auto-detected date columns: <span style={{color:"#38bdf8"}}>{dateCols.map(c=>c.name).join(", ")||"none"}</span></div>
                {dateCols.length===0&&(
                  <div style={{...mkCard(T),padding:40,textAlign:"center"}}>
                    <div style={{fontSize:30,marginBottom:12,opacity:0.3}}>📅</div>
                    <div style={{color:T.muted,marginBottom:6}}>No date columns detected in this dataset</div>
                    <div style={{fontSize:11,color:T.faint}}>Date columns are auto-detected from formats like YYYY-MM-DD, MM/DD/YYYY, Month DD YYYY</div>
                  </div>
                )}
                {dateCols.length>0&&(
                  <>
                    <div style={{...mkCard(T),padding:18}}>
                      <div style={{...mkLbl(T),marginBottom:12}}>TIME SERIES CONFIGURATION</div>
                      <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                        <div><div style={{...mkLbl(T),marginBottom:5}}>DATE COLUMN</div>
                          <select value={dateCol} onChange={e=>setDateCol(e.target.value)} style={mkSel(T)}>{dateCols.map(c=><option key={c.name}>{c.name}</option>)}</select>
                        </div>
                        <div><div style={{...mkLbl(T),marginBottom:5}}>VALUE COLUMN</div>
                          <select value={dateValueCol} onChange={e=>setDateValueCol(e.target.value)} style={mkSel(T)}>{numCols.map(c=><option key={c.name}>{c.name}</option>)}</select>
                        </div>
                        <div><div style={{...mkLbl(T),marginBottom:5}}>GROUP BY</div>
                          <select value={dateGroupBy} onChange={e=>setDateGroupBy(e.target.value)} style={mkSel(T)}>
                            <option value="year">Year</option>
                            <option value="quarter">Quarter</option>
                            <option value="month">Month</option>
                            <option value="week">Week</option>
                          </select>
                        </div>
                      </div>
                    </div>
                    {dateCol&&dateValueCol&&(()=>{
                      const ts=buildTimeSeries(data.rows,dateCol,dateValueCol,dateGroupBy);
                      if(!ts.length)return<div style={{...mkCard(T),padding:30,textAlign:"center",color:T.faint}}>No parseable dates found in "{dateCol}"</div>;
                      return(
                        <div style={{...mkCard(T),padding:20}}>
                          <div style={{...mkLbl(T),marginBottom:14}}>{dateValueCol.toUpperCase()} BY {dateGroupBy.toUpperCase()} · {ts.length} PERIODS</div>
                          <LineChart rows={ts.map(t=>({[dateGroupBy]:ts.indexOf(t),label:t.label,sum:t.sum}))} xCol={dateGroupBy} yCol="sum" theme={theme} title={`${dateValueCol} over time`} subtitle={`Grouped by ${dateGroupBy} · ${ts.length} periods`}/>
                          <div style={{marginTop:16,overflowX:"auto"}}>
                            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                              <thead><tr style={{background:T.bg}}>{["Period","Sum","Average","Count"].map(h=><th key={h} style={{padding:"8px 12px",textAlign:"left",color:T.faint,fontSize:10,borderBottom:`1px solid ${T.border}`}}>{h}</th>)}</tr></thead>
                              <tbody>{ts.map((t,i)=><tr key={i} style={{borderBottom:`1px solid ${T.vfaint}`}}>
                                <td style={{padding:"7px 12px",color:"#6ee7b7",fontWeight:600}}>{t.label}</td>
                                <td style={{padding:"7px 12px",color:T.muted}}>{t.sum.toLocaleString()}</td>
                                <td style={{padding:"7px 12px",color:T.muted}}>{t.avg.toLocaleString()}</td>
                                <td style={{padding:"7px 12px",color:T.faint}}>{t.count}</td>
                              </tr>)}</tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })()}
                    <div style={{...mkCard(T),padding:16}}>
                      <div style={{...mkLbl(T),marginBottom:8}}>DATE COLUMN DETAILS</div>
                      {dateCols.map(c=>{
                        const dates=data.rows.map(r=>parseFlexDate(r[c.name])).filter(Boolean).sort((a,b)=>a-b);
                        if(!dates.length)return<div key={c.name} style={{color:T.faint,fontSize:12}}>No parseable values in {c.name}</div>;
                        const earliest=dates[0],latest=dates[dates.length-1];
                        const span=Math.round((latest-earliest)/(1000*60*60*24));
                        return(
                          <div key={c.name} style={{padding:"10px 14px",background:T.bg,borderRadius:8,marginBottom:8}}>
                            <span style={{color:"#38bdf8",fontWeight:700}}>{c.name}</span>
                            <span style={{color:T.faint,fontSize:11,marginLeft:12}}>{earliest.toLocaleDateString()} → {latest.toLocaleDateString()} · {span} days span · {dates.length} valid dates</span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── CLEAN ── */}
            {activeTab==="clean"&&data&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:10}}>
                  {[{label:"Remove Duplicates",desc:"Delete identical rows",fn:removeDuplicates,color:"#fb923c"},{label:"Fill Missing Values",desc:"Replace blanks with mean/mode",fn:fillNulls,color:"#818cf8"},{label:"Trim Whitespace",desc:"Clean extra spaces",fn:trimStrings,color:"#6ee7b7"},{label:"Reset to Original",desc:"Undo all changes",fn:resetData,color:"#f472b6"}].map(op=>(
                    <button key={op.label} onClick={op.fn} style={{background:T.surface,border:`1px solid ${op.color}22`,borderRadius:12,padding:"16px 18px",cursor:"pointer",textAlign:"left",fontFamily:"inherit",transition:"border-color 0.15s"}} onMouseEnter={e=>e.currentTarget.style.borderColor=op.color} onMouseLeave={e=>e.currentTarget.style.borderColor=`${op.color}22`}>
                      <div style={{fontSize:12,fontWeight:700,color:op.color,marginBottom:5}}>{op.label}</div>
                      <div style={{fontSize:11,color:T.faint}}>{op.desc}</div>
                    </button>
                  ))}
                </div>
                <div style={{...mkCard(T),padding:18}}>
                  <div style={{...mkLbl(T),marginBottom:12}}>RENAME COLUMN</div>
                  <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                    <select value={renameCol} onChange={e=>setRenameCol(e.target.value)} style={mkSel(T)}><option value="">Select column</option>{data.headers.map(h=><option key={h}>{h}</option>)}</select>
                    <span style={{color:T.faint}}>→</span>
                    <input value={renameTo} onChange={e=>setRenameTo(e.target.value)} placeholder="New name" style={{...mkInput(T),flex:"0 1 180px"}}/>
                    <button onClick={doRename} style={{...mkBtn(!!renameCol&&!!renameTo,T),padding:"9px 16px",fontSize:11}}>RENAME</button>
                  </div>
                </div>
                <div style={{...mkCard(T),padding:18}}>
                  <div style={{...mkLbl(T),marginBottom:4}}>COLUMN CALCULATOR</div>
                  <div style={{fontSize:11,color:T.faint,marginBottom:12}}>Create new columns using formulas. Reference columns with [ColumnName]. Example: [Price] * [Quantity]</div>
                  <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap"}}>
                    <input value={calcName} onChange={e=>setCalcName(e.target.value)} placeholder="New column name" style={{...mkInput(T),flex:"0 1 180px"}}/>
                    <span style={{color:T.faint,alignSelf:"center"}}>=</span>
                    <input value={calcFormula} onChange={e=>setCalcFormula(e.target.value)} placeholder="[Column1] * [Column2] + 100" style={mkInput(T)}/>
                  </div>
                  <div style={{fontSize:11,color:T.faint,marginBottom:10}}>Available: {data.headers.slice(0,6).map(h=>`[${h}]`).join(", ")}</div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={handleCalcPreview} style={{...mkBtn(true,T),padding:"8px 14px",fontSize:10,background:T.bg,border:`1px solid ${T.border}`,color:T.muted}}>PREVIEW</button>
                    <button onClick={handleCalcApply} style={{...mkBtn(!!calcName&&!!calcFormula,T),padding:"8px 16px",fontSize:10}}>ADD COLUMN</button>
                  </div>
                  {calcError&&<div style={{color:"#fb923c",fontSize:11,marginTop:8}}>{calcError}</div>}
                  {calcPreview&&<div style={{marginTop:12,overflowX:"auto"}}><div style={{fontSize:10,color:T.faint,marginBottom:6}}>PREVIEW (first 5 rows)</div><table style={{borderCollapse:"collapse",fontSize:11}}><thead><tr>{Object.keys(calcPreview[0]).slice(-3).map(h=><th key={h} style={{padding:"6px 10px",color:T.faint,textAlign:"left",borderBottom:`1px solid ${T.border}`,background:T.bg}}>{h}</th>)}</tr></thead><tbody>{calcPreview.map((r,i)=><tr key={i}>{Object.entries(r).slice(-3).map(([k,v])=><td key={k} style={{padding:"6px 10px",color:k===calcName?"#6ee7b7":T.muted,borderBottom:`1px solid ${T.vfaint}`}}>{String(v).slice(0,20)}</td>)}</tr>)}</tbody></table></div>}
                </div>
                <div style={{...mkCard(T),padding:16}}>
                  <div style={{...mkLbl(T),marginBottom:10}}>CHANGE LOG</div>
                  {cleanLog.length===0?<div style={{fontSize:12,color:T.faint}}>No changes yet</div>:<div style={{display:"flex",flexDirection:"column",gap:4}}>{cleanLog.map((l,i)=><div key={i} style={{fontSize:11,color:T.muted,padding:"4px 8px",background:T.bg,borderRadius:4}}>{l}</div>)}</div>}
                </div>
              </div>
            )}

            {/* ── COMPARE ── */}
            {activeTab==="compare"&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                {files.length<2&&<div style={{...mkCard(T),padding:40,textAlign:"center"}}><div style={{fontSize:30,marginBottom:12,opacity:0.3}}>⊞</div><div style={{color:T.muted}}>Load at least 2 CSV files to compare them</div></div>}
                {files.length>=2&&(
                  <>
                    <div style={{...mkCard(T),padding:18}}>
                      <div style={{...mkLbl(T),marginBottom:12}}>COMPARE FILES</div>
                      <div style={{display:"flex",gap:12,marginBottom:14,flexWrap:"wrap"}}>
                        <div><div style={{...mkLbl(T),marginBottom:5}}>FILE A</div><select value={compareA} onChange={e=>setCompareA(Number(e.target.value))} style={mkSel(T)}>{files.map((f,i)=><option key={i} value={i}>{f.name}</option>)}</select></div>
                        <div style={{alignSelf:"flex-end",paddingBottom:8,color:T.faint}}>vs</div>
                        <div><div style={{...mkLbl(T),marginBottom:5}}>FILE B</div><select value={compareB} onChange={e=>setCompareB(Number(e.target.value))} style={mkSel(T)}>{files.map((f,i)=><option key={i} value={i}>{f.name}</option>)}</select></div>
                        <button onClick={handleCompare} disabled={compareLoading||compareA===compareB} style={{...mkBtn(!compareLoading&&compareA!==compareB,T),padding:"9px 18px",fontSize:11,alignSelf:"flex-end"}}>{compareLoading?"ANALYZING...":"COMPARE →"}</button>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                        {[compareA,compareB].map((fi,ii)=>{const f=files[fi];if(!f)return null;return(<div key={ii} style={{background:T.bg,borderRadius:8,padding:14}}><div style={{fontSize:12,fontWeight:700,color:ii===0?"#6ee7b7":"#818cf8",marginBottom:8}}>{ii===0?"A":"B"}: {f.name}</div>{[["Rows",f.rows.length.toLocaleString()],["Columns",f.headers.length],["Numeric",f.colTypes.filter(c=>c.type==="number").length]].map(([k,v])=><div key={k} style={{display:"flex",justifyContent:"space-between",fontSize:11,color:T.muted,marginBottom:3}}><span>{k}</span><span style={{fontWeight:600}}>{v}</span></div>)}</div>);})}
                      </div>
                    </div>
                    {compareResult&&(
                      <div style={{...mkCard(T),padding:20}}>
                        <div style={{...mkLbl(T),marginBottom:14}}>AI COMPARISON ANALYSIS</div>
                        <div style={{fontSize:13,color:T.muted,lineHeight:1.7,marginBottom:16,padding:14,background:T.bg,borderRadius:8,border:`1px solid ${T.border}`}}>{compareResult.summary}</div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
                          <div style={{background:"rgba(52,211,153,0.08)",border:"1px solid #34d399",borderRadius:10,padding:16}}><div style={{fontSize:11,fontWeight:700,color:"#34d399",marginBottom:10}}>SIMILARITIES</div>{(compareResult.similarities||[]).map((s,i)=><div key={i} style={{fontSize:12,color:T.muted,marginBottom:6,paddingLeft:8,borderLeft:"2px solid #34d399"}}>• {s}</div>)}</div>
                          <div style={{background:"rgba(251,146,60,0.08)",border:"1px solid #fb923c",borderRadius:10,padding:16}}><div style={{fontSize:11,fontWeight:700,color:"#fb923c",marginBottom:10}}>DIFFERENCES</div>{(compareResult.differences||[]).map((s,i)=><div key={i} style={{fontSize:12,color:T.muted,marginBottom:6,paddingLeft:8,borderLeft:"2px solid #fb923c"}}>• {s}</div>)}</div>
                        </div>
                        {compareResult.recommendation&&<div style={{fontSize:12,color:"#6ee7b7",padding:12,background:"rgba(110,231,183,0.08)",borderRadius:8,border:"1px solid rgba(110,231,183,0.3)"}}>→ {compareResult.recommendation}</div>}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── CHAT ── */}
            {activeTab==="chat"&&(
              <div>
                <div style={{...mkCard(T),padding:0,overflow:"hidden",display:"flex",flexDirection:"column",height:480,marginBottom:10}}>
                  <div style={{padding:"12px 18px",borderBottom:`1px solid ${T.border}`,...mkLbl(T)}}>AI CHAT · {data?`analyzing ${data.name}`:"no file loaded"}</div>
                  <div style={{flex:1,overflowY:"auto",padding:"14px 16px",display:"flex",flexDirection:"column",gap:10}}>
                    {chatMessages.map((m,i)=>(
                      <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                        <div style={{maxWidth:"78%",padding:"10px 14px",borderRadius:10,background:m.role==="user"?"linear-gradient(135deg,#6ee7b7,#818cf8)":"transparent",border:m.role==="user"?"none":`1px solid ${T.border}`,color:m.role==="user"?"#080f1a":T.muted,fontSize:13,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{m.text}</div>
                      </div>
                    ))}
                    {chatLoading&&<div style={{display:"flex",gap:5,padding:"10px 12px",background:T.surface,borderRadius:10,border:`1px solid ${T.border}`,width:"fit-content"}}>{[0,1,2].map(i=><div key={i} style={{width:6,height:6,borderRadius:"50%",background:T.faint,animation:`bounce 1s ease-in-out ${i*0.2}s infinite`}}/>)}</div>}
                    <div ref={chatEndRef}/>
                  </div>
                  <div style={{padding:"10px 14px",borderTop:`1px solid ${T.border}`,display:"flex",gap:8}}>
                    <input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&handleChat()} placeholder="Ask anything about your data..." style={{...mkInput(T),fontSize:12}}/>
                    <button onClick={handleChat} disabled={chatLoading} style={{...mkBtn(!chatLoading,T),padding:"10px 16px",fontSize:11}}>SEND</button>
                  </div>
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {["What are the main trends?","Which column has most outliers?","Summarize in 3 sentences","What should I investigate further?","Any data quality issues?"].map(q=>(
                    <button key={q} onClick={()=>setChatInput(q)} style={{fontSize:10,padding:"6px 12px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,color:T.faint,cursor:"pointer",fontFamily:"inherit"}}>{q}</button>
                  ))}
                </div>
              </div>
            )}

            {/* ── DASHBOARD ── */}
            {activeTab==="dashboard"&&(
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                  <input value={dashboardName} onChange={e=>setDashboardName(e.target.value)} placeholder="Dashboard name..." style={{...mkInput(T),flex:"0 1 220px",fontSize:13}}/>
                  <button onClick={()=>setDashboardCharts([])} style={{...mkBtn(false,T),padding:"9px 14px",fontSize:10}}>CLEAR ALL</button>
                </div>
                {dashboardCharts.length===0?(
                  <div style={{...mkCard(T),padding:60,textAlign:"center"}}><div style={{fontSize:36,marginBottom:12,opacity:0.2}}>📌</div><div style={{fontSize:14,color:T.muted,marginBottom:6}}>Your dashboard is empty</div><div style={{fontSize:12,color:T.faint}}>Go to Charts or AI Charts and click 📌 pin button on any chart</div></div>
                ):(
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(440px,1fr))",gap:16}}>
                    {dashboardCharts.map((chart,i)=>(
                      <div key={chart.id} style={{...mkCard(T),padding:20}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                          <div><div style={{fontSize:13,fontWeight:700,color:T.text}}>{chart.title||"Chart"}</div><div style={{fontSize:10,color:T.faint}}>{chart.fileName} · {chart.type}</div></div>
                          <button onClick={()=>setDashboardCharts(d=>d.filter((_,di)=>di!==i))} style={{fontSize:11,background:"transparent",border:"none",color:T.faint,cursor:"pointer"}}>✕</button>
                        </div>
                        <MiniChartRenderer chart={chart} allData={files} theme={theme}/>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── EXPORT ── */}
            {activeTab==="export"&&data&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(230px,1fr))",gap:10}}>
                  {[{icon:"📄",label:"Export CSV",desc:`All ${data.rows.length} rows`,color:"#6ee7b7",fn:()=>exportCSV()},{icon:"📊",label:"PDF Report",desc:"Stats + insights + preview",color:"#818cf8",fn:exportPDF},{icon:"📋",label:"Copy Report",desc:"Copy summary to clipboard",color:"#fb923c",fn:copyReport},{icon:"🔍",label:"Export Filtered",desc:`${frows.length} filtered rows`,color:"#f472b6",fn:()=>exportCSV(frows)}].map(op=>(
                    <button key={op.label} onClick={op.fn} style={{background:T.surface,border:`1px solid ${op.color}33`,borderRadius:12,padding:"22px 20px",cursor:"pointer",textAlign:"left",fontFamily:"inherit",transition:"all 0.15s"}} onMouseEnter={e=>{e.currentTarget.style.borderColor=op.color;e.currentTarget.style.background=`${op.color}08`;}} onMouseLeave={e=>{e.currentTarget.style.borderColor=`${op.color}33`;e.currentTarget.style.background=T.surface;}}>
                      <div style={{fontSize:26,marginBottom:10}}>{op.icon}</div>
                      <div style={{fontSize:13,fontWeight:700,color:op.color,marginBottom:5}}>{op.label}</div>
                      <div style={{fontSize:11,color:T.faint}}>{op.desc}</div>
                    </button>
                  ))}
                </div>
                <div style={{...mkCard(T),padding:18}}>
                  <div style={{...mkLbl(T),marginBottom:12}}>DATASET SUMMARY</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                    {[["File",data.name],["Rows",data.rows.length.toLocaleString()],["Columns",data.headers.length],["Numeric",numCols.length],["Text",catCols.length],["Changes",cleanLog.filter(l=>!l.includes("Reset")).length]].map(([k,v])=>(
                      <div key={k} style={{background:T.bg,borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:10,color:T.faint,marginBottom:3}}>{k.toUpperCase()}</div><div style={{fontSize:13,color:T.muted,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v}</div></div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&display=swap');*{box-sizing:border-box;}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}::-webkit-scrollbar{width:6px;height:6px;}::-webkit-scrollbar-track{background:transparent;}::-webkit-scrollbar-thumb{background:#1e293b;border-radius:3px;}`}</style>
    </div>
  );
}
