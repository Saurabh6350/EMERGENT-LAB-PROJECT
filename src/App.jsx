import { useState, useRef, useCallback, useEffect } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const GROQ_MODEL  = "llama-3.3-70b-versatile";
const API_KEY     = process.env.REACT_APP_GROQ_API_KEY || "";
const PALETTE     = ["#6366f1","#10b981","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#f97316","#ec4899","#14b8a6","#84cc16"];
const SOFT        = ["#e0e7ff","#d1fae5","#fef3c7","#fee2e2","#ede9fe","#cffafe","#ffedd5","#fce7f3","#ccfbf1","#ecfccb"];
const TABS        = ["overview","charts","ai charts","sql","insights","report","pivot","clean","compare","chat","dashboard","export"];

// ─── Utility Functions ────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  const rows = lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = []; let cur = "", inQ = false;
    for (let ch of line) { if (ch === '"') inQ = !inQ; else if (ch === "," && !inQ) { vals.push(cur.trim()); cur = ""; } else cur += ch; }
    vals.push(cur.trim());
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
  });
  return { headers, rows };
}

function parseXLSX(buffer) {
  // Simple XLSX parser - reads first sheet
  try {
    const XLSX = window.XLSX;
    if (!XLSX) return null;
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!data.length) return null;
    const headers = data[0].map(h => String(h).trim());
    const rows = data.slice(1).filter(r => r.some(v => v !== "")).map(row =>
      Object.fromEntries(headers.map((h, i) => [h, String(row[i] ?? "")]))
    );
    return { headers, rows };
  } catch { return null; }
}

function rowsToCSV(rows) {
  if (!rows.length) return "";
  const h = Object.keys(rows[0]);
  return [h.join(","), ...rows.map(r => h.map(k => `"${(r[k] ?? "").toString().replace(/"/g, '""')}"`).join(","))].join("\n");
}

function inferTypes(headers, rows) {
  return headers.map(h => {
    const vals = rows.map(r => r[h]).filter(v => v !== "" && v != null);
    const n = vals.filter(v => !isNaN(Number(v))).length;
    const isDate = vals.slice(0, 10).filter(v => !isNaN(Date.parse(v)) && isNaN(Number(v))).length > 5;
    return { name: h, type: n / vals.length > 0.8 ? "number" : isDate ? "date" : "string" };
  });
}

function computeStats(rows, col) {
  const vals = rows.map(r => Number(r[col])).filter(v => !isNaN(v));
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  return {
    mean: +mean.toFixed(2), min: +sorted[0], max: +sorted[sorted.length - 1],
    median: +sorted[Math.floor(sorted.length / 2)], std: +Math.sqrt(variance).toFixed(2),
    count: vals.length, q1: +sorted[Math.floor(sorted.length * 0.25)],
    q3: +sorted[Math.floor(sorted.length * 0.75)], sum: +vals.reduce((s, v) => s + v, 0).toFixed(2)
  };
}

function fmt(n, prefix = "") {
  if (n === undefined || n === null || isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return prefix + (n / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return prefix + (n / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return prefix + (n / 1e3).toFixed(1) + "K";
  return prefix + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  const am = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const bm = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const num = a.slice(0, n).reduce((s, v, i) => s + (v - am) * (b[i] - bm), 0);
  const da = Math.sqrt(a.slice(0, n).reduce((s, v) => s + (v - am) ** 2, 0));
  const db = Math.sqrt(b.slice(0, n).reduce((s, v) => s + (v - bm) ** 2, 0));
  return da && db ? +(num / (da * db)).toFixed(3) : 0;
}

function evalFormula(formula, row) {
  try {
    const expr = formula.replace(/\[([^\]]+)\]/g, (_, col) => {
      const v = Number(row[col]); return isNaN(v) ? `"${row[col]}"` : v;
    });
    // eslint-disable-next-line no-new-func
    return Function(`"use strict";return(${expr})`)();
  } catch { return ""; }
}

function executeSQL(sql, rows) {
  let result = [...rows];
  const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+GROUP BY|\s+ORDER BY|\s+LIMIT|$)/i);
  if (whereMatch) {
    const m = whereMatch[1].trim().match(/(\w+)\s*(=|!=|>|<|>=|<=|LIKE)\s*'?([^']+)'?/i);
    if (m) {
      const [, col, op, val] = m;
      result = result.filter(r => {
        const rv = r[col]; const nv = Number(val);
        if (op === "=") return rv == val; if (op === "!=") return rv != val;
        if (op === ">") return Number(rv) > nv; if (op === "<") return Number(rv) < nv;
        if (op === ">=") return Number(rv) >= nv; if (op === "<=") return Number(rv) <= nv;
        if (op.toUpperCase() === "LIKE") return String(rv).toLowerCase().includes(val.toLowerCase().replace(/%/g, ""));
        return true;
      });
    }
  }
  const groupMatch = sql.match(/GROUP BY\s+(\w+)/i);
  const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);
  if (groupMatch && selectMatch) {
    const groupCol = groupMatch[1];
    const aggMatch = selectMatch[1].match(/(COUNT|SUM|AVG|MAX|MIN)\((\*|\w+)\)/i);
    const groups = {};
    result.forEach(r => { const k = r[groupCol]; if (!groups[k]) groups[k] = []; groups[k].push(r); });
    return Object.entries(groups).map(([k, grp]) => {
      const row = { [groupCol]: k };
      if (aggMatch) {
        const [, fn, col] = aggMatch;
        const vals = grp.map(r => Number(r[col === "*" ? Object.keys(r)[0] : col])).filter(v => !isNaN(v));
        if (fn === "COUNT") row["COUNT"] = grp.length;
        else if (fn === "SUM") row[`SUM(${col})`] = +vals.reduce((s, v) => s + v, 0).toFixed(2);
        else if (fn === "AVG") row[`AVG(${col})`] = +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2);
        else if (fn === "MAX") row[`MAX(${col})`] = Math.max(...vals);
        else if (fn === "MIN") row[`MIN(${col})`] = Math.min(...vals);
      }
      return row;
    });
  }
  const orderMatch = sql.match(/ORDER BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
  if (orderMatch) {
    const [, col, dir] = orderMatch;
    result.sort((a, b) => { const d = isNaN(Number(a[col])) ? String(a[col]).localeCompare(String(b[col])) : Number(a[col]) - Number(b[col]); return dir?.toUpperCase() === "DESC" ? -d : d; });
  }
  const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
  if (limitMatch) result = result.slice(0, Number(limitMatch[1]));
  if (selectMatch && !sql.toUpperCase().includes("GROUP BY")) {
    const cols = selectMatch[1].split(",").map(c => c.trim());
    if (!cols.includes("*")) result = result.map(r => Object.fromEntries(cols.map(c => [c, r[c]])));
  }
  return result;
}

async function callAI(messages, system = "") {
  const msgs = [];
  if (system) msgs.push({ role: "system", content: system });
  messages.forEach(m => msgs.push({ role: m.role === "user" ? "user" : "assistant", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }));
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages: msgs, temperature: 0.7, max_tokens: 2000 })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices?.[0]?.message?.content || "";
}

// ─── Chart Components ─────────────────────────────────────────────────────────
function HBarChart({ data, labelKey, valueKey, color = "#6366f1" }) {
  const max = Math.max(...data.map(d => Number(d[valueKey]) || 0)) || 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {data.slice(0, 14).map((d, i) => {
        const val = Number(d[valueKey]) || 0; const pct = (val / max) * 100;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 150, fontSize: 12, color: "#374151", textAlign: "right", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(d[labelKey]).slice(0, 22)}</div>
            <div style={{ flex: 1, background: "#f3f4f6", borderRadius: 6, height: 28, position: "relative", overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, background: color, height: "100%", borderRadius: 6, transition: "width 0.8s" }} />
              <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", fontSize: 11, fontWeight: 600, color: "#374151" }}>{fmt(val)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VBarChart({ data, labelKey, valueKey }) {
  const max = Math.max(...data.map(d => Number(d[valueKey]) || 0)) || 1;
  const W = 500, H = 220, PAD = { t: 10, r: 20, b: 50, l: 50 };
  const bW = Math.min(44, (W - PAD.l - PAD.r) / data.slice(0, 10).length - 4);
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W, display: "block" }}>
        {[0, 0.25, 0.5, 0.75, 1].map(t => { const y = PAD.t + (1 - t) * (H - PAD.t - PAD.b); return (<g key={t}><line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="#f3f4f6" strokeWidth={1} /><text x={PAD.l - 6} y={y + 4} fontSize={10} fill="#9ca3af" textAnchor="end">{fmt(max * t)}</text></g>); })}
        {data.slice(0, 10).map((d, i) => {
          const val = Number(d[valueKey]) || 0; const pct = val / max;
          const x = PAD.l + i * ((W - PAD.l - PAD.r) / Math.min(data.length, 10));
          const bH = (H - PAD.t - PAD.b) * pct; const y = H - PAD.b - bH;
          return (<g key={i}>
            <rect x={x + 2} y={y} width={bW} height={bH} rx={4} fill={PALETTE[i % PALETTE.length]} opacity={0.9} />
            {bH > 18 && <text x={x + 2 + bW / 2} y={y + 14} fontSize={10} fill="#fff" textAnchor="middle" fontWeight="600">{fmt(val)}</text>}
            <text x={x + 2 + bW / 2} y={H - PAD.b + 16} fontSize={10} fill="#6b7280" textAnchor="middle">{String(d[labelKey]).slice(0, 8)}</text>
          </g>);
        })}
      </svg>
    </div>
  );
}

function PieChart({ data, labelKey, valueKey, donut = false }) {
  const total = data.reduce((s, d) => s + (Number(d[valueKey]) || 0), 0) || 1;
  let angle = -Math.PI / 2; const R = 90, cx = 110, cy = 110, ir = donut ? 52 : 0;
  const slices = data.slice(0, 8).map((d, i) => {
    const val = Number(d[valueKey]) || 0; const frac = val / total;
    const start = angle; angle += frac * 2 * Math.PI;
    const x1 = cx + Math.cos(start) * R, y1 = cy + Math.sin(start) * R;
    const x2 = cx + Math.cos(angle) * R, y2 = cy + Math.sin(angle) * R;
    const ix1 = cx + Math.cos(start) * ir, iy1 = cy + Math.sin(start) * ir;
    const ix2 = cx + Math.cos(angle) * ir, iy2 = cy + Math.sin(angle) * ir;
    const path = donut
      ? `M${ix1},${iy1} L${x1},${y1} A${R},${R} 0 ${frac > 0.5 ? 1 : 0},1 ${x2},${y2} L${ix2},${iy2} A${ir},${ir} 0 ${frac > 0.5 ? 1 : 0},0 ${ix1},${iy1} Z`
      : `M${cx},${cy} L${x1},${y1} A${R},${R} 0 ${frac > 0.5 ? 1 : 0},1 ${x2},${y2} Z`;
    return { path, color: PALETTE[i % PALETTE.length], label: d[labelKey], val, pct: (frac * 100).toFixed(1) };
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
      <svg viewBox="0 0 220 220" style={{ width: 180, flexShrink: 0 }}>
        {slices.map((s, i) => <path key={i} d={s.path} fill={s.color} stroke="#fff" strokeWidth={2} />)}
        {donut && <circle cx={cx} cy={cy} r={ir - 1} fill="#fff" />}
        {donut && <text x={cx} y={cy - 6} textAnchor="middle" fontSize={11} fill="#6b7280">Total</text>}
        {donut && <text x={cx} y={cy + 12} textAnchor="middle" fontSize={14} fill="#111827" fontWeight="700">{fmt(total)}</text>}
      </svg>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 120 }}>
        {slices.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <div style={{ fontSize: 12, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(s.label).slice(0, 20)}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#111827" }}>{s.pct}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineChart({ data, xKey, yKey, color = "#6366f1" }) {
  if (!data || data.length < 2) return <div style={{ color: "#9ca3af", padding: 20, fontSize: 13 }}>Need at least 2 data points</div>;
  const pts = [...data].filter(d => !isNaN(Number(d[xKey])) && !isNaN(Number(d[yKey]))).sort((a, b) => Number(a[xKey]) - Number(b[xKey])).slice(0, 300);
  if (pts.length < 2) return <div style={{ color: "#9ca3af", padding: 20 }}>Not enough numeric data</div>;
  const xVals = pts.map(d => Number(d[xKey])), yVals = pts.map(d => Number(d[yKey]));
  const xMin = Math.min(...xVals), xMax = Math.max(...xVals) || 1;
  const yMin = Math.min(...yVals) * 0.95, yMax = Math.max(...yVals) * 1.05;
  const W = 500, H = 220, PAD = { t: 10, r: 20, b: 40, l: 55 };
  const toX = v => PAD.l + (v - xMin) / (xMax - xMin || 1) * (W - PAD.l - PAD.r);
  const toY = v => H - PAD.b - (v - yMin) / (yMax - yMin || 1) * (H - PAD.t - PAD.b);
  const path = "M " + pts.map(d => `${toX(Number(d[xKey]))},${toY(Number(d[yKey]))}`).join(" L ");
  const area = `${path} L ${toX(xVals[xVals.length - 1])},${H - PAD.b} L ${toX(xVals[0])},${H - PAD.b} Z`;
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W, display: "block" }}>
        <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.15" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        {[0, 0.25, 0.5, 0.75, 1].map(t => { const y = PAD.t + t * (H - PAD.t - PAD.b); const val = yMax - t * (yMax - yMin); return (<g key={t}><line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="#f3f4f6" strokeWidth={1} /><text x={PAD.l - 6} y={y + 4} fontSize={10} fill="#9ca3af" textAnchor="end">{fmt(val)}</text></g>); })}
        <path d={area} fill="url(#lg)" />
        <path d={path} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {pts.length <= 20 && pts.map((d, i) => <circle key={i} cx={toX(Number(d[xKey]))} cy={toY(Number(d[yKey]))} r={4} fill="#fff" stroke={color} strokeWidth={2} />)}
      </svg>
    </div>
  );
}

