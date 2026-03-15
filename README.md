# 📊 DATA ANALYTICS PLATFORM

> A full-featured, AI-powered data analytics web app built with React.  
> Upload any CSV file and instantly get charts, SQL queries, AI insights, and more — all in your browser.

![React](https://img.shields.io/badge/React-18-61DAFB?style=flat&logo=react)
![AI](https://img.shields.io/badge/AI-Groq%20LLaMA%203.3-F55036?style=flat)
![Free](https://img.shields.io/badge/API-Free%20Tier-34D399?style=flat)
![License](https://img.shields.io/badge/License-MIT-818CF8?style=flat)

---

## 🚀 Live Demo

> Run locally in 3 commands — see setup below

---

## ✨ Features

| Tab | What It Does |
|---|---|
| **Overview** | Column stats, data types, live search & filter across all rows |
| **Charts** | Scatter, line, bar, pie, heatmap, histogram — with 📌 pin to dashboard |
| **AI Charts** | Describe a chart in plain English → AI builds it automatically |
| **SQL** | Ask questions in plain English → AI writes and runs the SQL |
| **Insights** | AI generates 6 business findings with recommendations |
| **Clean** | Remove duplicates, fill nulls, trim whitespace, rename columns |
| **Compare** | Load 2 CSV files and compare them side by side with AI analysis |
| **Chat** | Have a full conversation with your data |
| **Dashboard** | Pin your favourite charts into a personal dashboard |
| **Export** | Download CSV, generate PDF report, copy summary to clipboard |

### 🎨 Extra Features
- **Dark / Light theme** toggle
- **Multiple CSV files** — load and switch between files in the header
- **Column Calculator** — create new columns using formulas like `[Price] * [Quantity]`
- **Smart AI Suggestions** — AI recommends the best visualizations for your data
- **Query History** — saves your last 10 SQL queries

---

## 🛠️ Tech Stack

- **Frontend** — React 18
- **AI** — Groq API (LLaMA 3.3 70B) — free tier, 14,400 requests/day
- **Charts** — Built from scratch using pure SVG
- **Styling** — Inline styles with CSS variables for theming
- **No backend** — runs entirely in the browser

---

## ⚡ Quick Start

### 1 — Prerequisites

Make sure you have **Node.js** installed.  
Download from 👉 https://nodejs.org (click the LTS button)

Check it is installed by opening CMD and typing:
```bash
node --version
```
You should see a version number like `v20.11.0`

---

### 2 — Get a Free Groq API Key

1. Go to 👉 https://console.groq.com
2. Sign up with Google or email — it is free
3. Click **API Keys** in the left sidebar
4. Click **Create API Key** → copy the key (starts with `gsk_...`)

> **Free tier:** 14,400 requests per day — more than enough for personal use

---

### 3 — Clone or Download the Project

**Option A — Clone with Git:**
```bash
git clone https://github.com/Saurabh6350/EMERGENT-LAB-PROJECT.git
cd EMERGENT-LAB-PROJECT
```

**Option B — Download ZIP:**
1. Click the green **Code** button on this page
2. Click **Download ZIP**
3. Unzip the folder

---

### 4 — Add Your API Key

1. Find the file called `.env.example` in the project folder
2. Make a copy of it and rename the copy to `.env`
3. Open `.env` with Notepad and replace the placeholder with your key:

```
REACT_APP_GROQ_API_KEY=gsk_your_actual_key_here
```

4. Save the file

> ⚠️ Never share your `.env` file or commit it to GitHub — it is already in `.gitignore`

---

### 5 — Install and Run

Open CMD inside the project folder and run:

```bash
npm install
```
Wait 1–2 minutes for packages to download, then:

```bash
npm start
```

Your browser opens automatically at **http://localhost:3000** 🎉

---

## 📁 Project Structure

```
EMERGENT-LAB-PROJECT/
├── public/
│   └── index.html          # HTML entry point
├── src/
│   ├── App.jsx             # Main application (all features in one file)
│   └── index.js            # React entry point
├── .env.example            # API key template
├── .gitignore              # Prevents .env and node_modules from uploading
├── package.json            # Project dependencies
└── README.md               # This file
```

---

## 🎯 How to Use

### Upload Data
- Drag and drop any `.csv` file onto the upload area
- Or click to browse your computer
- You can load **multiple CSV files** at once

### Natural Language SQL
Type questions like:
- *"Show top 10 rows by sales"*
- *"Average salary by department"*
- *"Count rows where status equals active"*

The AI converts your question to SQL and runs it instantly.

### AI Chart Builder
Go to the **AI Charts** tab and type things like:
- *"Show me revenue by region as a bar chart"*
- *"Compare age and income"*
- *"Which category has the most orders"*

### Column Calculator
Go to **Clean** tab → Column Calculator.  
Create new columns using formulas:
- `[Price] * [Quantity]` → calculates total
- `[Salary] / 12` → calculates monthly salary
- `[Score] * 100` → converts to percentage

---

## 🚀 Deploy Online for Free

### Deploy on Vercel (Recommended)

1. Push your code to GitHub (without the `.env` file)
2. Go to 👉 https://vercel.com → sign in with GitHub
3. Click **New Project** → import your repository
4. Under **Environment Variables** add:
   - Name: `REACT_APP_GROQ_API_KEY`
   - Value: your Groq API key
5. Click **Deploy**

Your app will be live at a free public URL in about 1 minute!

---

## 🔧 Troubleshooting

| Problem | Fix |
|---|---|
| `npm` not recognized | Install Node.js from nodejs.org and restart CMD |
| AI features not working | Check your `.env` file has the correct Groq API key |
| `.env` file not visible | Enable hidden files — View → check Hidden Items |
| `npm install` fails | Try `npm install --legacy-peer-deps` |
| Port 3000 already in use | Press `Y` when asked to use a different port |
| Quota exceeded error | You hit the free daily limit — wait until tomorrow, it resets automatically |

---

## 📌 Roadmap

- [ ] Support for Excel (.xlsx) files
- [ ] Save and load dashboards
- [ ] More chart types (box plot, bubble chart)
- [ ] Multi-language support
- [ ] Backend API for larger datasets

---

## 🤝 Contributing

Contributions are welcome! Feel free to:
1. Fork the repository
2. Create a new branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Commit (`git commit -m "Add your feature"`)
5. Push (`git push origin feature/your-feature`)
6. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License — feel free to use it for personal or commercial projects.

---

## 👨‍💻 Author

**Saurabh** — [@Saurabh6350](https://github.com/Saurabh6350)

---

## ⭐ Support

If you found this project useful, please consider giving it a **star** on GitHub!  
It helps others discover the project.

> Built with ❤️ using React and Groq AI
