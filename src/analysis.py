def analyze(df, query):

    query = query.lower()

    # 1. Lifetime value by region
    if "lifetime" in query and "region" in query:
        return df.groupby("Region")["Lifetime_Value"].sum()

    # 2. Average order value by region
    if "average order" in query and "region" in query:
        return df.groupby("Region")["Average_Order_Value"].mean()

    # 3. Churn probability by region
    if "churn" in query and "region" in query:
        return df.groupby("Region")["Churn_Probability"].mean()

    # 4. Retention strategy count
    if "retention" in query or "strategy" in query:
        return df["Retention_Strategy"].value_counts()

    # 5. Season distribution
    if "season" in query:
        return df["Season"].value_counts()

    return None
