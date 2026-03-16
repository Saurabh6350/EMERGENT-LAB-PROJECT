# 📊 AI-Powered Natural Language Data Analytics Platform

## 🚀 Project Overview

This project is an AI-driven data analytics web application that allows users to upload datasets and perform advanced analytics using natural language queries.

The system integrates Artificial Intelligence concepts, automated data processing, visualization, natural language SQL querying, AutoML predictive analytics, and automated report generation.

The platform simulates modern intelligent analytics tools such as Power BI + ChatGPT + AutoML platforms.

---

## 🎯 Objectives

- Enable non-technical users to analyze datasets easily  
- Provide automated insights using AI techniques  
- Allow conversational interaction with data  
- Automate machine learning model training and prediction  
- Generate downloadable analytics reports  

---

## 🧠 Components Used in the Project

### 1️⃣ Artificial Intelligence Assistant

The AI assistant enables conversational interaction with the dataset.

Users can ask questions like:

- How many rows are in the dataset?
- Show dataset summary
- Show missing values

The assistant processes the dataset context and returns intelligent responses.

---

### 2️⃣ Natural Language to SQL Engine

The system converts natural language queries into SQL statements.

Example queries:

- count rows  
- average glucose  
- show all data  

These queries are executed on an in-memory SQLite database created from the uploaded dataset.

---

### 3️⃣ Automatic Data Processing Module

After dataset upload, the system automatically performs:

- duplicate removal  
- missing value handling  
- categorical feature encoding  

This ensures the dataset is ready for analytics and machine learning.

---

### 4️⃣ AutoML Predictive Analytics Module

The system automatically:

- detects the target column (last column)
- determines whether the problem is classification or regression
- trains multiple machine learning models
- selects the best performing model

Models used include:

- Logistic / Linear Regression  
- Decision Tree  
- Random Forest  

---

### 5️⃣ Prediction Interface

After training:

- users enter feature values  
- system predicts output using the trained model  

---

### 6️⃣ AI Analytics Report Generator

The system generates a downloadable PDF report containing:

- dataset insights  
- model performance  
- prediction result  

---

## ✨ Key Features

- Upload any CSV dataset  
- Conversational AI dataset assistant  
- Natural language SQL querying  
- Automatic dataset cleaning  
- AutoML model selection  
- Prediction interface  
- Automated analytics PDF report  

---

## 🏗️ System Workflow