function ScatterPlot({ rows, xCol, yCol, colorCol }) {
  const xVals = rows.map(r => Number(r[xCol])).filter(v => !isNaN(v));
  const yVals = rows.map(r => Number(r[yCol])).filter(v => !isNaN(v));
  if (!xVals.length || !yVals.length) return <div style={{ color: "#9ca3af", padding: 20 }}>Select numeric columns</div>;
  const xMin = Math.min(...xVals), xMax = Math.max(...xVals) || 1;
  const yMin = Math.min(...yVals), yMax = Math.max(...yVals) || 1;
  const W = 500, H = 280, PAD = { t: 10, r: 20, b: 45, l: 55 };
  const toX = v => PAD.l + (v - xMin) / (xMax - xMin || 1) * (W - PAD.l - PAD.r);
  const toY = v => H - PAD.b - (v - yMin) / (yMax - yMin || 1) * (H - PAD.t - PAD.b);
  const cats = [...new Set(rows.map(r => r[colorCol]))];
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W, display: "block" }}>
        {[0, 0.25, 0.5, 0.75, 1].map(t => { const y = PAD.t + (1 - t) * (H - PAD.t - PAD.b); return (<g key={t}><line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="#f3f4f6" strokeWidth={1} /><text x={PAD.l - 6} y={y + 4} fontSize={10} fill="#9ca3af" textAnchor="end">{fmt(yMin + t * (yMax - yMin))}</text></g>); })}
        {[0, 0.25, 0.5, 0.75, 1].map(t => { const x = PAD.l + t * (W - PAD.l - PAD.r); return (<g key={t}><line x1={x} y1={PAD.t} x2={x} y2={H - PAD.b} stroke="#f3f4f6" strokeWidth={1} /><text x={x} y={H - PAD.b + 14} fontSize={10} fill="#9ca3af" textAnchor="middle">{fmt(xMin + t * (xMax - xMin))}</text></g>); })}
        {rows.slice(0, 600).map((r, i) => { const x = toX(Number(r[xCol])); const y = toY(Number(r[yCol])); if (isNaN(x) || isNaN(y)) return null; const ci = cats.indexOf(r[colorCol]); return <circle key={i} cx={x} cy={y} r={4} fill={PALETTE[ci >= 0 ? ci % PALETTE.length : 0]} opacity={0.65} stroke="#fff" strokeWidth={0.5} />; })}
        <text x={W / 2} y={H - 4} fontSize={11} fill="#6b7280" textAnchor="middle" fontWeight="500">{xCol}</text>
        <text x={12} y={H / 2} fontSize={11} fill="#6b7280" textAnchor="middle" transform={`rotate(-90,12,${H / 2})`}>{yCol}</text>
      </svg>
    </div>
  );
}

