import { useState, useRef, useCallback, useEffect } from "react";

const GROQ_MODEL = "llama-3.3-70b-versatile";
const COLORS = ["#6ee7b7","#818cf8","#fb923c","#f472b6","#38bdf8","#facc15","#a78bfa","#34d399","#e879f9","#22d3ee"];
const API_KEY = process.env.REACT_APP_GROQ_API_KEY || "";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g,""));
  const rows = lines.slice(1).filter(l=>l.trim()).map(line => {
    const vals=[]; let cur="",inQ=false;
    for(let ch of line){ if(ch==='"')inQ=!inQ; else if(ch===","&&!inQ){vals.push(cur.trim());cur="";}else cur+=ch; }
    vals.push(cur.trim());
    return Object.fromEntries(headers.map((h,i)=>[h,vals[i]??""]));
  });
  return {headers,rows};
}
function rowsToCSV(rows){
  if(!rows.length)return"";
  const h=Object.keys(rows[0]);
  return[h.join(","),...rows.map(r=>h.map(k=>`"${(r[k]??"").toString().replace(/"/g,'""')}"`).join(","))].join("\n");
}
function inferTypes(headers,rows){
  return headers.map(h=>{
    const vals=rows.map(r=>r[h]).filter(v=>v!==""&&v!=null);
    const n=vals.filter(v=>!isNaN(Number(v))).length;
    return{name:h,type:n/vals.length>0.8?"number":"string"};
  });
}
function computeStats(rows,col){
  const vals=rows.map(r=>Number(r[col])).filter(v=>!isNaN(v));
  if(!vals.length)return null;
  const sorted=[...vals].sort((a,b)=>a-b);
  const mean=vals.reduce((s,v)=>s+v,0)/vals.length;
  const variance=vals.reduce((s,v)=>s+(v-mean)**2,0)/vals.length;
  const q1=sorted[Math.floor(sorted.length*0.25)];
  const q3=sorted[Math.floor(sorted.length*0.75)];
  return{mean:mean.toFixed(2),min:sorted[0].toFixed(2),max:sorted[sorted.length-1].toFixed(2),
    median:sorted[Math.floor(sorted.length/2)].toFixed(2),std:Math.sqrt(variance).toFixed(2),
    count:vals.length,q1:q1?.toFixed(2),q3:q3?.toFixed(2)};
}
function evalFormula(formula,row){
  try{
    const expr=formula.replace(/\[([^\]]+)\]/g,(_,col)=>{
      const v=Number(row[col]);return isNaN(v)?`"${row[col]}"`:v;
    });
    // eslint-disable-next-line no-new-func
    return Function(`"use strict";return(${expr})`)();
  }catch{return""}
}
function executeSimpleSQL(sql,rows){
  let result=[...rows];
  const whereMatch=sql.match(/WHERE\s+(.+?)(?:\s+GROUP BY|\s+ORDER BY|\s+LIMIT|$)/i);
  if(whereMatch){
    const m=whereMatch[1].trim().match(/(\w+)\s*(=|!=|>|<|>=|<=|LIKE)\s*'?([^']+)'?/i);
    if(m){
      const[,col,op,val]=m;
      result=result.filter(r=>{
        const rv=r[col];const nv=Number(val);
        if(op==="=")return rv==val;if(op==="!=")return rv!=val;
        if(op===">")return Number(rv)>nv;if(op==="<")return Number(rv)<nv;
        if(op===">=")return Number(rv)>=nv;if(op==="<=")return Number(rv)<=nv;
        if(op.toUpperCase()==="LIKE")return String(rv).toLowerCase().includes(val.toLowerCase().replace(/%/g,""));
        return true;
      });
    }
  }
  const groupMatch=sql.match(/GROUP BY\s+(\w+)/i);
  const selectMatch=sql.match(/SELECT\s+(.+?)\s+FROM/i);
  if(groupMatch&&selectMatch){
    const groupCol=groupMatch[1];
    const aggMatch=selectMatch[1].match(/(COUNT|SUM|AVG|MAX|MIN)\((\*|\w+)\)/i);
    const groups={};
    result.forEach(r=>{const k=r[groupCol];if(!groups[k])groups[k]=[];groups[k].push(r);});
    return Object.entries(groups).map(([k,grp])=>{
      const row={[groupCol]:k};
      if(aggMatch){
        const[,fn,col]=aggMatch;
        const vals=grp.map(r=>Number(r[col==="*"?Object.keys(r)[0]:col])).filter(v=>!isNaN(v));
        if(fn==="COUNT")row["COUNT"]=grp.length;
        else if(fn==="SUM")row[`SUM(${col})`]=vals.reduce((s,v)=>s+v,0).toFixed(2);
        else if(fn==="AVG")row[`AVG(${col})`]=(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(2);
        else if(fn==="MAX")row[`MAX(${col})`]=Math.max(...vals).toFixed(2);
        else if(fn==="MIN")row[`MIN(${col})`]=Math.min(...vals).toFixed(2);
      }
      return row;
    });
  }
  const orderMatch=sql.match(/ORDER BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
  if(orderMatch){const[,col,dir]=orderMatch;result.sort((a,b)=>{const d=isNaN(Number(a[col]))?String(a[col]).localeCompare(String(b[col])):Number(a[col])-Number(b[col]);return dir?.toUpperCase()==="DESC"?-d:d;});}
  const limitMatch=sql.match(/LIMIT\s+(\d+)/i);
  if(limitMatch)result=result.slice(0,Number(limitMatch[1]));
  if(selectMatch&&!sql.toUpperCase().includes("GROUP BY")){
    const cols=selectMatch[1].split(",").map(c=>c.trim());
    if(!cols.includes("*"))result=result.map(r=>Object.fromEntries(cols.map(c=>[c,r[c]])));
  }
  return result;
}

// ─── AI ───────────────────────────────────────────────────────────────────────
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

// ─── Theme ────────────────────────────────────────────────────────────────────
const themes={
  dark:{bg:"#080f1a",surface:"#0f172a",border:"#1e293b",text:"#e2e8f0",muted:"#94a3b8",faint:"#334155",vfaint:"#1e293b",inputBg:"#080f1a"},
  light:{bg:"#f1f5f9",surface:"#ffffff",border:"#e2e8f0",text:"#0f172a",muted:"#64748b",faint:"#94a3b8",vfaint:"#f1f5f9",inputBg:"#ffffff"}
};

// ─── Chart primitives ─────────────────────────────────────────────────────────
function BarChart({data,labelKey,valueKey,color="#6ee7b7",theme}){
  const T=themes[theme];
  const max=Math.max(...data.map(d=>Number(d[valueKey])||0));
  return(
    <div style={{overflowX:"auto"}}>
      <div style={{display:"flex",flexDirection:"column",gap:5,minWidth:300}}>
        {data.slice(0,15).map((d,i)=>{
          const val=Number(d[valueKey])||0;const pct=max?(val/max)*100:0;
          return(<div key={i} style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:130,fontSize:11,color:T.muted,textAlign:"right",flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{String(d[labelKey]).slice(0,18)}</div>
            <div style={{flex:1,background:T.vfaint,borderRadius:4,height:22,position:"relative"}}>
              <div style={{width:`${pct}%`,background:color,borderRadius:4,height:"100%",transition:"width 0.6s"}}/>
              <span style={{position:"absolute",right:6,top:3,fontSize:11,color:T.text}}>{val%1===0?val:Number(val).toFixed(1)}</span>
            </div>
          </div>);
        })}
      </div>
    </div>
  );
}

function PieChart({data,labelKey,valueKey,theme}){
  const T=themes[theme];
  const total=data.reduce((s,d)=>s+(Number(d[valueKey])||0),0);
  let angle=-Math.PI/2;
  const slices=data.slice(0,8).map((d,i)=>{
    const val=Number(d[valueKey])||0;const frac=total?val/total:0;
    const start=angle;angle+=frac*2*Math.PI;
    const x1=Math.cos(start)*80+100,y1=Math.sin(start)*80+100;
    const x2=Math.cos(angle)*80+100,y2=Math.sin(angle)*80+100;
    return{path:`M100,100 L${x1},${y1} A80,80 0 ${frac>0.5?1:0},1 ${x2},${y2} Z`,color:COLORS[i%COLORS.length],label:d[labelKey],pct:(frac*100).toFixed(1)};
  });
  return(<div style={{display:"flex",alignItems:"center",gap:24,flexWrap:"wrap"}}>
    <svg width={200} height={200} style={{flexShrink:0}}>
      {slices.map((s,i)=><path key={i} d={s.path} fill={s.color} stroke={T.bg} strokeWidth={2} opacity={0.9}/>)}
    </svg>
    <div style={{display:"flex",flexDirection:"column",gap:5}}>
      {slices.map((s,i)=>(
        <div key={i} style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:10,height:10,borderRadius:2,background:s.color,flexShrink:0}}/>
          <div style={{fontSize:12,color:T.muted}}>{String(s.label).slice(0,20)}</div>
          <div style={{fontSize:11,color:T.faint,marginLeft:"auto",paddingLeft:12}}>{s.pct}%</div>
        </div>
      ))}
    </div>
  </div>);
}

