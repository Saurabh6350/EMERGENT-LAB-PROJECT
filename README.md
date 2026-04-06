# AI Data Analytics Studio — v2
### Powered by Groq (Llama 3.3 70B) — 100% Free

Upload any CSV → instant charts with tooltips, AI-powered intelligence, and actionable insights.

---

## 🆕 What's New in v2 (7 Major Upgrades)

### 1. Hover Tooltips on All Charts
Every chart now shows exact values, labels, and percentages on hover.
Works on: bar, line, scatter, pie, heatmap.

### 2. Proper Axis Labels, Chart Titles & Legends
All charts now have clear X/Y axis titles, a chart title, and color legends.
Download any chart as a PNG image with the ⬇ PNG button.

### 3. Download Chart as PNG
Every chart has a download button — drop charts directly into PowerPoint, Word, or Slack.
Uses SVG-to-canvas conversion for crisp, high-resolution output.

### 4. Automatic Anomaly Detection (runs on upload, no clicks needed)
On every file upload the app automatically:
- Detects missing values (per column, with % affected)
- Flags statistical outliers (IQR method)
- Finds duplicate rows
- Identifies constant/zero-variance columns
- Computes a Data Quality Score (0-100)

Orange warning banner appears in the header if issues are found.

### 5. Date / Time Intelligence
Automatically detects date columns from formats: YYYY-MM-DD, MM/DD/YYYY, Month DD YYYY, etc.
New "DATETIME" tab lets you:
- Group any numeric column by Year / Quarter / Month / Week
- View a time series line chart
- See a summary table with sum, average, count per period
- Inspect date range and span for each date column

### 6. Smart Correlation Finder
Automatically computes all column-pair correlations on upload.
New "CORRELATIONS" tab shows:
- Top 5 strongest relationships with strength bars
- Direction (positive/negative) and exact Pearson r value
- "Explain Correlations" button gets AI plain-English narrative of what each correlation means for business

### 7. AI Customer Segmentation
New "SEGMENTS" tab:
- AI groups your rows into 3-4 named segments (e.g. "High-value loyalists", "At-risk occasionals")
- Each segment gets a name, description, estimated size %, criteria, and an actionable insight
- Shows recommended column name to add to your data

### 8. Goal-Based Analysis (unique — no other free tool has this)
New "GOAL" tab:
- Type a business goal: "Reduce churn by 20%", "Increase revenue", etc.
- AI identifies which columns are relevant, surfaces 3 key findings from the actual data
- Generates a data-driven 3-step action plan
- Flags risk factors based on the data

---

## Tabs Overview

| Tab | Description |
|-----|-------------|
| Overview | Column stats, search/filter, data table |
| **Anomalies** 🆕 | Auto data quality report with quality score |
| Charts | Scatter, line, bar, pie, heatmap, histogram — all with tooltips + PNG export |
| AI Charts | AI chart builder + smart suggestions |
| SQL | Natural language → SQL queries |
| Insights | 6 AI business findings |
| **Correlations** 🆕 | Top correlations + AI narrative |
| **Segments** 🆕 | AI customer/row segmentation |
| **Goal** 🆕 | Goal-based analysis & action plan |
| **Datetime** 🆕 | Date column detection + time series |
| Clean | Remove dupes, fill nulls, rename, calculator |
| Compare | Compare two CSV files with AI |
| Chat | AI Q&A about your data |
| Dashboard | Pinned charts |
| Export | CSV, PDF report, clipboard |

---

## Setup

### Step 1 — Get a FREE Groq API Key
1. Go to → https://console.groq.com
2. Sign up (free, no credit card)
3. Go to API Keys → Create API Key
4. Copy the key

### Step 2 — Add Your API Key
1. Copy `.env.example` → rename to `.env`
2. Open `.env` and paste your key:
   ```
   REACT_APP_GROQ_API_KEY=gsk_XXXXXXXXXXXXXXXXXXXX
   ```

### Step 3 — Install and Run
```bash
npm install
npm start
```
Opens at http://localhost:3000

---

## Deploy Free on Vercel
1. Push to GitHub
2. vercel.com → New Project → import repo
3. Add env var: `REACT_APP_GROQ_API_KEY` = your key
4. Deploy — done

---

## Troubleshooting
- `npm not found` → install Node.js from nodejs.org
- AI shows error → check `.env` has correct key (starts with `gsk_`)
- `.env` not visible → enable hidden files in your file explorer
- Charts not downloading → try a different browser (Chrome recommended)
