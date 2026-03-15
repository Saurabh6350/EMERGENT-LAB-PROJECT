# AI Data Analytics Studio
### Powered by Google Gemini — 100% Free

Upload any CSV → instant charts, natural language SQL, and AI-powered insights.
No credit card. No cost. 1,500 free requests per day.

---

## Features

- **Overview** — Column stats, data types, full data preview
- **Natural Language → SQL** — Ask questions in plain English, Gemini writes and runs the SQL
- **Automated Insights** — AI analyzes your data and surfaces 6 key business findings
- **Explore** — Histograms, categorical breakdowns, anomaly detection

---

## Step 1 — Get Your FREE Gemini API Key

1. Go to → https://aistudio.google.com/app/apikey
2. Sign in with your Google account
3. Click "Create API Key"
4. Copy the key (looks like: AIzaSy...)

## Step 2 — Install Node.js (skip if already done)

Download from https://nodejs.org → LTS version → install it.

## Step 3 — Add Your API Key

1. Find .env.example in this folder
2. Make a copy → rename it to .env
3. Open .env and replace your_gemini_api_key_here with your real key:
   REACT_APP_GEMINI_API_KEY=AIzaSyXXXXXXXXXXXX

## Step 4 — Install and Run

Open a terminal in this folder, then:

    npm install

Wait 1-2 mins, then:

    npm start

Browser opens at http://localhost:3000

---

## Deploy Free on Vercel

1. Push folder to GitHub
2. Go to vercel.com → New Project → import repo
3. Add environment variable: REACT_APP_GEMINI_API_KEY = your key
4. Deploy — free public URL in ~1 minute

---

## Troubleshooting

- npm not found → install Node.js from nodejs.org
- AI shows error → check .env file has correct key
- .env not visible → enable hidden files in your file explorer
- npm install fails → try: npm install --legacy-peer-deps

---

Free tier: 1,500 requests/day, $0 cost.