function ScatterPlot({rows,xCol,yCol,colorCol,theme}){
  const T=themes[theme];
  const xVals=rows.map(r=>Number(r[xCol])).filter(v=>!isNaN(v));
  const yVals=rows.map(r=>Number(r[yCol])).filter(v=>!isNaN(v));
  if(!xVals.length||!yVals.length)return<div style={{color:T.muted,padding:20}}>Not enough numeric data</div>;
  const xMin=Math.min(...xVals),xMax=Math.max(...xVals),yMin=Math.min(...yVals),yMax=Math.max(...yVals);
  const W=460,H=280,PAD=44;
  const toX=v=>PAD+(v-xMin)/(xMax-xMin||1)*(W-PAD*2);
  const toY=v=>H-PAD-(v-yMin)/(yMax-yMin||1)*(H-PAD*2);
  const cats=[...new Set(rows.map(r=>r[colorCol]))];
  return(<div style={{overflowX:"auto"}}>
    <svg width={W} height={H} style={{background:T.inputBg,borderRadius:8}}>
      {[0,0.25,0.5,0.75,1].map(t=>{
        const y=PAD+(1-t)*(H-PAD*2);const val=(yMin+t*(yMax-yMin)).toFixed(1);
        return<g key={t}><line x1={PAD} y1={y} x2={W-PAD} y2={y} stroke={T.border} strokeWidth={1}/><text x={PAD-4} y={y+4} fill={T.faint} fontSize={9} textAnchor="end">{val}</text></g>;
      })}
      {[0,0.25,0.5,0.75,1].map(t=>{
        const x=PAD+t*(W-PAD*2);const val=(xMin+t*(xMax-xMin)).toFixed(1);
        return<g key={t}><line x1={x} y1={PAD} x2={x} y2={H-PAD} stroke={T.border} strokeWidth={1}/><text x={x} y={H-PAD+14} fill={T.faint} fontSize={9} textAnchor="middle">{val}</text></g>;
      })}
      {rows.slice(0,500).map((r,i)=>{
        const x=toX(Number(r[xCol])),y=toY(Number(r[yCol]));
        if(isNaN(x)||isNaN(y))return null;
        const ci=cats.indexOf(r[colorCol]);
        return<circle key={i} cx={x} cy={y} r={4} fill={COLORS[ci>=0?ci%COLORS.length:0]} opacity={0.7}/>;
      })}
      <text x={W/2} y={H-4} fill={T.faint} fontSize={10} textAnchor="middle">{xCol}</text>
      <text x={12} y={H/2} fill={T.faint} fontSize={10} textAnchor="middle" transform={`rotate(-90,12,${H/2})`}>{yCol}</text>
    </svg>
  </div>);
}

function LineChart({rows,xCol,yCol,theme}){
  const T=themes[theme];
  const pts=rows.slice(0,300).map(r=>({x:Number(r[xCol]),y:Number(r[yCol])})).filter(p=>!isNaN(p.x)&&!isNaN(p.y));
  if(pts.length<2)return<div style={{color:T.muted,padding:20}}>Need at least 2 data points</div>;
  pts.sort((a,b)=>a.x-b.x);
  const xMin=pts[0].x,xMax=pts[pts.length-1].x,yMin=Math.min(...pts.map(p=>p.y)),yMax=Math.max(...pts.map(p=>p.y));
  const W=460,H=260,PAD=44;
  const toX=v=>PAD+(v-xMin)/(xMax-xMin||1)*(W-PAD*2);
  const toY=v=>H-PAD-(v-yMin)/(yMax-yMin||1)*(H-PAD*2);
  const d="M"+pts.map(p=>`${toX(p.x)},${toY(p.y)}`).join(" L");
  return(<div style={{overflowX:"auto"}}>
    <svg width={W} height={H} style={{background:T.inputBg,borderRadius:8}}>
      {[0,0.25,0.5,0.75,1].map(t=>{const y=PAD+(1-t)*(H-PAD*2);return<line key={t} x1={PAD} y1={y} x2={W-PAD} y2={y} stroke={T.border} strokeWidth={1}/>;} )}
      <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.3"/><stop offset="100%" stopColor="#6ee7b7" stopOpacity="0"/></linearGradient></defs>
      <path d={`${d} L${toX(pts[pts.length-1].x)},${H-PAD} L${toX(pts[0].x)},${H-PAD} Z`} fill="url(#lg)"/>
      <path d={d} fill="none" stroke="#6ee7b7" strokeWidth={2}/>
      <text x={W/2} y={H-4} fill={T.faint} fontSize={10} textAnchor="middle">{xCol} → {yCol}</text>
    </svg>
  </div>);
}

