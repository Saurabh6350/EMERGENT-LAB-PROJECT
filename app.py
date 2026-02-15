import streamlit as st
from src.data_loader import load_data
from src.analysis import analyze
from src.visualize import create_chart
from src.llm_engine import interpret_query

st.title("Natural Language Driven Data Analytics & Visualization System")

uploaded = st.file_uploader("Upload CSV Dataset", type=["csv"])

if uploaded:

    df = load_data(uploaded)

    st.subheader("Dataset Preview")
    st.write(df.head())

    query = st.text_input("Ask a question about your data:")

    if st.button("Analyze") and query:

        # AI interpretation
        instruction = interpret_query(query, df.columns.tolist())
        st.write("### AI Interpretation")
        st.write(instruction)

        # Data analysis
        result = analyze(df, query)

        if result is not None:
            st.write("### Result Table")
            st.write(result)

            chart = create_chart(result)
            st.pyplot(chart)
        else:
            st.error("Could not understand query. Try another question.")
