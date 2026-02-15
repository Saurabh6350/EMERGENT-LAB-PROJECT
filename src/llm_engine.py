import os
from dotenv import load_dotenv

# Try importing OpenAI safely
try:
    from openai import OpenAI
    openai_available = True
except:
    openai_available = False

load_dotenv()

client = None
if openai_available and os.getenv("OPENAI_API_KEY"):
    try:
        client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    except:
        client = None


def local_interpretation(query):
    """
    Fallback logic when API quota is not available.
    """
    q = query.lower()

    if "lifetime" in q and "region" in q:
        return "Group by Region and sum Lifetime_Value"

    if "average" in q and "region" in q:
        return "Group by Region and average Average_Order_Value"

    if "churn" in q and "region" in q:
        return "Group by Region and average Churn_Probability"

    if "retention" in q or "strategy" in q:
        return "Count Retention_Strategy distribution"

    if "season" in q:
        return "Count Season distribution"

    return "General data analysis query"


def interpret_query(query, columns):
    """
    Try real OpenAI → if fails, use local fallback.
    """

    # If OpenAI not available, use fallback
    if client is None:
        return local_interpretation(query)

    try:
        response = client.chat.completions.create(
            model="gpt-4.1-mini",
            messages=[{"role": "user", "content": query}],
        )
        return response.choices[0].message.content

    except Exception:
        # Any API error → fallback
        return local_interpretation(query)