function Heatmap({rows,colTypes,theme}){
  const T=themes[theme];
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
  return(<div style={{overflowX:"auto"}}>
    <svg width={numCols.length*cell+130} height={numCols.length*cell+70}>
      {numCols.map((col,i)=><text key={i} x={130+i*cell+cell/2} y={22} fill={T.faint} fontSize={9} textAnchor="middle" transform={`rotate(-35,${130+i*cell+cell/2},22)`}>{col.name.slice(0,11)}</text>)}
      {corr.map((row,i)=>row.map((val,j)=>{
        const r=val>0?0:Math.round(-val*200),g=val>0?Math.round(val*180):0,b=val>0?Math.round(val*120):Math.round(-val*80);
        return<g key={`${i}-${j}`}><rect x={130+j*cell} y={35+i*cell} width={cell} height={cell} fill={`rgb(${r},${g},${b})`} opacity={0.85}/><text x={130+j*cell+cell/2} y={35+i*cell+cell/2+5} fill="#fff" fontSize={9} textAnchor="middle">{val.toFixed(2)}</text></g>;
      }))}
      {numCols.map((col,i)=><text key={i} x={125} y={35+i*cell+cell/2+4} fill={T.faint} fontSize={9} textAnchor="end">{col.name.slice(0,13)}</text>)}
    </svg>
  </div>);
}

function Histogram({rows,col,theme}){
  const T=themes[theme];
  const vals=rows.map(r=>Number(r[col])).filter(v=>!isNaN(v));
  if(!vals.length)return null;
  const min=Math.min(...vals),max=Math.max(...vals),bins=12,step=(max-min)/bins||1;
  const buckets=Array.from({length:bins},(_,i)=>({label:(min+i*step).toFixed(1),count:0}));
  vals.forEach(v=>{const idx=Math.min(Math.floor((v-min)/step),bins-1);buckets[idx].count++;});
  return<BarChart data={buckets} labelKey="label" valueKey="count" color="#818cf8" theme={theme}/>;
}