function Heatmap({ rows, colTypes }) {
  const numCols = colTypes.filter(c => c.type === "number").slice(0, 8);
  if (numCols.length < 2) return <div style={{ color: "#9ca3af", padding: 20 }}>Need at least 2 numeric columns</div>;
  const vals = numCols.map(c => rows.map(r => Number(r[c.name])).filter(v => !isNaN(v)));
  const corr = numCols.map((_, i) => numCols.map((_, j) => pearson(vals[i], vals[j])));
  const cell = 58, pad = { t: 80, l: 120 };
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${pad.l + numCols.length * cell + 20} ${pad.t + numCols.length * cell + 20}`} style={{ width: "100%", display: "block" }}>
        {numCols.map((col, i) => <text key={i} x={pad.l + i * cell + cell / 2} y={pad.t - 8} fontSize={10} fill="#6b7280" textAnchor="middle" transform={`rotate(-40,${pad.l + i * cell + cell / 2},${pad.t - 8})`}>{col.name.slice(0, 12)}</text>)}
        {corr.map((row, i) => row.map((val, j) => {
          const abs = Math.abs(val); const r = val > 0 ? 67 : 239; const g = val > 0 ? 99 : 68; const b = val > 0 ? 209 : 68; const a = 0.1 + abs * 0.85;
          return (<g key={`${i}-${j}`}><rect x={pad.l + j * cell} y={pad.t + i * cell} width={cell} height={cell} rx={4} fill={`rgba(${r},${g},${b},${a})`} stroke="#fff" strokeWidth={2} /><text x={pad.l + j * cell + cell / 2} y={pad.t + i * cell + cell / 2 + 5} fontSize={11} fill={abs > 0.4 ? "#fff" : "#374151"} textAnchor="middle" fontWeight="600">{val.toFixed(2)}</text></g>);
        }))}
        {numCols.map((col, i) => <text key={i} x={pad.l - 8} y={pad.t + i * cell + cell / 2 + 4} fontSize={10} fill="#6b7280" textAnchor="end">{col.name.slice(0, 14)}</text>)}
      </svg>
    </div>
  );
}

function Histogram({ rows, col }) {
  const vals = rows.map(r => Number(r[col])).filter(v => !isNaN(v));
  if (!vals.length) return null;
  const bins = 14, min = Math.min(...vals), max = Math.max(...vals), step = (max - min) / bins || 1;
  const buckets = Array.from({ length: bins }, (_, i) => ({ label: (min + i * step).toFixed(1), count: 0 }));
  vals.forEach(v => { const idx = Math.min(Math.floor((v - min) / step), bins - 1); buckets[idx].count++; });
  const maxC = Math.max(...buckets.map(b => b.count)) || 1;
  const W = 500, H = 210, PAD = { t: 10, r: 20, b: 40, l: 50 }; const bW = (W - PAD.l - PAD.r) / bins;
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W, display: "block" }}>
        {[0, 0.25, 0.5, 0.75, 1].map(t => { const y = PAD.t + (1 - t) * (H - PAD.t - PAD.b); return (<g key={t}><line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="#f3f4f6" strokeWidth={1} /><text x={PAD.l - 6} y={y + 4} fontSize={10} fill="#9ca3af" textAnchor="end">{Math.round(maxC * t)}</text></g>); })}
        {buckets.map((b, i) => { const bH = (b.count / maxC) * (H - PAD.t - PAD.b); const x = PAD.l + i * bW; const y = H - PAD.b - bH; return (<g key={i}><rect x={x + 1} y={y} width={bW - 2} height={bH} rx={3} fill="#6366f1" opacity={0.75} />{i % 3 === 0 && <text x={x + bW / 2} y={H - PAD.b + 14} fontSize={9} fill="#9ca3af" textAnchor="middle">{Number(b.label).toFixed(0)}</text>}</g>); })}
      </svg>
    </div>
  );
}

function BoxPlot({ rows, cols }) {
  const numCols = cols.filter(c => c.type === "number").slice(0, 6);
  if (!numCols.length) return null;
  const datasets = numCols.map(c => ({ name: c.name, s: computeStats(rows, c.name) })).filter(d => d.s);
  const allVals = datasets.flatMap(d => [d.s.min, d.s.max]);
  const gMin = Math.min(...allVals), gMax = Math.max(...allVals) || 1;
  const W = 500, H = 44 * datasets.length + 60, PAD = { t: 30, r: 30, b: 30, l: 170 };
  const toX = v => PAD.l + (v - gMin) / (gMax - gMin || 1) * (W - PAD.l - PAD.r);
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W, display: "block" }}>
        {[0, 0.25, 0.5, 0.75, 1].map(t => { const x = PAD.l + t * (W - PAD.l - PAD.r); const val = gMin + t * (gMax - gMin); return (<g key={t}><line x1={x} y1={PAD.t - 10} x2={x} y2={H - PAD.b} stroke="#f3f4f6" strokeWidth={1} /><text x={x} y={PAD.t - 14} fontSize={10} fill="#9ca3af" textAnchor="middle">{fmt(val)}</text></g>); })}
        {datasets.map((d, i) => { const y = PAD.t + i * 44 + 22; const { min, q1, median, q3, max } = d.s; return (<g key={i}><text x={PAD.l - 8} y={y + 4} fontSize={11} fill="#374151" textAnchor="end">{d.name.slice(0, 22)}</text><line x1={toX(min)} y1={y} x2={toX(q1)} y2={y} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} strokeDasharray="3,2" /><rect x={toX(q1)} y={y - 13} width={toX(q3) - toX(q1)} height={26} rx={4} fill={SOFT[i % SOFT.length]} stroke={PALETTE[i % PALETTE.length]} strokeWidth={1.5} /><line x1={toX(median)} y1={y - 13} x2={toX(median)} y2={y + 13} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2.5} /><line x1={toX(q3)} y1={y} x2={toX(max)} y2={y} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} strokeDasharray="3,2" /><line x1={toX(min)} y1={y - 7} x2={toX(min)} y2={y + 7} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} /><line x1={toX(max)} y1={y - 7} x2={toX(max)} y2={y + 7} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} /></g>); })}
      </svg>
    </div>
  );
}

function FunnelChart({ data, labelKey, valueKey }) {
  const sorted = [...data].sort((a, b) => (Number(b[valueKey]) || 0) - (Number(a[valueKey]) || 0)).slice(0, 7);
  const maxV = Number(sorted[0]?.[valueKey]) || 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
      {sorted.map((d, i) => {
        const val = Number(d[valueKey]) || 0; const pct = (val / maxV) * 100;
        const prev = i > 0 ? Number(sorted[i - 1][valueKey]) || 1 : maxV;
        const drop = i > 0 ? (((prev - val) / prev) * 100).toFixed(0) : null;
        return (
          <div key={i} style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
            {drop && <div style={{ fontSize: 11, color: "#ef4444", marginBottom: 2 }}>▼ {drop}% drop</div>}
            <div style={{ width: `${pct}%`, background: PALETTE[i % PALETTE.length], borderRadius: 6, padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", minWidth: 120, transition: "width 0.8s" }}>
              <span style={{ fontSize: 12, color: "#fff", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(d[labelKey]).slice(0, 20)}</span>
              <span style={{ fontSize: 12, color: "#fff", fontWeight: 700, marginLeft: 8, flexShrink: 0 }}>{fmt(val)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── AI Analysis Block ────────────────────────────────────────────────────────
function AIBlock({ text, loading, label = "AI Analysis" }) {
  if (loading) return (
    <div style={{ background: "#f0f4ff", border: "1px solid #c7d2fe", borderRadius: 12, padding: 16, marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#6366f1", animation: "pulse2 1.2s infinite" }} />
        <span style={{ fontSize: 12, color: "#4338ca", fontWeight: 600 }}>Generating analysis...</span>
      </div>
      {[100, 85, 92, 78].map((w, i) => <div key={i} style={{ height: 8, background: "#c7d2fe", borderRadius: 4, width: `${w}%`, marginBottom: 7, animation: `pulse2 1.4s ease-in-out ${i * 0.15}s infinite` }} />)}
    </div>
  );
  if (!text) return null;
  return (
    <div style={{ background: "#f0f4ff", border: "1px solid #c7d2fe", borderRadius: 12, padding: 16, marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <div style={{ width: 22, height: 22, borderRadius: 6, background: "#6366f1", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#fff" }}>✦</div>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#4338ca", letterSpacing: "0.04em" }}>{label}</span>
      </div>
      <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.8, whiteSpace: "pre-wrap" }}>{text}</div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [files, setFiles] = useState([]);
  const [activeFile, setActiveFile] = useState(0);
  const data = files[activeFile] || null;
  const [activeTab, setActiveTab] = useState("overview");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();

  const [theme, setTheme] = useState("light");
  const isDark = theme === "dark";
  const T = {
    bg: isDark ? "#0f172a" : "#f8fafc", surface: isDark ? "#1e293b" : "#ffffff",
    border: isDark ? "#334155" : "#e5e7eb", txt: isDark ? "#f1f5f9" : "#111827",
    muted: isDark ? "#94a3b8" : "#6b7280", faint: isDark ? "#1e293b" : "#f9fafb",
    input: isDark ? "#0f172a" : "#ffffff"
  };
  const card = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: 24, boxShadow: isDark ? "none" : "0 1px 3px rgba(0,0,0,0.06)" };
  const lbl = { fontSize: 11, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600 };
  const inp = { background: T.input, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px", color: T.txt, fontSize: 13, fontFamily: "inherit", outline: "none", width: "100%" };
  const sel = { background: T.input, border: `1px solid ${T.border}`, borderRadius: 8, padding: "9px 12px", color: T.muted, fontSize: 12, fontFamily: "inherit", outline: "none" };
  const btnP = { padding: "10px 22px", background: "linear-gradient(135deg,#6366f1,#8b5cf6)", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, cursor: "pointer", fontSize: 12, fontFamily: "inherit" };
  const btnS = { padding: "9px 18px", background: "transparent", border: `1px solid ${T.border}`, borderRadius: 8, color: T.muted, fontWeight: 600, cursor: "pointer", fontSize: 12, fontFamily: "inherit" };

  // State - SQL
  const [nlQuery, setNlQuery] = useState("");
  const [nlResult, setNlResult] = useState(null);
  const [genSQL, setGenSQL] = useState("");
  const [nlLoading, setNlLoading] = useState(false);
  const [sqlAnalysis, setSqlAnalysis] = useState("");
  const [sqlAnalysisLoading, setSqlAnalysisLoading] = useState(false);
  const [sqlHistory, setSqlHistory] = useState([]);

  // State - Insights
  const [insights, setInsights] = useState({});
  const [insightsLoading, setInsightsLoading] = useState(false);

  // State - Charts
  const [chartMode, setChartMode] = useState("hbar");
  const [scatterX, setScatterX] = useState(""); const [scatterY, setScatterY] = useState(""); const [scatterC, setScatterC] = useState("");
  const [lineX, setLineX] = useState(""); const [lineY, setLineY] = useState("");
  const [pieLabel, setPieLabel] = useState(""); const [pieValue, setPieValue] = useState("");
  const [barCol, setBarCol] = useState(""); const [funnelLabel, setFunnelLabel] = useState(""); const [funnelValue, setFunnelValue] = useState("");
  const [chartAnalysis, setChartAnalysis] = useState(""); const [chartAnalysisLoading, setChartAnalysisLoading] = useState(false);

  // State - AI Charts
  const [aiPrompt, setAiPrompt] = useState(""); const [aiChartConfig, setAiChartConfig] = useState(null); const [aiChartLoading, setAiChartLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]); const [suggestLoading, setSuggestLoading] = useState(false);

  // State - Pivot
  const [pivotRow, setPivotRow] = useState(""); const [pivotCol, setPivotCol] = useState(""); const [pivotVal, setPivotVal] = useState(""); const [pivotAgg, setPivotAgg] = useState("count");

  // State - Clean
  const [cleanLog, setCleanLog] = useState([]); const [renameCol, setRenameCol] = useState(""); const [renameTo, setRenameTo] = useState("");
  const [calcName, setCalcName] = useState(""); const [calcFormula, setCalcFormula] = useState(""); const [calcPreview, setCalcPreview] = useState(null); const [calcError, setCalcError] = useState("");

  // State - Search
  const [searchQ, setSearchQ] = useState(""); const [filterCol, setFilterCol] = useState(""); const [filterOp, setFilterOp] = useState("contains"); const [filterVal, setFilterVal] = useState("");

  // State - Chat
  const [chatMsgs, setChatMsgs] = useState([]); const [chatInput, setChatInput] = useState(""); const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef();
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMsgs]);

  // State - Compare
  const [cmpA, setCmpA] = useState(0); const [cmpB, setCmpB] = useState(1); const [cmpResult, setCmpResult] = useState(null); const [cmpLoading, setCmpLoading] = useState(false);

  // State - Report
  const [reportText, setReportText] = useState(""); const [reportLoading, setReportLoading] = useState(false);

  // State - Dashboard
  const [dashCharts, setDashCharts] = useState([]);

  // State - Onboarding
  const [showTour, setShowTour] = useState(false);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey && e.key === "Enter") { if (activeTab === "sql" && nlQuery) handleNLQuery(); }
      if (e.ctrlKey && e.key === "s") { e.preventDefault(); exportCSV(); }
      if (e.altKey && !isNaN(e.key) && Number(e.key) >= 1 && Number(e.key) <= TABS.length) setActiveTab(TABS[Number(e.key) - 1]);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, nlQuery]);

  const loadFile = useCallback((text, name, isXLSX = false) => {
    let parsed;
    if (isXLSX) { parsed = parseXLSX(text); if (!parsed) { alert("Could not parse Excel file. Try saving as CSV."); return; } }
    else parsed = parseCSV(text);
    const colTypes = inferTypes(parsed.headers, parsed.rows);
    const d = { name, ...parsed, colTypes, rawRows: [...parsed.rows] };
    setFiles(f => { const ex = f.findIndex(x => x.name === name); if (ex >= 0) { const nf = [...f]; nf[ex] = d; return nf; } return [...f, d]; });
    const nums = colTypes.filter(c => c.type === "number");
    const cats = colTypes.filter(c => c.type === "string");
    setScatterX(nums[0]?.name || ""); setScatterY(nums[1]?.name || nums[0]?.name || ""); setScatterC(cats[0]?.name || "");
    setLineX(nums[0]?.name || ""); setLineY(nums[1]?.name || nums[0]?.name || "");
    setPieLabel(cats[0]?.name || ""); setPieValue(nums[0]?.name || "");
    setBarCol(cats[0]?.name || ""); setFunnelLabel(cats[0]?.name || ""); setFunnelValue(nums[0]?.name || "");
    setPivotRow(cats[0]?.name || ""); setPivotCol(cats[1]?.name || cats[0]?.name || ""); setPivotVal(nums[0]?.name || "");
    setNlResult(null); setGenSQL(""); setSqlAnalysis(""); setSearchQ(""); setFilterVal("");
    setChatMsgs([{ role: "assistant", text: `Loaded "${name}" — ${parsed.rows.length.toLocaleString()} rows, ${parsed.headers.length} columns (${nums.length} numeric, ${cats.length} text). Ask me anything!` }]);
    setActiveTab("overview");
  }, []);

  const onFile = f => {
    if (!f) return;
    const isXLSX = f.name.endsWith(".xlsx") || f.name.endsWith(".xls");
    if (isXLSX) {
      if (!window.XLSX) { alert("Excel support loading... please try again in 2 seconds."); return; }
      const reader = new FileReader();
      reader.onload = e => loadFile(new Uint8Array(e.target.result), f.name, true);
      reader.readAsArrayBuffer(f);
    } else {
      const reader = new FileReader();
      reader.onload = e => loadFile(e.target.result, f.name);
      reader.readAsText(f);
    }
  };

  const numCols = data?.colTypes.filter(c => c.type === "number") || [];
  const catCols = data?.colTypes.filter(c => c.type === "string") || [];
  const dateCols = data?.colTypes.filter(c => c.type === "date") || [];

  const filteredRows = useCallback(() => {
    if (!data) return [];
    let rows = [...data.rows];
    if (searchQ.trim()) rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(searchQ.toLowerCase())));
    if (filterCol && filterVal.trim()) {
      rows = rows.filter(r => {
        const rv = r[filterCol]; const nv = Number(filterVal);
        if (filterOp === "contains") return String(rv).toLowerCase().includes(filterVal.toLowerCase());
        if (filterOp === "equals") return rv == filterVal;
        if (filterOp === ">") return Number(rv) > nv;
        if (filterOp === "<") return Number(rv) < nv;
        if (filterOp === ">=") return Number(rv) >= nv;
        if (filterOp === "<=") return Number(rv) <= nv;
        return true;
      });
    }
    return rows;
  }, [data, searchQ, filterCol, filterOp, filterVal]);

  // Pivot table computation
  const buildPivot = () => {
    if (!data || !pivotRow || !pivotCol) return null;
    const rows = data.rows;
    const rowVals = [...new Set(rows.map(r => r[pivotRow]))].slice(0, 20);
    const colVals = [...new Set(rows.map(r => r[pivotCol]))].slice(0, 12);
    const table = {};
    rowVals.forEach(rv => { table[rv] = {}; colVals.forEach(cv => { table[rv][cv] = []; }); });
    rows.forEach(r => { const rv = r[pivotRow]; const cv = r[pivotCol]; if (table[rv] && table[rv][cv] !== undefined) { const v = Number(r[pivotVal]); if (!isNaN(v)) table[rv][cv].push(v); else table[rv][cv].push(1); } });
    const agg = (arr) => {
      if (!arr.length) return "—";
      if (pivotAgg === "count") return arr.length;
      if (pivotAgg === "sum") return fmt(arr.reduce((s, v) => s + v, 0));
      if (pivotAgg === "avg") return fmt(arr.reduce((s, v) => s + v, 0) / arr.length);
      if (pivotAgg === "max") return fmt(Math.max(...arr));
      if (pivotAgg === "min") return fmt(Math.min(...arr));
      return arr.length;
    };
    return { rowVals, colVals, table, agg };
  };

  // ── AI Handlers ──
  const handleNLQuery = async () => {
    if (!nlQuery.trim() || !data) return;
    setNlLoading(true); setNlResult(null); setGenSQL(""); setSqlAnalysis("");
    try {
      const colInfo = data.colTypes.map(c => `${c.name}(${c.type})`).join(", ");
      const sample = data.rows.slice(0, 3).map(r => JSON.stringify(r)).join("\n");
      const sql = (await callAI([{ role: "user", content: `Convert to SQLite SQL for table "data". Columns: ${colInfo}. Sample:\n${sample}\nQuestion: "${nlQuery}"\nReturn ONLY the SQL.` }], "You are a precise SQL generator. Output only valid SQLite SQL.")).trim().replace(/```sql|```/g, "").trim();
      setGenSQL(sql);
      const result = executeSQL(sql, data.rows);
      setNlResult(result);
      setSqlHistory(h => [{ query: nlQuery, sql, rowCount: result.length }, ...h.slice(0, 9)]);
      if (result.length > 0) {
        setSqlAnalysisLoading(true);
        const preview = result.slice(0, 10).map(r => Object.values(r).join(", ")).join("\n");
        const analysis = await callAI([{ role: "user", content: `Analyze these results and give a 3-4 sentence business insight with specific numbers. Query: "${nlQuery}". Results (${result.length} rows):\n${preview}` }], "You are a business data analyst. Be specific and insightful.");
        setSqlAnalysis(analysis); setSqlAnalysisLoading(false);
      }
    } catch (e) { setGenSQL("Error: " + e.message); setNlResult([]); }
    setNlLoading(false);
  };

  const handleInsights = async () => {
    if (!data) return; setInsightsLoading(true);
    try {
      const statsText = numCols.map(c => { const s = computeStats(data.rows, c.name); return s ? `${c.name}: mean=${s.mean},min=${s.min},max=${s.max},std=${s.std},sum=${s.sum}` : ""; }).filter(Boolean).join("\n");
      const catText = catCols.map(c => { const cnt = {}; data.rows.forEach(r => { const v = r[c.name]; cnt[v] = (cnt[v] || 0) + 1; }); const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}(${v})`).join(","); return `${c.name}: ${top}`; }).join("\n");
      const text = await callAI([{ role: "user", content: `Analyze this dataset and return exactly 6 business insights as a JSON array. Each object: title(6 words max), insight(2-3 sentences with numbers), severity(positive|warning|neutral), recommendation(1 actionable sentence), metric(key number as string like "29.6%").\n\nFile: ${data.name}\nRows: ${data.rows.length}\nNumeric:\n${statsText}\nCategorical:\n${catText}\n\nReturn ONLY valid JSON array.` }], "You are a senior data analyst. Respond with valid JSON only.");
      setInsights(ins => ({ ...ins, [activeFile]: JSON.parse(text.replace(/```json|```/g, "").trim()) }));
    } catch (e) { setInsights(ins => ({ ...ins, [activeFile]: [{ title: "Error", insight: e.message, severity: "warning", recommendation: "Check API.", metric: "!" }] })); }
    setInsightsLoading(false);
  };

  const analyzeChart = async (desc) => {
    if (!data) return; setChartAnalysisLoading(true); setChartAnalysis("");
    try {
      const statsText = numCols.slice(0, 5).map(c => { const s = computeStats(data.rows, c.name); return s ? `${c.name}: mean=${s.mean},min=${s.min},max=${s.max}` : ""; }).filter(Boolean).join("; ");
      const analysis = await callAI([{ role: "user", content: `Analyze this chart and provide 3-4 sentence insight with specific numbers. Chart: ${desc}. Dataset: ${data.name} (${data.rows.length} rows). Stats: ${statsText}. What patterns, trends, or anomalies do you see?` }], "You are a data visualization expert. Be specific and actionable.");
      setChartAnalysis(analysis);
    } catch (e) { setChartAnalysis("Error: " + e.message); }
    setChartAnalysisLoading(false);
  };

  const handleAIChart = async () => {
    if (!aiPrompt.trim() || !data) return; setAiChartLoading(true); setAiChartConfig(null);
    try {
      const colInfo = data.colTypes.map(c => `${c.name}(${c.type})`).join(", ");
      const text = await callAI([{ role: "user", content: `Create chart config. Columns: ${colInfo}. Request: "${aiPrompt}". Return JSON: type(hbar|vbar|line|scatter|pie|donut|histogram|heatmap|boxplot|funnel), title, xCol, yCol, col, labelCol, valueCol, colorCol, color(hex), description.` }], "You are a data visualization expert. Output only valid JSON.");
      setAiChartConfig(JSON.parse(text.replace(/```json|```/g, "").trim()));
    } catch (e) { console.error(e); }
    setAiChartLoading(false);
  };

  const handleSuggestions = async () => {
    if (!data) return; setSuggestLoading(true); setSuggestions([]);
    try {
      const colInfo = data.colTypes.map(c => `${c.name}(${c.type})`).join(", ");
      const text = await callAI([{ role: "user", content: `Suggest 6 insightful visualizations for this dataset. Columns: ${colInfo}. Dataset: ${data.name} (${data.rows.length} rows). Return JSON array: title, description(why interesting), type(hbar|vbar|pie|scatter|line|histogram|heatmap|funnel), cols(array), insight(what to expect).` }], "You are a data analyst. Output only valid JSON.");
      setSuggestions(JSON.parse(text.replace(/```json|```/g, "").trim()));
    } catch (e) { console.error(e); }
    setSuggestLoading(false);
  };

  const handleChat = async () => {
    if (!chatInput.trim()) return;
    const userMsg = chatInput.trim(); setChatInput("");
    setChatMsgs(m => [...m, { role: "user", text: userMsg }]); setChatLoading(true);
    try {
      const ctx = data ? `Dataset: "${data.name}" (${data.rows.length} rows, cols: ${data.headers.join(", ")}). Stats: ${numCols.slice(0, 5).map(c => { const s = computeStats(data.rows, c.name); return s ? `${c.name}:mean=${s.mean},min=${s.min},max=${s.max}` : ""; }).filter(Boolean).join("; ")}. Sample: ${JSON.stringify(data.rows[0] || {})}.` : "No data loaded.";
      const reply = await callAI([{ role: "user", content: ctx + " Question: " + userMsg }], "You are a helpful data analyst. Answer concisely with specific numbers. Use bullet points for multiple items. Be insightful and actionable.");
      setChatMsgs(m => [...m, { role: "assistant", text: reply }]);
    } catch (e) { setChatMsgs(m => [...m, { role: "assistant", text: "⚠️ " + e.message }]); }
    setChatLoading(false);
  };

  const handleCompare = async () => {
    if (files.length < 2) return; setCmpLoading(true); setCmpResult(null);
    try {
      const fA = files[cmpA]; const fB = files[cmpB];
      const sA = fA.colTypes.filter(c => c.type === "number").map(c => { const s = computeStats(fA.rows, c.name); return s ? `${c.name}:mean=${s.mean}` : ""; }).filter(Boolean).join("; ");
      const sB = fB.colTypes.filter(c => c.type === "number").map(c => { const s = computeStats(fB.rows, c.name); return s ? `${c.name}:mean=${s.mean}` : ""; }).filter(Boolean).join("; ");
      const text = await callAI([{ role: "user", content: `Compare datasets and return JSON: summary(2-3 sentences), similarities(array of 3), differences(array of 3), recommendation(2 sentences), keyMetrics(array of 3 {label,fileA,fileB}).\n\nA(${fA.name}): ${fA.rows.length} rows. Stats: ${sA}\nB(${fB.name}): ${fB.rows.length} rows. Stats: ${sB}\n\nReturn ONLY valid JSON.` }], "You are a data analyst. Output only valid JSON.");
      setCmpResult(JSON.parse(text.replace(/```json|```/g, "").trim()));
    } catch (e) { setCmpResult({ summary: "Error: " + e.message, similarities: [], differences: [], recommendation: "", keyMetrics: [] }); }
    setCmpLoading(false);
  };

  const generateReport = async () => {
    if (!data) return; setReportLoading(true); setReportText("");
    try {
      const statsText = numCols.map(c => { const s = computeStats(data.rows, c.name); return s ? `${c.name}: mean=${s.mean}, min=${s.min}, max=${s.max}, std=${s.std}, sum=${s.sum}` : ""; }).filter(Boolean).join("\n");
      const catText = catCols.map(c => { const cnt = {}; data.rows.forEach(r => { const v = r[c.name]; cnt[v] = (cnt[v] || 0) + 1; }); return `${c.name}: ${Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v})`).join(", ")}`; }).join("\n");
      const ins = (insights[activeFile] || []).map(i => `• ${i.title}: ${i.insight}`).join("\n");
      const report = await callAI([{ role: "user", content: `Write a professional executive data analysis report. Include: Executive Summary, Key Findings (with specific numbers), Trends & Patterns, Risk Areas, Strategic Recommendations. 500-700 words, professional tone.\n\nDataset: ${data.name}\nRows: ${data.rows.length} | Columns: ${data.headers.length}\n\nStats:\n${statsText}\n\nCategorical:\n${catText}\n\nPrevious Insights:\n${ins || "None"}` }], "You are a senior business analyst writing an executive report. Be professional, specific, data-driven.");
      setReportText(report);
    } catch (e) { setReportText("Error: " + e.message); }
    setReportLoading(false);
  };

  // Clean handlers
  const removeDuplicates = () => { const before = data.rows.length; const seen = new Set(); const deduped = data.rows.filter(r => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; }); setFiles(f => { const nf = [...f]; nf[activeFile] = { ...nf[activeFile], rows: deduped }; return nf; }); setCleanLog(l => [`✓ Removed ${before - deduped.length} duplicate rows`,...l]); };
  const fillNulls = () => { const newRows = data.rows.map(r => { const nr = { ...r }; data.colTypes.forEach(c => { if (nr[c.name] === "" || nr[c.name] == null) { if (c.type === "number") { const vals = data.rows.map(x => Number(x[c.name])).filter(v => !isNaN(v)); nr[c.name] = vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : "0"; } else { const cnt = {}; data.rows.forEach(x => { const v = x[c.name]; if (v) cnt[v] = (cnt[v] || 0) + 1; }); nr[c.name] = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || ""; } } }); return nr; }); setFiles(f => { const nf = [...f]; nf[activeFile] = { ...nf[activeFile], rows: newRows }; return nf; }); setCleanLog(l => [`✓ Filled missing values`,...l]); };
  const trimStrings = () => { setFiles(f => { const nf = [...f]; nf[activeFile] = { ...nf[activeFile], rows: nf[activeFile].rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]))) }; return nf; }); setCleanLog(l => [`✓ Trimmed whitespace`,...l]); };
  const doRename = () => { if (!renameCol || !renameTo || renameCol === renameTo) return; setFiles(f => { const nf = [...f]; const d = nf[activeFile]; nf[activeFile] = { ...d, headers: d.headers.map(h => h === renameCol ? renameTo : h), rows: d.rows.map(r => { const nr = { ...r }; nr[renameTo] = nr[renameCol]; delete nr[renameCol]; return nr; }), colTypes: d.colTypes.map(c => c.name === renameCol ? { ...c, name: renameTo } : c) }; return nf; }); setCleanLog(l => [`✓ Renamed "${renameCol}"→"${renameTo}"`,...l]); setRenameCol(""); setRenameTo(""); };
  const resetData = () => { setFiles(f => { const nf = [...f]; nf[activeFile] = { ...nf[activeFile], rows: [...nf[activeFile].rawRows] }; return nf; }); setCleanLog(l => [`↺ Reset to original`,...l]); };
  const applyCalc = () => { if (!calcName || !calcFormula || !data) return; try { const newRows = data.rows.map(r => ({ ...r, [calcName]: evalFormula(calcFormula, r) })); setFiles(f => { const nf = [...f]; nf[activeFile] = { ...nf[activeFile], rows: newRows, headers: [...nf[activeFile].headers, calcName], colTypes: [...nf[activeFile].colTypes, { name: calcName, type: "number" }] }; return nf; }); setCleanLog(l => [`✓ Added "${calcName}" = ${calcFormula}`,...l]); setCalcName(""); setCalcFormula(""); setCalcPreview(null); } catch (e) { setCalcError(e.message); } };
  const previewCalc = () => { if (!calcFormula || !data) return; try { setCalcPreview(data.rows.slice(0, 5).map(r => ({ ...r, [calcName || "preview"]: evalFormula(calcFormula, r) }))); setCalcError(""); } catch (e) { setCalcError(e.message); } };

  // Export handlers
  const exportCSV = (rows = data?.rows) => { if (!rows) return; const blob = new Blob([rowsToCSV(rows)], { type: "text/csv" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `export_${data?.name || "data.csv"}`; a.click(); };
  const copyReport = () => { if (!reportText) return; navigator.clipboard.writeText(reportText).then(() => alert("Report copied to clipboard!")); };
  const exportPDF = () => {
    if (!data) return;
    const win = window.open("", "_blank");
    const ins = insights[activeFile] || [];
    const insHTML = ins.map(i => `<div class="ins ${i.severity}"><div class="metric">${i.metric || ""}</div><strong>${i.title}</strong><p>${i.insight}</p><em>→ ${i.recommendation || ""}</em></div>`).join("");
    const statsHTML = numCols.slice(0, 12).map(c => { const s = computeStats(data.rows, c.name); return s ? `<tr><td>${c.name}</td><td>${s.mean}</td><td>${s.min}</td><td>${s.max}</td><td>${s.std}</td><td>${s.count}</td></tr>` : ""; }).join("");
    win.document.write(`<html><head><title>Report: ${data.name}</title><style>body{font-family:Georgia,serif;max-width:860px;margin:40px auto;color:#1e293b;line-height:1.7}h1{font-size:28px;border-bottom:3px solid #6366f1;padding-bottom:12px}h2{font-size:18px;color:#374151;margin-top:32px}table{width:100%;border-collapse:collapse;font-size:13px;margin:12px 0}th{background:#f3f4f6;padding:9px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e7eb}td{padding:9px 12px;border-bottom:1px solid #f3f4f6}.mr{display:flex;gap:16px;margin:16px 0}.mc{background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:14px 20px;text-align:center;flex:1}.mv{font-size:26px;font-weight:700}.ml{font-size:11px;color:#9ca3af;text-transform:uppercase}.ins{padding:14px 18px;margin:10px 0;border-radius:10px;border-left:4px solid #94a3b8;background:#f8fafc;position:relative}.ins .metric{position:absolute;right:16px;top:14px;font-size:18px;font-weight:700;color:#6366f1}.positive{border-color:#10b981;background:#f0fdf4}.warning{border-color:#f59e0b;background:#fffbeb}.neutral{background:#f8fafc}em{font-size:12px;color:#6366f1;display:block;margin-top:6px}.report{background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:20px;white-space:pre-wrap;font-size:13px;line-height:1.8}</style></head><body>
    <h1>📊 ${data.name}</h1><p style="color:#6b7280">${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })} · ${data.rows.length.toLocaleString()} rows · ${data.headers.length} columns</p>
    <div class="mr"><div class="mc"><div class="mv">${data.rows.length.toLocaleString()}</div><div class="ml">Rows</div></div><div class="mc"><div class="mv">${data.headers.length}</div><div class="ml">Columns</div></div><div class="mc"><div class="mv">${numCols.length}</div><div class="ml">Numeric</div></div><div class="mc"><div class="mv">${catCols.length}</div><div class="ml">Text</div></div></div>
    ${reportText ? `<h2>Executive Report</h2><div class="report">${reportText}</div>` : ""}
    ${statsHTML ? `<h2>Column Statistics</h2><table><thead><tr><th>Column</th><th>Mean</th><th>Min</th><th>Max</th><th>Std Dev</th><th>Count</th></tr></thead><tbody>${statsHTML}</tbody></table>` : ""}
    ${ins.length ? `<h2>AI Insights</h2>${insHTML}` : ""}
    <h2>Data Preview</h2><table><thead><tr>${data.headers.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${data.rows.slice(0, 25).map(r => `<tr>${data.headers.map(h => `<td>${r[h] ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table>
    </body></html>`);
    win.document.close(); setTimeout(() => win.print(), 500);
  };

  const addToDash = cfg => setDashCharts(d => [...d, { id: Date.now(), ...cfg, fileIdx: activeFile, fileName: data?.name }]);

  const sevStyle = s => ({ positive: { bg: "#f0fdf4", border: "#86efac", dot: "#10b981", txt: "#166534" }, warning: { bg: "#fffbeb", border: "#fcd34d", dot: "#f59e0b", txt: "#92400e" }, neutral: { bg: "#f8fafc", border: "#e5e7eb", dot: "#6b7280", txt: "#374151" } }[s] || { bg: "#f8fafc", border: "#e5e7eb", dot: "#6b7280", txt: "#374151" });

  const frows = filteredRows();
  const pivot = buildPivot();

  // Render chart from config
  const renderChartFromConfig = (cfg, rows, colTypes) => {
    if (!cfg) return null;
    const getBarData = (col) => { const cnt = {}; rows.forEach(r => { const v = r[col] || "(empty)"; cnt[v] = (cnt[v] || 0) + 1; }); return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, count]) => ({ label, count })); };
    const getPieData = (lk, vk) => { const cnt = {}; rows.forEach(r => { const k = r[lk]; const v = Number(r[vk]) || 0; cnt[k] = (cnt[k] || 0) + v; }); return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value })); };
    switch (cfg.type) {
      case "hbar": return cfg.col ? <HBarChart data={getBarData(cfg.col)} labelKey="label" valueKey="count" color={cfg.color || "#6366f1"} /> : null;
      case "vbar": return cfg.col ? <VBarChart data={getBarData(cfg.col)} labelKey="label" valueKey="count" /> : null;
      case "pie": return (cfg.labelCol && cfg.valueCol) ? <PieChart data={getPieData(cfg.labelCol, cfg.valueCol)} labelKey="label" valueKey="value" /> : null;
      case "donut": return (cfg.labelCol && cfg.valueCol) ? <PieChart data={getPieData(cfg.labelCol, cfg.valueCol)} labelKey="label" valueKey="value" donut /> : null;
      case "scatter": return (cfg.xCol && cfg.yCol) ? <ScatterPlot rows={rows} xCol={cfg.xCol} yCol={cfg.yCol} colorCol={cfg.colorCol} /> : null;
      case "line": return (cfg.xCol && cfg.yCol) ? <LineChart data={rows} xKey={cfg.xCol} yKey={cfg.yKey || cfg.yCol} /> : null;
      case "histogram": return cfg.col ? <Histogram rows={rows} col={cfg.col} /> : null;
      case "heatmap": return <Heatmap rows={rows} colTypes={colTypes} />;
      case "boxplot": return <BoxPlot rows={rows} cols={colTypes} />;
      case "funnel": return (cfg.labelCol && cfg.valueCol) ? <FunnelChart data={rows.slice(0, 30)} labelKey={cfg.labelCol} valueKey={cfg.valueCol} /> : null;
      default: return null;
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.txt, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", transition: "background 0.2s" }}>

      {/* Load SheetJS for Excel support */}
      <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js" />

      {/* ── Header ── */}
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "0 28px", display: "flex", alignItems: "center", gap: 14, height: 60, position: "sticky", top: 0, zIndex: 50, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>◈</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: "-0.01em", color: T.txt }}>DATA ANALYTICS PLATFORM</div>
            <div style={{ fontSize: 10, color: T.muted, letterSpacing: "0.05em" }}>PROFESSIONAL EDITION v4</div>
          </div>
        </div>

        {files.length > 0 && (
          <div style={{ display: "flex", gap: 4, marginLeft: 8, overflowX: "auto" }}>
            {files.map((f, i) => (
              <button key={i} onClick={() => setActiveFile(i)} style={{ padding: "5px 14px", borderRadius: 20, border: `1.5px solid ${i === activeFile ? "#6366f1" : T.border}`, background: i === activeFile ? "#eef2ff" : "transparent", color: i === activeFile ? "#6366f1" : T.muted, fontSize: 11, fontFamily: "inherit", cursor: "pointer", whiteSpace: "nowrap", fontWeight: i === activeFile ? 700 : 400 }}>
                {f.name.slice(0, 20)}
                {files.length > 1 && <span onClick={e => { e.stopPropagation(); setFiles(fs => fs.filter((_, fi) => fi !== i)); }} style={{ marginLeft: 6, opacity: 0.5 }}>✕</span>}
              </button>
            ))}
            <button onClick={() => fileRef.current.click()} style={{ padding: "5px 12px", borderRadius: 20, border: `1px dashed ${T.border}`, background: "transparent", color: T.muted, fontSize: 11, fontFamily: "inherit", cursor: "pointer" }}>+ CSV/Excel</button>
          </div>
        )}

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {data && <div style={{ fontSize: 12, color: T.muted, background: T.faint, border: `1px solid ${T.border}`, borderRadius: 20, padding: "4px 12px" }}>{data.rows.length.toLocaleString()} rows</div>}
          <button onClick={() => setShowTour(true)} style={{ ...btnS, padding: "6px 12px", fontSize: 11 }}>? Help</button>
          <button onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} style={{ ...btnS, padding: "6px 12px", fontSize: 11 }}>{isDark ? "☀ Light" : "☾ Dark"}</button>
        </div>
      </div>

      {/* Tour overlay */}
      {showTour && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setShowTour(false)}>
          <div style={{ background: "#fff", borderRadius: 20, padding: 36, maxWidth: 560, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#111827", marginBottom: 6 }}>Welcome to Data Analytics Platform</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 20 }}>Professional Edition v4 · All features guide</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
              {[["📊 Overview", "Stats, search, filter, data table"], ["📈 Charts", "9 chart types with AI analysis"], ["🤖 AI Charts", "Describe → AI builds the chart"], ["💬 SQL", "Ask questions in plain English"], ["✦ Insights", "6 AI business findings"], ["📄 Report", "Full executive report"], ["🔄 Pivot", "Cross-tab pivot tables"], ["🧹 Clean", "Fix data + column calculator"], ["⇄ Compare", "Compare 2 datasets with AI"], ["💬 Chat", "Converse with your data"], ["📌 Dashboard", "Pin charts to dashboard"], ["⬇ Export", "CSV, PDF, clipboard"]].map(([t, d]) => (
                <div key={t} style={{ background: "#f9fafb", borderRadius: 10, padding: "10px 14px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 2 }}>{t}</div>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>{d}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 16 }}>
              Shortcuts: <strong>Alt+1-9</strong> to switch tabs · <strong>Ctrl+Enter</strong> to run SQL · <strong>Ctrl+S</strong> to export CSV
            </div>
            <button onClick={() => setShowTour(false)} style={{ ...btnP, width: "100%", padding: "12px", fontSize: 14 }}>Get Started →</button>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 20px" }}>
        {!files.length ? (
          <div onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={e => { e.preventDefault(); setDragOver(false); [...e.dataTransfer.files].forEach(onFile); }} onClick={() => fileRef.current.click()} style={{ border: `2px dashed ${dragOver ? "#6366f1" : T.border}`, borderRadius: 20, padding: "80px 40px", textAlign: "center", cursor: "pointer", background: dragOver ? "#eef2ff" : T.surface, transition: "all 0.2s" }}>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" multiple style={{ display: "none" }} onChange={e => [...e.target.files].forEach(onFile)} />
            <div style={{ fontSize: 52, marginBottom: 16 }}>📊</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.txt, marginBottom: 8 }}>Drop your data file here</div>
            <div style={{ fontSize: 14, color: T.muted, marginBottom: 4 }}>CSV or Excel (.xlsx) · multiple files supported</div>
            <div style={{ fontSize: 12, color: T.muted, opacity: 0.6 }}>or click to browse your computer</div>
            <button onClick={e => { e.stopPropagation(); setShowTour(true); }} style={{ ...btnS, marginTop: 20, fontSize: 12 }}>? View feature guide</button>
          </div>
        ) : (
          <>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" multiple style={{ display: "none" }} onChange={e => [...e.target.files].forEach(onFile)} />

            {/* Tab Bar */}
            <div style={{ display: "flex", gap: 2, marginBottom: 24, background: isDark ? "#0f172a" : "#f3f4f6", borderRadius: 12, padding: 4, overflowX: "auto", width: "fit-content", maxWidth: "100%" }}>
              {TABS.map(t => (
                <button key={t} onClick={() => setActiveTab(t)} style={{ padding: "8px 14px", borderRadius: 9, border: "none", cursor: "pointer", fontSize: 10, fontFamily: "inherit", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: activeTab === t ? T.surface : "transparent", color: activeTab === t ? "#6366f1" : T.muted, boxShadow: activeTab === t ? "0 1px 3px rgba(0,0,0,0.08)" : "none", transition: "all 0.15s", whiteSpace: "nowrap" }}>{t}</button>
              ))}
            </div>

            {/* ════════ OVERVIEW ════════ */}
            {activeTab === "overview" && data && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
                  {[["Total Rows", data.rows.length.toLocaleString(), "#6366f1", "#eef2ff"], ["Columns", data.headers.length, "#10b981", "#d1fae5"], ["Numeric", numCols.length, "#f59e0b", "#fef3c7"], ["Text Cols", catCols.length, "#8b5cf6", "#ede9fe"]].map(([l, v, c, bg]) => (
                    <div key={l} style={{ background: bg, borderRadius: 14, padding: "18px 20px", border: `1px solid ${c}30` }}>
                      <div style={{ fontSize: 12, color: c, fontWeight: 700, marginBottom: 6, letterSpacing: "0.04em" }}>{l}</div>
                      <div style={{ fontSize: 28, fontWeight: 800, color: c }}>{v}</div>
                    </div>
                  ))}
                </div>

                <div style={{ ...card }}>
                  <div style={{ ...lbl, marginBottom: 12 }}>Search & Filter</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="🔍 Search all columns..." style={{ ...inp, flex: "1 1 200px" }} />
                    <select value={filterCol} onChange={e => setFilterCol(e.target.value)} style={sel}><option value="">Filter by column</option>{data.headers.map(h => <option key={h}>{h}</option>)}</select>
                    <select value={filterOp} onChange={e => setFilterOp(e.target.value)} style={sel}><option value="contains">contains</option><option value="equals">equals</option><option value=">">{">"}</option><option value="<">{"<"}</option><option value=">=">{">="}</option><option value="<=">{"<="}</option></select>
                    <input value={filterVal} onChange={e => setFilterVal(e.target.value)} placeholder="value..." style={{ ...inp, flex: "0 1 130px" }} />
                    <button onClick={() => { setSearchQ(""); setFilterVal(""); setFilterCol(""); }} style={btnS}>Clear</button>
                  </div>
                  {(searchQ || filterVal) && <div style={{ marginTop: 8, fontSize: 12, color: "#6366f1", fontWeight: 600 }}>Showing {frows.length.toLocaleString()} of {data.rows.length.toLocaleString()} rows</div>}
                </div>

                <div style={{ ...card, overflow: "hidden" }}>
                  <div style={{ ...lbl, marginBottom: 16 }}>Column Statistics</div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead><tr style={{ background: T.faint }}>{["Column", "Type", "Mean", "Min", "Max", "Std Dev", "Median", "Sum", "Count"].map(h => <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: T.muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
                      <tbody>{data.colTypes.map((col, ci) => { const s = col.type === "number" ? computeStats(data.rows, col.name) : null; return (<tr key={col.name} style={{ borderBottom: `1px solid ${T.border}`, background: ci % 2 === 0 ? "transparent" : T.faint }}><td style={{ padding: "10px 14px", fontWeight: 700, color: T.txt }}>{col.name}</td><td style={{ padding: "10px 14px" }}><span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: col.type === "number" ? "#d1fae5" : col.type === "date" ? "#e0f2fe" : "#ede9fe", color: col.type === "number" ? "#065f46" : col.type === "date" ? "#0369a1" : "#5b21b6", fontWeight: 600 }}>{col.type}</span></td>{s ? <><td style={{ padding: "10px 14px", color: T.muted, fontFamily: "monospace" }}>{fmt(s.mean)}</td><td style={{ padding: "10px 14px", color: T.muted, fontFamily: "monospace" }}>{fmt(s.min)}</td><td style={{ padding: "10px 14px", color: T.muted, fontFamily: "monospace" }}>{fmt(s.max)}</td><td style={{ padding: "10px 14px", color: T.muted, fontFamily: "monospace" }}>{fmt(s.std)}</td><td style={{ padding: "10px 14px", color: T.muted, fontFamily: "monospace" }}>{fmt(s.median)}</td><td style={{ padding: "10px 14px", color: T.muted, fontFamily: "monospace" }}>{fmt(s.sum)}</td><td style={{ padding: "10px 14px", color: T.muted }}>{s.count.toLocaleString()}</td></> : [...Array(7)].map((_, i) => <td key={i} style={{ padding: "10px 14px", color: T.border }}>—</td>)}</tr>); })}</tbody>
                    </table>
                  </div>
                </div>

                <div style={{ ...card, overflow: "hidden" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <div style={lbl}>Data Table · {frows.length.toLocaleString()} rows</div>
                    <button onClick={() => exportCSV(frows)} style={btnS}>⬇ Export filtered</button>
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead><tr style={{ background: T.faint }}>{data.headers.map(h => <th key={h} style={{ padding: "9px 14px", textAlign: "left", color: T.muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
                      <tbody>{frows.slice(0, 50).map((row, i) => <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }} onMouseEnter={e => e.currentTarget.style.background = "#f0f4ff"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>{data.headers.map(h => <td key={h} style={{ padding: "8px 14px", color: T.muted, whiteSpace: "nowrap", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{row[h]}</td>)}</tr>)}</tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* ════════ CHARTS ════════ */}
            {activeTab === "charts" && data && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {[["hbar", "Horiz Bar"], ["vbar", "Vert Bar"], ["line", "Line"], ["scatter", "Scatter"], ["pie", "Pie"], ["donut", "Donut"], ["histogram", "Histogram"], ["boxplot", "Box Plot"], ["heatmap", "Heatmap"], ["funnel", "Funnel"]].map(([m, label]) => (
                    <button key={m} onClick={() => { setChartMode(m); setChartAnalysis(""); }} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${chartMode === m ? "#6366f1" : T.border}`, background: chartMode === m ? "#6366f1" : "transparent", color: chartMode === m ? "#fff" : T.muted, fontWeight: chartMode === m ? 700 : 400, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>{label}</button>
                  ))}
                </div>

                <div style={card}>
                  {/* Controls per chart type */}
                  {["hbar", "vbar"].includes(chartMode) && (<div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Column</div><select value={barCol} onChange={e => setBarCol(e.target.value)} style={sel}>{[...catCols, ...numCols].map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <button onClick={() => analyzeChart(`${chartMode === "hbar" ? "Horizontal" : "Vertical"} bar chart of ${barCol} distribution`)} style={{ ...btnP, alignSelf: "flex-end" }}>✦ Analyze</button>
                    <button onClick={() => addToDash({ type: chartMode, col: barCol, title: `${barCol} distribution` })} style={{ ...btnS, alignSelf: "flex-end" }}>📌 Pin</button>
                  </div>)}
                  {chartMode === "scatter" && (<div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>X Axis</div><select value={scatterX} onChange={e => setScatterX(e.target.value)} style={sel}>{numCols.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Y Axis</div><select value={scatterY} onChange={e => setScatterY(e.target.value)} style={sel}>{numCols.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Color by</div><select value={scatterC} onChange={e => setScatterC(e.target.value)} style={sel}><option value="">None</option>{catCols.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <button onClick={() => analyzeChart(`Scatter plot: ${scatterY} vs ${scatterX}`)} style={{ ...btnP, alignSelf: "flex-end" }}>✦ Analyze</button>
                    <button onClick={() => addToDash({ type: "scatter", xCol: scatterX, yCol: scatterY, colorCol: scatterC, title: `${scatterY} vs ${scatterX}` })} style={{ ...btnS, alignSelf: "flex-end" }}>📌 Pin</button>
                  </div>)}
                  {chartMode === "line" && (<div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>X Axis</div><select value={lineX} onChange={e => setLineX(e.target.value)} style={sel}>{numCols.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Y Axis</div><select value={lineY} onChange={e => setLineY(e.target.value)} style={sel}>{numCols.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <button onClick={() => analyzeChart(`Line chart: ${lineY} over ${lineX}`)} style={{ ...btnP, alignSelf: "flex-end" }}>✦ Analyze</button>
                    <button onClick={() => addToDash({ type: "line", xCol: lineX, yCol: lineY, title: `${lineY} over ${lineX}` })} style={{ ...btnS, alignSelf: "flex-end" }}>📌 Pin</button>
                  </div>)}
                  {["pie", "donut"].includes(chartMode) && (<div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Label</div><select value={pieLabel} onChange={e => setPieLabel(e.target.value)} style={sel}>{data.colTypes.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Value</div><select value={pieValue} onChange={e => setPieValue(e.target.value)} style={sel}>{numCols.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <button onClick={() => analyzeChart(`${chartMode} chart: ${pieValue} by ${pieLabel}`)} style={{ ...btnP, alignSelf: "flex-end" }}>✦ Analyze</button>
                    <button onClick={() => addToDash({ type: chartMode, labelCol: pieLabel, valueCol: pieValue, title: `${pieValue} by ${pieLabel}` })} style={{ ...btnS, alignSelf: "flex-end" }}>📌 Pin</button>
                  </div>)}
                  {chartMode === "histogram" && (<div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Column</div><select value={scatterX || numCols[0]?.name} onChange={e => setScatterX(e.target.value)} style={sel}>{numCols.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <button onClick={() => analyzeChart(`Histogram of ${scatterX || numCols[0]?.name}`)} style={{ ...btnP, alignSelf: "flex-end" }}>✦ Analyze</button>
                  </div>)}
                  {chartMode === "funnel" && (<div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Label</div><select value={funnelLabel} onChange={e => setFunnelLabel(e.target.value)} style={sel}>{data.colTypes.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Value</div><select value={funnelValue} onChange={e => setFunnelValue(e.target.value)} style={sel}>{numCols.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <button onClick={() => analyzeChart(`Funnel chart: ${funnelValue} by ${funnelLabel}`)} style={{ ...btnP, alignSelf: "flex-end" }}>✦ Analyze</button>
                  </div>)}
                  {["heatmap", "boxplot"].includes(chartMode) && (<div style={{ display: "flex", gap: 10, marginBottom: 16 }}><button onClick={() => analyzeChart(`${chartMode} of numeric columns`)} style={btnP}>✦ Analyze</button><button onClick={() => addToDash({ type: chartMode, title: `${chartMode}` })} style={btnS}>📌 Pin</button></div>)}

                  {/* Chart render */}
                  {chartMode === "hbar" && barCol && (() => { const cnt = {}; data.rows.forEach(r => { const v = r[barCol] || "(empty)"; cnt[v] = (cnt[v] || 0) + 1; }); const d2 = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([label, count]) => ({ label, count })); return <HBarChart data={d2} labelKey="label" valueKey="count" />; })()}
                  {chartMode === "vbar" && barCol && (() => { const cnt = {}; data.rows.forEach(r => { const v = r[barCol] || "(empty)"; cnt[v] = (cnt[v] || 0) + 1; }); const d2 = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, count]) => ({ label, count })); return <VBarChart data={d2} labelKey="label" valueKey="count" />; })()}
                  {chartMode === "scatter" && scatterX && scatterY && <ScatterPlot rows={data.rows} xCol={scatterX} yCol={scatterY} colorCol={scatterC} />}
                  {chartMode === "line" && lineX && lineY && <LineChart data={data.rows} xKey={lineX} yKey={lineY} />}
                  {["pie", "donut"].includes(chartMode) && pieLabel && pieValue && (() => { const cnt = {}; data.rows.forEach(r => { const k = r[pieLabel]; const v = Number(r[pieValue]) || 0; cnt[k] = (cnt[k] || 0) + v; }); const d2 = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value })); return <PieChart data={d2} labelKey="label" valueKey="value" donut={chartMode === "donut"} />; })()}
                  {chartMode === "heatmap" && <Heatmap rows={data.rows} colTypes={data.colTypes} />}
                  {chartMode === "histogram" && <Histogram rows={data.rows} col={scatterX || numCols[0]?.name} />}
                  {chartMode === "boxplot" && <BoxPlot rows={data.rows} cols={data.colTypes} />}
                  {chartMode === "funnel" && funnelLabel && funnelValue && (() => { const cnt = {}; data.rows.forEach(r => { const k = r[funnelLabel]; const v = Number(r[funnelValue]) || 0; cnt[k] = (cnt[k] || 0) + v; }); const d2 = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value })); return <FunnelChart data={d2} labelKey="label" valueKey="value" />; })()}

                  <AIBlock text={chartAnalysis} loading={chartAnalysisLoading} label="Chart Analysis" />
                </div>
              </div>
            )}

            {/* ════════ AI CHARTS ════════ */}
            {activeTab === "ai charts" && data && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={card}>
                  <div style={{ ...lbl, marginBottom: 4 }}>AI Chart Builder</div>
                  <div style={{ fontSize: 13, color: T.muted, marginBottom: 14 }}>Describe what you want to visualize — AI picks the best chart type and columns automatically</div>
                  <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                    <input value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAIChart()} placeholder='e.g. "Show churn probability vs lifetime value" or "Sales breakdown by region as pie chart"' style={inp} />
                    <button onClick={handleAIChart} disabled={aiChartLoading} style={btnP}>{aiChartLoading ? "Building..." : "Build →"}</button>
                  </div>
                  {aiChartConfig && (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.txt }}>{aiChartConfig.title}</div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, background: "#eef2ff", color: "#6366f1", fontWeight: 600 }}>{aiChartConfig.type}</span>
                          <button onClick={() => addToDash({ ...aiChartConfig })} style={btnS}>📌 Pin</button>
                        </div>
                      </div>
                      {aiChartConfig.description && <div style={{ fontSize: 13, color: T.muted, marginBottom: 12 }}>{aiChartConfig.description}</div>}
                      {renderChartFromConfig(aiChartConfig, data.rows, data.colTypes)}
                    </div>
                  )}
                </div>
                <div style={card}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <div><div style={{ ...lbl, marginBottom: 3 }}>Smart Suggestions</div><div style={{ fontSize: 13, color: T.muted }}>AI recommends the most insightful visualizations for your data</div></div>
                    <button onClick={handleSuggestions} disabled={suggestLoading} style={btnP}>{suggestLoading ? "Analyzing..." : "Get Suggestions →"}</button>
                  </div>
                  {suggestions.length > 0 && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 12 }}>
                    {suggestions.map((s, i) => <div key={i} style={{ background: T.faint, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}><span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: "#eef2ff", color: "#6366f1", fontWeight: 600 }}>{s.type}</span><div style={{ fontSize: 13, fontWeight: 700, color: T.txt }}>{s.title}</div></div>
                      <div style={{ fontSize: 12, color: T.muted, marginBottom: 8, lineHeight: 1.5 }}>{s.description}</div>
                      {s.insight && <div style={{ fontSize: 12, color: "#6366f1", fontStyle: "italic" }}>Expected: {s.insight}</div>}
                    </div>)}
                  </div>}
                </div>
              </div>
            )}

            {/* ════════ SQL ════════ */}
            {activeTab === "sql" && data && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={card}>
                  <div style={{ ...lbl, marginBottom: 10 }}>Natural Language → SQL</div>
                  <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>Table: <code style={{ background: "#eef2ff", color: "#6366f1", padding: "2px 6px", borderRadius: 4 }}>"data"</code> · {data.headers.slice(0, 6).join(", ")}{data.headers.length > 6 ? ` +${data.headers.length - 6} more` : ""}</div>
                  <div style={{ fontSize: 11, color: T.muted, marginBottom: 10 }}>💡 Shortcut: <strong>Ctrl+Enter</strong> to run</div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <input value={nlQuery} onChange={e => setNlQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && handleNLQuery()} placeholder='"Average lifetime value by region" or "Show top 10 customers by purchase frequency"' style={inp} />
                    <button onClick={handleNLQuery} disabled={nlLoading} style={btnP}>{nlLoading ? "Thinking..." : "Run →"}</button>
                  </div>
                  {genSQL && <div style={{ marginTop: 12, background: T.faint, borderRadius: 8, padding: 12, border: `1px solid ${T.border}` }}><div style={{ ...lbl, marginBottom: 6 }}>Generated SQL</div><code style={{ color: "#10b981", fontSize: 12, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{genSQL}</code></div>}
                </div>
                {nlResult && (<div style={{ ...card, overflow: "hidden" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.txt }}>{nlResult.length.toLocaleString()} rows returned</div>
                    <button onClick={() => exportCSV(nlResult)} style={btnS}>⬇ Export CSV</button>
                  </div>
                  {nlResult.length > 0 && Object.keys(nlResult[0]).length === 2 && (() => { const keys = Object.keys(nlResult[0]); const numKey = keys.find(k => !isNaN(Number(nlResult[0][k]))); const lblKey = keys.find(k => k !== numKey); return numKey && lblKey ? <div style={{ marginBottom: 16 }}><HBarChart data={nlResult.slice(0, 12)} labelKey={lblKey} valueKey={numKey} /></div> : null; })()}
                  <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ background: T.faint }}>{nlResult[0] && Object.keys(nlResult[0]).map(h => <th key={h} style={{ padding: "9px 14px", textAlign: "left", color: T.muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${T.border}` }}>{h}</th>)}</tr></thead><tbody>{nlResult.slice(0, 50).map((row, i) => <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>{Object.values(row).map((v, j) => <td key={j} style={{ padding: "8px 14px", color: T.muted, fontFamily: "monospace", fontSize: 12 }}>{String(v).slice(0, 60)}</td>)}</tr>)}</tbody></table></div>
                  <AIBlock text={sqlAnalysis} loading={sqlAnalysisLoading} label="AI Analysis of Results" />
                </div>)}
                {sqlHistory.length > 0 && <div style={card}><div style={{ ...lbl, marginBottom: 12 }}>Query History</div><div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{sqlHistory.map((h, i) => <div key={i} onClick={() => setNlQuery(h.query)} style={{ padding: "10px 14px", background: T.faint, borderRadius: 8, border: `1px solid ${T.border}`, cursor: "pointer" }} onMouseEnter={e => e.currentTarget.style.borderColor = "#6366f1"} onMouseLeave={e => e.currentTarget.style.borderColor = T.border}><div style={{ fontSize: 13, color: T.txt, marginBottom: 2 }}>{h.query}</div><div style={{ fontSize: 11, color: T.muted }}>{h.rowCount} rows</div></div>)}</div></div>}
              </div>
            )}

            {/* ════════ INSIGHTS ════════ */}
            {activeTab === "insights" && data && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <div style={{ fontSize: 13, color: T.muted }}>AI-powered business findings with actionable recommendations</div>
                  <button onClick={handleInsights} disabled={insightsLoading} style={btnP}>{insightsLoading ? "Analyzing..." : (insights[activeFile]?.length ? "Refresh ↺" : "Generate Insights →")}</button>
                </div>
                {insightsLoading && <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12 }}>{Array(6).fill(0).map((_, i) => <div key={i} style={{ ...card, animation: "pulse2 1.5s ease-in-out infinite" }}><div style={{ width: "60%", height: 12, background: T.border, borderRadius: 4, marginBottom: 12 }} /><div style={{ width: "100%", height: 8, background: T.border, borderRadius: 4, marginBottom: 8 }} /><div style={{ width: "80%", height: 8, background: T.border, borderRadius: 4 }} /></div>)}</div>}
                {(insights[activeFile] || []).length > 0 && !insightsLoading && <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 14 }}>{(insights[activeFile] || []).map((ins, i) => { const s = sevStyle(ins.severity); return (<div key={i} style={{ background: s.bg, border: `1.5px solid ${s.border}`, borderRadius: 14, padding: 22, position: "relative" }}>{ins.metric && <div style={{ position: "absolute", top: 18, right: 20, fontSize: 20, fontWeight: 800, color: "#6366f1", opacity: 0.8 }}>{ins.metric}</div>}<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: s.dot }} /><div style={{ fontSize: 11, fontWeight: 700, color: s.txt, letterSpacing: "0.08em", textTransform: "uppercase" }}>{ins.title}</div></div><div style={{ fontSize: 13, color: "#374151", lineHeight: 1.7, marginBottom: 10 }}>{ins.insight}</div>{ins.recommendation && <div style={{ fontSize: 12, color: "#6366f1", fontWeight: 600 }}>→ {ins.recommendation}</div>}</div>); })}</div>}
                {!insights[activeFile]?.length && !insightsLoading && <div style={{ textAlign: "center", padding: "60px", color: T.muted }}><div style={{ fontSize: 40, marginBottom: 12 }}>✦</div><div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>No insights generated yet</div><div style={{ fontSize: 13 }}>Click Generate Insights to run AI analysis</div></div>}
              </div>
            )}

            {/* ════════ REPORT ════════ */}
            {activeTab === "report" && data && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={card}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div><div style={{ ...lbl, marginBottom: 3 }}>Executive Report Generator</div><div style={{ fontSize: 13, color: T.muted }}>AI writes a professional 500-700 word business analysis report</div></div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {reportText && <button onClick={copyReport} style={btnS}>📋 Copy</button>}
                      {reportText && <button onClick={exportPDF} style={btnS}>📄 PDF</button>}
                      <button onClick={generateReport} disabled={reportLoading} style={btnP}>{reportLoading ? "Writing Report..." : "Generate Report →"}</button>
                    </div>
                  </div>
                  {reportLoading && <div style={{ marginTop: 16 }}>{[100, 85, 92, 78, 88, 95].map((w, i) => <div key={i} style={{ height: 10, background: T.border, borderRadius: 4, width: `${w}%`, marginBottom: 10, animation: `pulse2 1.5s ease-in-out ${i * 0.15}s infinite` }} />)}</div>}
                  {reportText && <div style={{ marginTop: 16, background: T.faint, border: `1px solid ${T.border}`, borderRadius: 12, padding: 24 }}><div style={{ fontSize: 14, color: T.txt, lineHeight: 1.9, whiteSpace: "pre-wrap" }}>{reportText}</div></div>}
                </div>
              </div>
            )}

            {/* ════════ PIVOT ════════ */}
            {activeTab === "pivot" && data && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={card}>
                  <div style={{ ...lbl, marginBottom: 14 }}>Pivot Table Builder</div>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Row</div><select value={pivotRow} onChange={e => setPivotRow(e.target.value)} style={sel}><option value="">Select...</option>{data.colTypes.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Column</div><select value={pivotCol} onChange={e => setPivotCol(e.target.value)} style={sel}><option value="">Select...</option>{data.colTypes.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Value</div><select value={pivotVal} onChange={e => setPivotVal(e.target.value)} style={sel}><option value="">Select...</option>{numCols.map(c => <option key={c.name}>{c.name}</option>)}</select></div>
                    <div><div style={{ ...lbl, marginBottom: 5 }}>Aggregation</div><select value={pivotAgg} onChange={e => setPivotAgg(e.target.value)} style={sel}><option value="count">Count</option><option value="sum">Sum</option><option value="avg">Average</option><option value="max">Max</option><option value="min">Min</option></select></div>
                  </div>
                  {pivot && (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: 400 }}>
                        <thead>
                          <tr style={{ background: T.faint }}>
                            <th style={{ padding: "9px 14px", textAlign: "left", color: "#6366f1", fontWeight: 700, fontSize: 11, borderBottom: `2px solid ${T.border}`, borderRight: `1px solid ${T.border}` }}>{pivotRow} \ {pivotCol}</th>
                            {pivot.colVals.map(cv => <th key={cv} style={{ padding: "9px 14px", textAlign: "center", color: T.muted, fontWeight: 600, fontSize: 11, borderBottom: `2px solid ${T.border}`, borderRight: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>{String(cv).slice(0, 16)}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {pivot.rowVals.map((rv, ri) => (
                            <tr key={rv} style={{ background: ri % 2 === 0 ? "transparent" : T.faint }}>
                              <td style={{ padding: "8px 14px", fontWeight: 700, color: T.txt, borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>{String(rv).slice(0, 20)}</td>
                              {pivot.colVals.map(cv => {
                                const val = pivot.agg(pivot.table[rv][cv] || []);
                                return <td key={cv} style={{ padding: "8px 14px", textAlign: "center", color: val === "—" ? T.border : T.muted, fontFamily: "monospace", borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` }}>{val}</td>;
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {!pivot && <div style={{ textAlign: "center", padding: 40, color: T.muted, fontSize: 13 }}>Select Row, Column, and Value fields above to build your pivot table</div>}
                </div>
              </div>
            )}

            {/* ════════ CLEAN ════════ */}
            {activeTab === "clean" && data && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 10 }}>
                  {[{ label: "Remove Duplicates", desc: "Delete identical rows", fn: removeDuplicates, color: "#f59e0b" }, { label: "Fill Missing Values", desc: "Replace blanks with mean/mode", fn: fillNulls, color: "#6366f1" }, { label: "Trim Whitespace", desc: "Clean text spaces", fn: trimStrings, color: "#10b981" }, { label: "Reset to Original", desc: "Undo all changes", fn: resetData, color: "#ef4444" }].map(op => (
                    <button key={op.label} onClick={op.fn} style={{ background: T.surface, border: `1.5px solid ${op.color}30`, borderRadius: 12, padding: "16px 18px", cursor: "pointer", textAlign: "left", fontFamily: "inherit", transition: "border-color 0.15s" }} onMouseEnter={e => e.currentTarget.style.borderColor = op.color} onMouseLeave={e => e.currentTarget.style.borderColor = `${op.color}30`}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: op.color, marginBottom: 5 }}>{op.label}</div>
                      <div style={{ fontSize: 12, color: T.muted }}>{op.desc}</div>
                    </button>
                  ))}
                </div>
                <div style={card}><div style={{ ...lbl, marginBottom: 12 }}>Rename Column</div><div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><select value={renameCol} onChange={e => setRenameCol(e.target.value)} style={sel}><option value="">Select column</option>{data.headers.map(h => <option key={h}>{h}</option>)}</select><span style={{ color: T.muted }}>→</span><input value={renameTo} onChange={e => setRenameTo(e.target.value)} placeholder="New name" style={{ ...inp, flex: "0 1 180px" }} /><button onClick={doRename} style={btnP}>Rename</button></div></div>
                <div style={card}>
                  <div style={{ ...lbl, marginBottom: 4 }}>Column Calculator</div>
                  <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>Create new columns from formulas. Reference columns as [ColumnName]. Example: [Price] * [Quantity] or [Salary] / 12</div>
                  <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}><input value={calcName} onChange={e => setCalcName(e.target.value)} placeholder="New column name" style={{ ...inp, flex: "0 1 180px" }} /><span style={{ color: T.muted, alignSelf: "center" }}>=</span><input value={calcFormula} onChange={e => setCalcFormula(e.target.value)} placeholder="[Col1] * [Col2] + 100" style={inp} /></div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 10 }}><button onClick={previewCalc} style={btnS}>Preview</button><button onClick={applyCalc} style={btnP}>Add Column</button></div>
                  {calcError && <div style={{ color: "#ef4444", fontSize: 12 }}>{calcError}</div>}
                  {calcPreview && <div style={{ overflowX: "auto" }}><table style={{ borderCollapse: "collapse", fontSize: 11 }}><thead><tr>{Object.keys(calcPreview[0]).slice(-3).map(h => <th key={h} style={{ padding: "6px 10px", color: T.muted, textAlign: "left", borderBottom: `1px solid ${T.border}`, background: T.faint }}>{h}</th>)}</tr></thead><tbody>{calcPreview.map((r, i) => <tr key={i}>{Object.entries(r).slice(-3).map(([k, v]) => <td key={k} style={{ padding: "6px 10px", color: k === calcName ? "#6366f1" : T.muted, borderBottom: `1px solid ${T.border}`, fontWeight: k === calcName ? 700 : 400 }}>{String(v).slice(0, 25)}</td>)}</tr>)}</tbody></table></div>}
                </div>
                <div style={card}><div style={{ ...lbl, marginBottom: 10 }}>Change Log</div>{cleanLog.length ? <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>{cleanLog.map((l, i) => <div key={i} style={{ fontSize: 12, color: "#10b981", padding: "6px 10px", background: "#d1fae5", borderRadius: 6 }}>{l}</div>)}</div> : <div style={{ fontSize: 13, color: T.muted }}>No changes yet.</div>}</div>
              </div>
            )}

            {/* ════════ COMPARE ════════ */}
            {activeTab === "compare" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {files.length < 2 ? (
                  <div style={{ ...card, textAlign: "center", padding: 60 }}>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>⇄</div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: T.txt, marginBottom: 8 }}>Load 2 CSV or Excel files to compare</div>
                    <div style={{ fontSize: 13, color: T.muted, marginBottom: 20 }}>Use the "+ CSV/Excel" button in the header to load a second file</div>
                    <button onClick={() => fileRef.current.click()} style={btnP}>Load Second File</button>
                  </div>
                ) : (<>
                  <div style={card}>
                    <div style={{ ...lbl, marginBottom: 14 }}>Select Files to Compare</div>
                    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
                      <div><div style={{ ...lbl, marginBottom: 5 }}>File A</div><select value={cmpA} onChange={e => setCmpA(Number(e.target.value))} style={sel}>{files.map((f, i) => <option key={i} value={i}>{f.name}</option>)}</select></div>
                      <div style={{ fontSize: 20, color: T.muted, marginTop: 20 }}>⇄</div>
                      <div><div style={{ ...lbl, marginBottom: 5 }}>File B</div><select value={cmpB} onChange={e => setCmpB(Number(e.target.value))} style={sel}>{files.map((f, i) => <option key={i} value={i}>{f.name}</option>)}</select></div>
                      <button onClick={handleCompare} disabled={cmpLoading || cmpA === cmpB} style={{ ...btnP, alignSelf: "flex-end" }}>{cmpLoading ? "Comparing..." : "Compare →"}</button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                      {[cmpA, cmpB].map((fi, idx) => { const f = files[fi]; if (!f) return null; const nums = f.colTypes.filter(c => c.type === "number"); return (<div key={idx} style={{ background: T.faint, borderRadius: 10, padding: 16, border: `1px solid ${T.border}` }}><div style={{ fontSize: 13, fontWeight: 700, color: idx === 0 ? "#6366f1" : "#10b981", marginBottom: 12 }}>{f.name}</div><div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>{[["Rows", f.rows.length.toLocaleString()], ["Cols", f.headers.length], ["Numeric", nums.length]].map(([l, v]) => <div key={l} style={{ background: T.surface, borderRadius: 8, padding: "8px 12px" }}><div style={{ fontSize: 10, color: T.muted }}>{l}</div><div style={{ fontSize: 16, fontWeight: 700, color: T.txt }}>{v}</div></div>)}</div>{nums.slice(0, 4).map(c => { const s = computeStats(f.rows, c.name); return s ? <div key={c.name} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.muted, marginBottom: 4, padding: "4px 0", borderBottom: `1px solid ${T.border}` }}><span>{c.name}</span><span style={{ color: T.txt, fontFamily: "monospace" }}>μ={fmt(s.mean)}</span></div> : null; })}</div>); })}
                    </div>
                  </div>
                  {cmpResult && <div style={card}>
                    <div style={{ ...lbl, marginBottom: 14 }}>AI Comparison Analysis</div>
                    <div style={{ fontSize: 13, color: T.txt, lineHeight: 1.7, marginBottom: 16, padding: 16, background: T.faint, borderRadius: 10, border: `1px solid ${T.border}` }}>{cmpResult.summary}</div>
                    {cmpResult.keyMetrics?.length > 0 && <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 16 }}>{cmpResult.keyMetrics.map((m, i) => <div key={i} style={{ background: T.faint, borderRadius: 10, padding: 14, border: `1px solid ${T.border}`, textAlign: "center" }}><div style={{ fontSize: 11, color: T.muted, marginBottom: 6 }}>{m.label}</div><div style={{ fontSize: 12, color: "#6366f1", fontWeight: 600 }}>{m.fileA}</div><div style={{ fontSize: 11, color: T.muted }}>vs</div><div style={{ fontSize: 12, color: "#10b981", fontWeight: 600 }}>{m.fileB}</div></div>)}</div>}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                      <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10, padding: 16 }}><div style={{ fontSize: 11, fontWeight: 700, color: "#166534", marginBottom: 10 }}>SIMILARITIES</div>{(cmpResult.similarities || []).map((s, i) => <div key={i} style={{ fontSize: 12, color: "#374151", marginBottom: 6, paddingLeft: 8, borderLeft: "2px solid #10b981" }}>• {s}</div>)}</div>
                      <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 10, padding: 16 }}><div style={{ fontSize: 11, fontWeight: 700, color: "#92400e", marginBottom: 10 }}>DIFFERENCES</div>{(cmpResult.differences || []).map((s, i) => <div key={i} style={{ fontSize: 12, color: "#374151", marginBottom: 6, paddingLeft: 8, borderLeft: "2px solid #f59e0b" }}>• {s}</div>)}</div>
                    </div>
                    {cmpResult.recommendation && <div style={{ marginTop: 14, fontSize: 13, color: "#6366f1", padding: 14, background: "#eef2ff", borderRadius: 10, border: "1px solid #c7d2fe", fontWeight: 500 }}>→ {cmpResult.recommendation}</div>}
                  </div>}
                </>)}
              </div>
            )}

            {/* ════════ CHAT ════════ */}
            {activeTab === "chat" && (
              <div>
                <div style={{ ...card, padding: 0, overflow: "hidden", display: "flex", flexDirection: "column", height: 500, marginBottom: 12 }}>
                  <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#10b981" }} />
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.txt }}>AI Assistant {data ? `· analyzing ${data.name}` : ""}</div>
                  </div>
                  <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
                    {chatMsgs.map((m, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                        {m.role === "assistant" && <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#fff", flexShrink: 0, marginRight: 8, marginTop: 2 }}>✦</div>}
                        <div style={{ maxWidth: "75%", padding: "12px 16px", borderRadius: m.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px", background: m.role === "user" ? "linear-gradient(135deg,#6366f1,#8b5cf6)" : "transparent", border: m.role === "user" ? "none" : `1px solid ${T.border}`, color: m.role === "user" ? "#fff" : T.txt, fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                          {m.text.replace(/\*\*(.*?)\*\*/g, "$1")}
                        </div>
                      </div>
                    ))}
                    {chatLoading && <div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#fff" }}>✦</div><div style={{ display: "flex", gap: 4, padding: "12px 16px", background: T.surface, borderRadius: "14px 14px 14px 4px", border: `1px solid ${T.border}` }}>{[0, 1, 2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#6366f1", animation: `bounce2 1s ease-in-out ${i * 0.2}s infinite` }} />)}</div></div>}
                    <div ref={chatEndRef} />
                  </div>
                  <div style={{ padding: "12px 16px", borderTop: `1px solid ${T.border}`, display: "flex", gap: 8 }}>
                    <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleChat()} placeholder="Ask anything about your data..." style={{ ...inp, fontSize: 13 }} />
                    <button onClick={handleChat} disabled={chatLoading} style={btnP}>Send</button>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {["What are the main trends?", "Which column has most outliers?", "Summarize in 3 bullet points", "What should we investigate further?", "Any data quality issues?", "Give me 3 business recommendations"].map(q => <button key={q} onClick={() => setChatInput(q)} style={{ fontSize: 11, padding: "7px 14px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 20, color: T.muted, cursor: "pointer", fontFamily: "inherit" }}>{q}</button>)}
                </div>
              </div>
            )}

            {/* ════════ DASHBOARD ════════ */}
            {activeTab === "dashboard" && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <div style={{ fontSize: 13, color: T.muted }}>Pin charts from any tab using the 📌 button to build your dashboard</div>
                  {dashCharts.length > 0 && <button onClick={() => setDashCharts([])} style={btnS}>Clear All</button>}
                </div>
                {dashCharts.length === 0 ? (
                  <div style={{ ...card, textAlign: "center", padding: 60 }}>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>📌</div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: T.txt, marginBottom: 6 }}>Dashboard is empty</div>
                    <div style={{ fontSize: 13, color: T.muted }}>Go to Charts or AI Charts and click 📌 to pin charts here</div>
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(460px,1fr))", gap: 16 }}>
                    {dashCharts.map((chart, i) => {
                      const d = files[chart.fileIdx] || files[0]; if (!d) return null;
                      return (
                        <div key={chart.id} style={card}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                            <div><div style={{ fontSize: 14, fontWeight: 700, color: T.txt }}>{chart.title || "Chart"}</div><div style={{ fontSize: 11, color: T.muted }}>{chart.fileName} · {chart.type}</div></div>
                            <button onClick={() => setDashCharts(dc => dc.filter((_, di) => di !== i))} style={{ fontSize: 12, background: "transparent", border: "none", color: T.muted, cursor: "pointer" }}>✕</button>
                          </div>
                          {renderChartFromConfig(chart, d.rows, d.colTypes)}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ════════ EXPORT ════════ */}
            {activeTab === "export" && data && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 12 }}>
                  {[{ icon: "📄", label: "Export Full CSV", desc: `All ${data.rows.length.toLocaleString()} rows`, color: "#10b981", fn: () => exportCSV() }, { icon: "📊", label: "PDF Report", desc: "Stats + insights + data preview", color: "#6366f1", fn: exportPDF }, { icon: "📋", label: "Copy AI Report", desc: "Copy executive report to clipboard", color: "#f59e0b", fn: () => { if (!reportText) { alert("Generate report first in the Report tab."); return; } copyReport(); } }, { icon: "🔍", label: "Export Filtered", desc: `${frows.length.toLocaleString()} filtered rows`, color: "#8b5cf6", fn: () => exportCSV(frows) }].map(op => (
                    <button key={op.label} onClick={op.fn} style={{ background: T.surface, border: `1.5px solid ${op.color}30`, borderRadius: 14, padding: "22px 20px", cursor: "pointer", textAlign: "left", fontFamily: "inherit", transition: "all 0.15s" }} onMouseEnter={e => { e.currentTarget.style.borderColor = op.color; e.currentTarget.style.background = `${op.color}08`; }} onMouseLeave={e => { e.currentTarget.style.borderColor = `${op.color}30`; e.currentTarget.style.background = T.surface; }}>
                      <div style={{ fontSize: 28, marginBottom: 10 }}>{op.icon}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: op.color, marginBottom: 5 }}>{op.label}</div>
                      <div style={{ fontSize: 12, color: T.muted }}>{op.desc}</div>
                    </button>
                  ))}
                </div>
                <div style={card}>
                  <div style={{ ...lbl, marginBottom: 14 }}>Dataset Summary</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
                    {[["File", data.name], ["Rows", data.rows.length.toLocaleString()], ["Columns", data.headers.length], ["Numeric", numCols.length], ["Text", catCols.length], ["Changes", cleanLog.filter(l => !l.includes("Reset")).length]].map(([k, v]) => (
                      <div key={k} style={{ background: T.faint, borderRadius: 10, padding: "12px 14px" }}>
                        <div style={{ fontSize: 10, color: T.muted, marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.06em" }}>{k}</div>
                        <div style={{ fontSize: 14, color: T.txt, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <style>{`
        @keyframes pulse2 { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes bounce2 { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-5px)} }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
        input::placeholder { color: #9ca3af; }
      `}</style>
    </div>
  );
}