// ─── Shared style helpers ─────────────────────────────────────────────────────
const mkCard=(T,extra={})=>({background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,...extra});
const mkLbl=(T,extra={})=>({fontSize:11,color:T.faint,letterSpacing:"0.1em",...extra});
const mkBtn=(active=true,T)=>({padding:"10px 20px",background:active?"linear-gradient(135deg,#6ee7b7,#818cf8)":"transparent",border:active?"none":`1px solid ${T?.border||"#1e293b"}`,borderRadius:8,color:active?"#080f1a":(T?.muted||"#475569"),fontWeight:700,cursor:active?"pointer":"wait",fontFamily:"inherit",fontSize:11,letterSpacing:"0.06em"});
const mkInput=(T)=>({flex:1,background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 14px",color:T.text,fontSize:13,fontFamily:"inherit",outline:"none"});
const mkSel=(T)=>({background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:6,padding:"7px 11px",color:T.muted,fontSize:12,fontFamily:"inherit",outline:"none"});

// ─── Mini chart renderer for Dashboard ───────────────────────────────────────
function MiniChartRenderer({chart,allData,theme}){
  const T=themes[theme];
  const data=allData[chart.fileIdx]||allData[0];
  if(!data)return<div style={{color:T.muted,padding:16,fontSize:12}}>No data</div>;
  const {rows,colTypes}=data;
  if(chart.type==="bar"){
    const cnt={};rows.forEach(r=>{const v=r[chart.col]||"(empty)";cnt[v]=(cnt[v]||0)+1;});
    const d=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([label,count])=>({label,count}));
    return<BarChart data={d} labelKey="label" valueKey="count" color={chart.color||"#6ee7b7"} theme={theme}/>;
  }
  if(chart.type==="pie"){
    const cnt={};rows.forEach(r=>{const k=r[chart.labelCol];const v=Number(r[chart.valueCol])||0;cnt[k]=(cnt[k]||0)+v;});
    const d=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([label,value])=>({label,value}));
    return<PieChart data={d} labelKey="label" valueKey="value" theme={theme}/>;
  }
  if(chart.type==="scatter")return<ScatterPlot rows={rows} xCol={chart.xCol} yCol={chart.yCol} colorCol={chart.colorCol} theme={theme}/>;
  if(chart.type==="line")return<LineChart rows={rows} xCol={chart.xCol} yCol={chart.yCol} theme={theme}/>;
  if(chart.type==="histogram")return<Histogram rows={rows} col={chart.col} theme={theme}/>;
  if(chart.type==="heatmap")return<Heatmap rows={rows} colTypes={colTypes} theme={theme}/>;
  return null;
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [theme,setTheme]=useState("dark");
  const T=themes[theme];

  // Multi-file support
  const [files,setFiles]=useState([]); // [{name,headers,rows,colTypes}]
  const [activeFile,setActiveFile]=useState(0);
  const data=files[activeFile]||null;

  const [activeTab,setActiveTab]=useState("overview");
  const [dragOver,setDragOver]=useState(false);
  const fileRef=useRef();

  // SQL
  const [nlQuery,setNlQuery]=useState("");
  const [nlResult,setNlResult]=useState(null);
  const [genSQL,setGenSQL]=useState("");
  const [nlLoading,setNlLoading]=useState(false);
  const [sqlHistory,setSqlHistory]=useState([]);
  const [sqlChartType,setSqlChartType]=useState("bar");

  // Insights
  const [insights,setInsights]=useState({});
  const [insightsLoading,setInsightsLoading]=useState(false);

  // Charts tab
  const [chartMode,setChartMode]=useState("scatter");
  const [scatterX,setScatterX]=useState("");
  const [scatterY,setScatterY]=useState("");
  const [scatterC,setScatterC]=useState("");
  const [lineX,setLineX]=useState("");
  const [lineY,setLineY]=useState("");
  const [pieLabel,setPieLabel]=useState("");
  const [pieValue,setPieValue]=useState("");

  // AI Chart builder
  const [aiChartPrompt,setAiChartPrompt]=useState("");
  const [aiChartLoading,setAiChartLoading]=useState(false);
  const [aiChartConfig,setAiChartConfig]=useState(null);
  const [aiChartError,setAiChartError]=useState("");

  // AI Column suggestions
  const [suggestions,setSuggestions]=useState([]);
  const [suggestionsLoading,setSuggestionsLoading]=useState(false);

  // Dashboard
  const [dashboardCharts,setDashboardCharts]=useState([]);
  const [dashboardName,setDashboardName]=useState("");

  // Clean
  const [cleanLog,setCleanLog]=useState([]);
  const [renameCol,setRenameCol]=useState("");
  const [renameTo,setRenameTo]=useState("");

  // Column calculator
  const [calcName,setCalcName]=useState("");
  const [calcFormula,setCalcFormula]=useState("");
  const [calcPreview,setCalcPreview]=useState(null);
  const [calcError,setCalcError]=useState("");

  // Search/filter
  const [searchQuery,setSearchQuery]=useState("");
  const [filterCol,setFilterCol]=useState("");
  const [filterOp,setFilterOp]=useState("contains");
  const [filterVal,setFilterVal]=useState("");

  // Chat
  const [chatMessages,setChatMessages]=useState([]);
  const [chatInput,setChatInput]=useState("");
  const [chatLoading,setChatLoading]=useState(false);
  const chatEndRef=useRef();

  // Compare
  const [compareA,setCompareA]=useState(0);
  const [compareB,setCompareB]=useState(1);
  const [compareResult,setCompareResult]=useState(null);
  const [compareLoading,setCompareLoading]=useState(false);

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
    setScatterX(nums[0]?.name||"");setScatterY(nums[1]?.name||nums[0]?.name||"");setScatterC(cats[0]?.name||"");
    setLineX(nums[0]?.name||"");setLineY(nums[1]?.name||nums[0]?.name||"");
    setPieLabel(cats[0]?.name||"");setPieValue(nums[0]?.name||"");
    setNlResult(null);setGenSQL("");setSearchQuery("");setFilterVal("");
    setChatMessages(m=>[...m,{role:"assistant",text:`Loaded "${name}" — ${parsed.rows.length} rows, ${parsed.headers.length} columns.`}]);
    setActiveTab("overview");
  },[]);

  const onFile=f=>{if(!f)return;const r=new FileReader();r.onload=e=>loadFile(e.target.result,f.name);r.readAsText(f);};

  const numCols=data?.colTypes.filter(c=>c.type==="number")||[];
  const catCols=data?.colTypes.filter(c=>c.type==="string")||[];

  // Filtered rows for display
  const filteredRows=useCallback(()=>{
    if(!data)return[];
    let rows=[...data.rows];
    if(searchQuery.trim()){
      const q=searchQuery.toLowerCase();
      rows=rows.filter(r=>Object.values(r).some(v=>String(v).toLowerCase().includes(q)));
    }
    if(filterCol&&filterVal.trim()){
      rows=rows.filter(r=>{
        const rv=r[filterCol];const nv=Number(filterVal);
        if(filterOp==="contains")return String(rv).toLowerCase().includes(filterVal.toLowerCase());
        if(filterOp==="equals")return rv==filterVal;
        if(filterOp===">")return Number(rv)>nv;
        if(filterOp==="<")return Number(rv)<nv;
        if(filterOp===">=")return Number(rv)>=nv;
        if(filterOp==="<=")return Number(rv)<=nv;
        return true;
      });
    }
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
    }catch(e){
      setInsights(ins=>({...ins,[activeFile]:[{title:"Error generating insights",insight:"Error: "+e.message,severity:"warning",recommendation:"Check your API connection."}]}));
    }
    setInsightsLoading(false);
  };

  // ── AI Chart Builder ──
  const handleAIChart=async()=>{
    if(!aiChartPrompt.trim()||!data)return;
    setAiChartLoading(true);setAiChartConfig(null);setAiChartError("");
    try{
      const colInfo=data.colTypes.map(c=>`${c.name}(${c.type})`).join(", ");
      const text=await callAI([{role:"user",content:`The user wants to create a chart. Based on their description, return a JSON config.\n\nAvailable columns: ${colInfo}\n\nUser request: "${aiChartPrompt}"\n\nReturn a JSON object with these fields:\n- type: one of "bar","pie","scatter","line","histogram","heatmap"\n- title: chart title string\n- xCol: column name for x axis (if applicable)\n- yCol: column name for y axis (if applicable)  \n- col: column name for single-column charts (bar/histogram)\n- labelCol: label column for pie chart\n- valueCol: value column for pie chart\n- colorCol: optional column to color by (scatter)\n- color: hex color code like #6ee7b7\n\nReturn ONLY valid JSON, no markdown.`}],"You are a data visualization expert. Output only valid JSON.");
      const config=JSON.parse(text.replace(/```json|```/g,"").trim());
      setAiChartConfig(config);
    }catch(e){setAiChartError("Could not build chart: "+e.message);}
    setAiChartLoading(false);
  };

  // ── Column suggestions ──
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

  // ── Compare files ──
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

  // ── Column Calculator ──
  const handleCalcPreview=()=>{
    if(!calcFormula.trim()||!data){setCalcPreview(null);return;}
    try{
      const preview=data.rows.slice(0,5).map(r=>({...r,[calcName||"new_col"]:evalFormula(calcFormula,r)}));
      setCalcPreview(preview);setCalcError("");
    }catch(e){setCalcError("Formula error: "+e.message);setCalcPreview(null);}
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
  const removeDuplicates=()=>{
    const before=data.rows.length;const seen=new Set();
    const deduped=data.rows.filter(r=>{const k=JSON.stringify(r);if(seen.has(k))return false;seen.add(k);return true;});
    setFiles(f=>{const nf=[...f];nf[activeFile]={...nf[activeFile],rows:deduped};return nf;});
    setCleanLog(l=>[`✓ Removed ${before-deduped.length} duplicates (${before}→${deduped.length})`,...l]);
  };
  const fillNulls=()=>{
    const newRows=data.rows.map(r=>{
      const nr={...r};
      data.colTypes.forEach(c=>{
        if(nr[c.name]===""||nr[c.name]==null){
          if(c.type==="number"){const vals=data.rows.map(x=>Number(x[c.name])).filter(v=>!isNaN(v));nr[c.name]=vals.length?(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(2):"0";}
          else{const cnt={};data.rows.forEach(x=>{const v=x[c.name];if(v)cnt[v]=(cnt[v]||0)+1;});nr[c.name]=Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0]?.[0]||"";}
        }
      });return nr;
    });
    setFiles(f=>{const nf=[...f];nf[activeFile]={...nf[activeFile],rows:newRows};return nf;});
    setCleanLog(l=>[`✓ Filled missing values`,...l]);
  };
  const trimStrings=()=>{
    setFiles(f=>{const nf=[...f];nf[activeFile]={...nf[activeFile],rows:nf[activeFile].rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==="string"?v.trim():v])))};return nf;});
    setCleanLog(l=>[`✓ Trimmed whitespace`,...l]);
  };
  const doRename=()=>{
    if(!renameCol||!renameTo||renameCol===renameTo)return;
    setFiles(f=>{const nf=[...f];const d=nf[activeFile];
      nf[activeFile]={...d,headers:d.headers.map(h=>h===renameCol?renameTo:h),rows:d.rows.map(r=>{const nr={...r};nr[renameTo]=nr[renameCol];delete nr[renameCol];return nr;}),colTypes:d.colTypes.map(c=>c.name===renameCol?{...c,name:renameTo}:c)};return nf;});
    setCleanLog(l=>[`✓ Renamed "${renameCol}"→"${renameTo}"`,...l]);
    setRenameCol("");setRenameTo("");
  };
  const resetData=()=>{
    setFiles(f=>{const nf=[...f];nf[activeFile]={...nf[activeFile],rows:[...nf[activeFile].rawRows]};return nf;});
    setCleanLog(l=>[`↺ Reset to original`,...l]);
  };

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
  const exportCSV=(rows=data?.rows)=>{
    if(!rows)return;
    const blob=new Blob([rowsToCSV(rows)],{type:"text/csv"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`export_${data?.name||"data.csv"}`;a.click();
  };
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

  const addToDashboard=(chartConfig)=>{
    const id=Date.now();
    setDashboardCharts(d=>[...d,{id,...chartConfig,fileIdx:activeFile,fileName:data?.name}]);
  };

  const sevStyle=s=>({positive:{border:`1px solid #34d399`,bg:"rgba(52,211,153,0.08)",dot:"#34d399"},warning:{border:`1px solid #fb923c`,bg:"rgba(251,146,60,0.08)",dot:"#fb923c"},neutral:{border:`1px solid ${T.faint}`,bg:"transparent",dot:T.faint}}[s]||{border:`1px solid ${T.faint}`,bg:"transparent",dot:T.faint});

  const TABS=["overview","charts","ai-charts","sql","insights","clean","compare","chat","dashboard","export"];

  const frows=filteredRows();

  return(
    <div style={{minHeight:"100vh",background:T.bg,color:T.text,fontFamily:"'DM Mono','Fira Code',monospace",transition:"background 0.3s,color 0.3s"}}>
      {/* Header */}
      <div style={{borderBottom:`1px solid ${T.border}`,padding:"14px 28px",display:"flex",alignItems:"center",gap:14,background:T.surface,backdropFilter:"blur(8px)",position:"sticky",top:0,zIndex:50}}>
        <div style={{width:30,height:30,background:"linear-gradient(135deg,#6ee7b7,#818cf8)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15}}>◈</div>
        <div><div style={{fontWeight:700,fontSize:14,letterSpacing:"0.05em"}}>DATA ANALYTICS PLATFORM</div></div>

        {/* File tabs */}
        {files.length>0&&(
          <div style={{display:"flex",gap:4,marginLeft:8,overflowX:"auto"}}>
            {files.map((f,i)=>(
              <button key={i} onClick={()=>setActiveFile(i)} style={{padding:"4px 12px",borderRadius:6,border:`1px solid ${i===activeFile?"#6ee7b7":T.border}`,background:i===activeFile?"rgba(110,231,183,0.1)":"transparent",color:i===activeFile?"#6ee7b7":T.muted,fontSize:10,fontFamily:"inherit",cursor:"pointer",whiteSpace:"nowrap"}}>
                {f.name.slice(0,20)}{files.length>1&&<span onClick={e=>{e.stopPropagation();setFiles(fs=>fs.filter((_,fi)=>fi!==i));}} style={{marginLeft:6,opacity:0.5}}>✕</span>}
              </button>
            ))}
            <button onClick={()=>fileRef.current.click()} style={{padding:"4px 10px",borderRadius:6,border:`1px dashed ${T.border}`,background:"transparent",color:T.faint,fontSize:10,fontFamily:"inherit",cursor:"pointer"}}>+ Add CSV</button>
          </div>
        )}

        <div style={{marginLeft:"auto",display:"flex",gap:10,alignItems:"center"}}>
          {data&&<div style={{fontSize:11,color:T.faint,background:T.bg,border:`1px solid ${T.border}`,borderRadius:6,padding:"4px 10px"}}>◎ {data.rows.length.toLocaleString()} rows</div>}
          {/* Theme toggle */}
          <button onClick={()=>setTheme(t=>t==="dark"?"light":"dark")} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${T.border}`,background:T.bg,color:T.muted,cursor:"pointer",fontFamily:"inherit",fontSize:12}}>
            {theme==="dark"?"☀ Light":"☾ Dark"}
          </button>
        </div>
      </div>

      <div style={{maxWidth:1160,margin:"0 auto",padding:"22px 18px"}}>
        {!files.length?(
          <div onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={e=>{e.preventDefault();setDragOver(false);[...e.dataTransfer.files].forEach(onFile);}} onClick={()=>fileRef.current.click()} style={{border:`2px dashed ${dragOver?"#6ee7b7":T.border}`,borderRadius:16,padding:"80px 40px",textAlign:"center",cursor:"pointer",background:dragOver?"rgba(110,231,183,0.04)":T.surface,transition:"all 0.2s"}}>
            <input ref={fileRef} type="file" accept=".csv" multiple style={{display:"none"}} onChange={e=>[...e.target.files].forEach(onFile)}/>
            <div style={{fontSize:44,marginBottom:16,opacity:0.35}}>⬡</div>
            <div style={{fontSize:20,fontWeight:600,color:T.muted,marginBottom:8}}>Drop CSV files here</div>
            <div style={{fontSize:12,color:T.faint}}>supports multiple files · drag & drop or click to browse</div>
          </div>
        ):(
          <>
            <input ref={fileRef} type="file" accept=".csv" multiple style={{display:"none"}} onChange={e=>[...e.target.files].forEach(onFile)}/>

            {/* Tabs */}
            <div style={{display:"flex",gap:3,marginBottom:20,background:T.surface,borderRadius:10,padding:4,border:`1px solid ${T.border}`,overflowX:"auto",width:"fit-content",maxWidth:"100%"}}>
              {TABS.map(t=><button key={t} onClick={()=>setActiveTab(t)} style={{padding:"7px 13px",borderRadius:7,border:"none",cursor:"pointer",fontSize:10,fontFamily:"inherit",letterSpacing:"0.07em",fontWeight:700,textTransform:"uppercase",background:activeTab===t?T.bg:"transparent",color:activeTab===t?"#6ee7b7":T.faint,transition:"all 0.15s",whiteSpace:"nowrap"}}>{t.replace("-"," ")}</button>)}
            </div>

            {/* ── OVERVIEW ── */}
            {activeTab==="overview"&&data&&(
              <div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:18}}>
                  {[["ROWS",data.rows.length.toLocaleString(),"#6ee7b7"],["COLUMNS",data.headers.length,"#818cf8"],["NUMERIC",numCols.length,"#fb923c"],["TEXT",catCols.length,"#f472b6"]].map(([l,v,c])=>(
                    <div key={l} style={{...mkCard(T),padding:"16px 18px"}}><div style={{...mkLbl(T),marginBottom:5}}>{l}</div><div style={{fontSize:24,fontWeight:700,color:c}}>{v}</div></div>
                  ))}
                </div>

                {/* Search & Filter Bar */}
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
                      <thead><tr style={{background:T.bg}}>{["Column","Type","Mean","Min","Max","Std Dev","Median","Count"].map(h=><th key={h} style={{padding:"9px 14px",textAlign:"left",color:T.faint,fontWeight:500,fontSize:10,letterSpacing:"0.08em",borderBottom:`1px solid ${T.border}`}}>{h}</th>)}</tr></thead>
                      <tbody>{data.colTypes.map(col=>{const s=col.type==="number"?computeStats(data.rows,col.name):null;return(
                        <tr key={col.name} style={{borderBottom:`1px solid ${T.vfaint}`}}>
                          <td style={{padding:"9px 14px",color:T.text,fontWeight:600}}>{col.name}</td>
                          <td style={{padding:"9px 14px"}}><span style={{fontSize:10,padding:"2px 7px",borderRadius:4,background:col.type==="number"?"rgba(110,231,183,0.1)":"rgba(129,140,248,0.1)",color:col.type==="number"?"#6ee7b7":"#818cf8"}}>{col.type}</span></td>
                          {s?<><td style={{padding:"9px 14px",color:T.muted}}>{s.mean}</td><td style={{padding:"9px 14px",color:T.muted}}>{s.min}</td><td style={{padding:"9px 14px",color:T.muted}}>{s.max}</td><td style={{padding:"9px 14px",color:T.muted}}>{s.std}</td><td style={{padding:"9px 14px",color:T.muted}}>{s.median}</td><td style={{padding:"9px 14px",color:T.muted}}>{s.count}</td></>
                          :[...Array(6)].map((_,i)=><td key={i} style={{padding:"9px 14px",color:T.vfaint}}>—</td>)}
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

            {/* ── CHARTS ── */}
            {activeTab==="charts"&&data&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {["scatter","line","bar","pie","heatmap","histogram"].map(m=>(
                    <button key={m} onClick={()=>setChartMode(m)} style={{...mkBtn(chartMode===m,T),padding:"8px 16px",fontSize:10,background:chartMode===m?"linear-gradient(135deg,#6ee7b7,#818cf8)":T.surface,border:chartMode===m?"none":`1px solid ${T.border}`,color:chartMode===m?"#080f1a":T.faint}}>{m.toUpperCase()}</button>
                  ))}
                </div>
                <div style={{...mkCard(T),padding:22}}>
                  {chartMode==="scatter"&&(<><div style={{display:"flex",gap:12,marginBottom:16,flexWrap:"wrap"}}>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>X</div><select value={scatterX} onChange={e=>setScatterX(e.target.value)} style={mkSel(T)}>{numCols.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>Y</div><select value={scatterY} onChange={e=>setScatterY(e.target.value)} style={mkSel(T)}>{numCols.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>COLOR BY</div><select value={scatterC} onChange={e=>setScatterC(e.target.value)} style={mkSel(T)}><option value="">None</option>{catCols.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <button onClick={()=>addToDashboard({type:"scatter",xCol:scatterX,yCol:scatterY,colorCol:scatterC,title:`${scatterY} vs ${scatterX}`})} style={{...mkBtn(true,T),padding:"8px 14px",fontSize:10,alignSelf:"flex-end"}}>📌 Pin</button>
                  </div>{scatterX&&scatterY&&<ScatterPlot rows={data.rows} xCol={scatterX} yCol={scatterY} colorCol={scatterC} theme={theme}/>}</>)}

                  {chartMode==="line"&&(<><div style={{display:"flex",gap:12,marginBottom:16,flexWrap:"wrap"}}>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>X</div><select value={lineX} onChange={e=>setLineX(e.target.value)} style={mkSel(T)}>{numCols.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>Y</div><select value={lineY} onChange={e=>setLineY(e.target.value)} style={mkSel(T)}>{numCols.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <button onClick={()=>addToDashboard({type:"line",xCol:lineX,yCol:lineY,title:`${lineY} over ${lineX}`})} style={{...mkBtn(true,T),padding:"8px 14px",fontSize:10,alignSelf:"flex-end"}}>📌 Pin</button>
                  </div>{lineX&&lineY&&<LineChart rows={data.rows} xCol={lineX} yCol={lineY} theme={theme}/>}</>)}

                  {chartMode==="bar"&&(<><div style={{...mkLbl(T),marginBottom:14}}>CATEGORICAL DISTRIBUTIONS</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:18}}>
                      {catCols.slice(0,4).map((col,ci)=>{const cnt={};data.rows.forEach(r=>{const v=r[col.name]||"(empty)";cnt[v]=(cnt[v]||0)+1;});const sorted=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([label,count])=>({label,count}));
                        return<div key={col.name}><div style={{fontSize:11,color:T.muted,marginBottom:8,fontWeight:600,display:"flex",justifyContent:"space-between"}}>{col.name}<button onClick={()=>addToDashboard({type:"bar",col:col.name,title:`${col.name} distribution`,color:COLORS[ci%COLORS.length]})} style={{fontSize:10,background:"transparent",border:"none",color:T.faint,cursor:"pointer"}}>📌</button></div><BarChart data={sorted} labelKey="label" valueKey="count" color={COLORS[ci%COLORS.length]} theme={theme}/></div>;})}
                    </div></>)}

                  {chartMode==="pie"&&(<><div style={{display:"flex",gap:12,marginBottom:16,flexWrap:"wrap"}}>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>LABEL</div><select value={pieLabel} onChange={e=>setPieLabel(e.target.value)} style={mkSel(T)}>{data.colTypes.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{...mkLbl(T),marginBottom:5}}>VALUE</div><select value={pieValue} onChange={e=>setPieValue(e.target.value)} style={mkSel(T)}>{numCols.map(c=><option key={c.name}>{c.name}</option>)}</select></div>
                    <button onClick={()=>addToDashboard({type:"pie",labelCol:pieLabel,valueCol:pieValue,title:`${pieValue} by ${pieLabel}`})} style={{...mkBtn(true,T),padding:"8px 14px",fontSize:10,alignSelf:"flex-end"}}>📌 Pin</button>
                  </div>{pieLabel&&pieValue&&(()=>{const cnt={};data.rows.forEach(r=>{const k=r[pieLabel];const v=Number(r[pieValue])||0;cnt[k]=(cnt[k]||0)+v;});const d2=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([label,value])=>({label,value}));return<PieChart data={d2} labelKey="label" valueKey="value" theme={theme}/>;})()}</>)}

                  {chartMode==="heatmap"&&(<><div style={{...mkLbl(T),marginBottom:14}}>CORRELATION MATRIX</div><Heatmap rows={data.rows} colTypes={data.colTypes} theme={theme}/><div style={{marginTop:10,fontSize:11,color:T.faint}}>Green = positive · Red = negative</div></>)}

                  {chartMode==="histogram"&&(<><div style={{...mkLbl(T),marginBottom:14}}>ALL NUMERIC COLUMNS</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:16}}>
                      {numCols.slice(0,6).map(col=><div key={col.name}><div style={{fontSize:11,color:T.muted,marginBottom:8,fontWeight:600,display:"flex",justifyContent:"space-between"}}>{col.name}<button onClick={()=>addToDashboard({type:"histogram",col:col.name,title:`${col.name} distribution`})} style={{fontSize:10,background:"transparent",border:"none",color:T.faint,cursor:"pointer"}}>📌</button></div><Histogram rows={data.rows} col={col.name} theme={theme}/></div>)}
                    </div></>)}
                </div>
              </div>
            )}

            {/* ── AI CHARTS ── */}
            {activeTab==="ai-charts"&&data&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                {/* AI Chart Builder */}
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

                {/* Smart Suggestions */}
                <div style={{...mkCard(T),padding:22}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                    <div>
                      <div style={{...mkLbl(T),marginBottom:4}}>AI COLUMN SUGGESTIONS</div>
                      <div style={{fontSize:12,color:T.faint}}>AI recommends the most interesting visualizations for your data</div>
                    </div>
                    <button onClick={handleSuggestions} disabled={suggestionsLoading} style={mkBtn(!suggestionsLoading,T)}>{suggestionsLoading?"ANALYZING...":"GET SUGGESTIONS →"}</button>
                  </div>
                  {suggestions.length>0&&(
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:10}}>
                      {suggestions.map((s,i)=>(
                        <div key={i} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                            <span style={{fontSize:10,padding:"2px 7px",borderRadius:4,background:"rgba(129,140,248,0.1)",color:"#818cf8"}}>{s.type}</span>
                            <div style={{fontSize:12,fontWeight:700,color:T.text}}>{s.title}</div>
                          </div>
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
                  {genSQL&&<div style={{background:T.bg,borderRadius:8,padding:12,border:`1px solid ${T.border}`}}><div style={{...mkLbl(T),marginBottom:5}}>SQL</div><code style={{color:"#6ee7b7",fontSize:12,whiteSpace:"pre-wrap",wordBreak:"break-all"}}>{genSQL}</code></div>}
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
                    {nlResult.length>0&&sqlChartType!=="none"&&Object.keys(nlResult[0]).length===2&&(()=>{const keys=Object.keys(nlResult[0]);const numKey=keys.find(k=>!isNaN(Number(nlResult[0][k])));const lblKey=keys.find(k=>k!==numKey);return numKey&&lblKey?<div style={{padding:"16px 18px",borderBottom:`1px solid ${T.border}`}}>{sqlChartType==="bar"?<BarChart data={nlResult} labelKey={lblKey} valueKey={numKey} theme={theme}/>:<PieChart data={nlResult} labelKey={lblKey} valueKey={numKey} theme={theme}/>}</div>:null;})()}
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

                {/* Column Calculator */}
                <div style={{...mkCard(T),padding:18}}>
                  <div style={{...mkLbl(T),marginBottom:4}}>COLUMN CALCULATOR</div>
                  <div style={{fontSize:11,color:T.faint,marginBottom:12}}>Create new columns using formulas. Reference columns with [ColumnName]. Example: [Price] * [Quantity] or [Salary] / 12</div>
                  <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap"}}>
                    <input value={calcName} onChange={e=>setCalcName(e.target.value)} placeholder="New column name" style={{...mkInput(T),flex:"0 1 180px"}}/>
                    <span style={{color:T.faint,alignSelf:"center"}}>=</span>
                    <input value={calcFormula} onChange={e=>setCalcFormula(e.target.value)} placeholder="[Column1] * [Column2] + 100" style={mkInput(T)}/>
                  </div>
                  <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                    <div style={{fontSize:11,color:T.faint}}>Available: {data.headers.slice(0,6).map(h=>`[${h}]`).join(", ")}</div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={handleCalcPreview} style={{...mkBtn(true,T),padding:"8px 14px",fontSize:10,background:T.bg,border:`1px solid ${T.border}`,color:T.muted}}>PREVIEW</button>
                    <button onClick={handleCalcApply} style={{...mkBtn(!!calcName&&!!calcFormula,T),padding:"8px 16px",fontSize:10}}>ADD COLUMN</button>
                  </div>
                  {calcError&&<div style={{color:"#fb923c",fontSize:11,marginTop:8}}>{calcError}</div>}
                  {calcPreview&&(
                    <div style={{marginTop:12,overflowX:"auto"}}>
                      <div style={{fontSize:10,color:T.faint,marginBottom:6}}>PREVIEW (first 5 rows)</div>
                      <table style={{borderCollapse:"collapse",fontSize:11}}>
                        <thead><tr>{Object.keys(calcPreview[0]).slice(-3).map(h=><th key={h} style={{padding:"6px 10px",color:T.faint,textAlign:"left",borderBottom:`1px solid ${T.border}`,background:T.bg}}>{h}</th>)}</tr></thead>
                        <tbody>{calcPreview.map((r,i)=><tr key={i}>{Object.entries(r).slice(-3).map(([k,v])=><td key={k} style={{padding:"6px 10px",color:k===calcName?"#6ee7b7":T.muted,borderBottom:`1px solid ${T.vfaint}`}}>{String(v).slice(0,20)}</td>)}</tr>)}</tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div style={{...mkCard(T),padding:16}}>
                  <div style={{...mkLbl(T),marginBottom:10}}>CHANGE LOG</div>
                  {cleanLog.length?<div style={{display:"flex",flexDirection:"column",gap:5}}>{cleanLog.map((l,i)=><div key={i} style={{fontSize:12,color:"#6ee7b7",padding:"5px 10px",background:T.bg,borderRadius:6}}>{l}</div>)}</div>:<div style={{fontSize:12,color:T.faint}}>No changes yet.</div>}
                </div>
              </div>
            )}

            {/* ── COMPARE ── */}
            {activeTab==="compare"&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                {files.length<2?(
                  <div style={{...mkCard(T),padding:40,textAlign:"center"}}>
                    <div style={{fontSize:32,marginBottom:12,opacity:0.3}}>⇄</div>
                    <div style={{fontSize:14,color:T.muted,marginBottom:8}}>Load at least 2 CSV files to compare</div>
                    <div style={{fontSize:12,color:T.faint,marginBottom:16}}>Use the "+ Add CSV" button in the header to load a second file</div>
                    <button onClick={()=>fileRef.current.click()} style={mkBtn(true,T)}>LOAD SECOND FILE</button>
                  </div>
                ):(
                  <>
                    <div style={{...mkCard(T),padding:20}}>
                      <div style={{...mkLbl(T),marginBottom:14}}>SELECT FILES TO COMPARE</div>
                      <div style={{display:"flex",gap:16,alignItems:"center",flexWrap:"wrap",marginBottom:16}}>
                        <div><div style={{...mkLbl(T),marginBottom:6}}>FILE A</div><select value={compareA} onChange={e=>setCompareA(Number(e.target.value))} style={mkSel(T)}>{files.map((f,i)=><option key={i} value={i}>{f.name}</option>)}</select></div>
                        <div style={{fontSize:20,color:T.faint,marginTop:16}}>⇄</div>
                        <div><div style={{...mkLbl(T),marginBottom:6}}>FILE B</div><select value={compareB} onChange={e=>setCompareB(Number(e.target.value))} style={mkSel(T)}>{files.map((f,i)=><option key={i} value={i}>{f.name}</option>)}</select></div>
                        <button onClick={handleCompare} disabled={compareLoading||compareA===compareB} style={{...mkBtn(!compareLoading&&compareA!==compareB,T),alignSelf:"flex-end"}}>{compareLoading?"COMPARING...":"COMPARE →"}</button>
                      </div>

                      {/* Side by side stats */}
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                        {[compareA,compareB].map((fi,idx)=>{const f=files[fi];if(!f)return null;const nums=f.colTypes.filter(c=>c.type==="number");return(
                          <div key={idx} style={{background:T.bg,borderRadius:10,padding:16,border:`1px solid ${T.border}`}}>
                            <div style={{fontSize:12,fontWeight:700,color:idx===0?"#6ee7b7":"#818cf8",marginBottom:12}}>{f.name}</div>
                            <div style={{display:"flex",gap:10,marginBottom:12,flexWrap:"wrap"}}>
                              {[["Rows",f.rows.length],["Cols",f.headers.length],["Numeric",nums.length]].map(([l,v])=><div key={l} style={{background:T.surface,borderRadius:6,padding:"8px 12px"}}><div style={{fontSize:9,color:T.faint}}>{l}</div><div style={{fontSize:16,fontWeight:700,color:T.text}}>{v}</div></div>)}
                            </div>
                            {nums.slice(0,4).map(c=>{const s=computeStats(f.rows,c.name);return s?(<div key={c.name} style={{display:"flex",justifyContent:"space-between",fontSize:11,color:T.muted,marginBottom:4,padding:"4px 0",borderBottom:`1px solid ${T.vfaint}`}}><span>{c.name}</span><span style={{color:T.text}}>μ={s.mean} σ={s.std}</span></div>):null;})}
                          </div>
                        );})}
                      </div>
                    </div>

                    {compareResult&&(
                      <div style={{...mkCard(T),padding:20}}>
                        <div style={{...mkLbl(T),marginBottom:14}}>AI COMPARISON ANALYSIS</div>
                        <div style={{fontSize:13,color:T.muted,lineHeight:1.7,marginBottom:16,padding:14,background:T.bg,borderRadius:8,border:`1px solid ${T.border}`}}>{compareResult.summary}</div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
                          <div style={{background:"rgba(52,211,153,0.08)",border:"1px solid #34d399",borderRadius:10,padding:16}}>
                            <div style={{fontSize:11,fontWeight:700,color:"#34d399",marginBottom:10}}>SIMILARITIES</div>
                            {(compareResult.similarities||[]).map((s,i)=><div key={i} style={{fontSize:12,color:T.muted,marginBottom:6,paddingLeft:8,borderLeft:"2px solid #34d399"}}>• {s}</div>)}
                          </div>
                          <div style={{background:"rgba(251,146,60,0.08)",border:"1px solid #fb923c",borderRadius:10,padding:16}}>
                            <div style={{fontSize:11,fontWeight:700,color:"#fb923c",marginBottom:10}}>DIFFERENCES</div>
                            {(compareResult.differences||[]).map((s,i)=><div key={i} style={{fontSize:12,color:T.muted,marginBottom:6,paddingLeft:8,borderLeft:"2px solid #fb923c"}}>• {s}</div>)}
                          </div>
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
                  <div>
                    <input value={dashboardName} onChange={e=>setDashboardName(e.target.value)} placeholder="Dashboard name..." style={{...mkInput(T),flex:"0 1 220px",fontSize:13}}/>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>setDashboardCharts([])} style={{...mkBtn(false,T),padding:"9px 14px",fontSize:10}}>CLEAR ALL</button>
                  </div>
                </div>

                {dashboardCharts.length===0?(
                  <div style={{...mkCard(T),padding:60,textAlign:"center"}}>
                    <div style={{fontSize:36,marginBottom:12,opacity:0.2}}>📌</div>
                    <div style={{fontSize:14,color:T.muted,marginBottom:6}}>Your dashboard is empty</div>
                    <div style={{fontSize:12,color:T.faint}}>Go to Charts or AI Charts tab and click the 📌 pin button on any chart to add it here</div>
                  </div>
                ):(
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(440px,1fr))",gap:16}}>
                    {dashboardCharts.map((chart,i)=>(
                      <div key={chart.id} style={{...mkCard(T),padding:20}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                          <div>
                            <div style={{fontSize:13,fontWeight:700,color:T.text}}>{chart.title||"Chart"}</div>
                            <div style={{fontSize:10,color:T.faint}}>{chart.fileName} · {chart.type}</div>
                          </div>
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
                  {[
                    {icon:"📄",label:"Export CSV",desc:`All ${data.rows.length} rows`,color:"#6ee7b7",fn:()=>exportCSV()},
                    {icon:"📊",label:"PDF Report",desc:"Stats + insights + preview",color:"#818cf8",fn:exportPDF},
                    {icon:"📋",label:"Copy Report",desc:"Copy summary to clipboard",color:"#fb923c",fn:copyReport},
                    {icon:"🔍",label:"Export Filtered",desc:`${frows.length} filtered rows`,color:"#f472b6",fn:()=>exportCSV(frows)},
                  ].map(op=>(
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
