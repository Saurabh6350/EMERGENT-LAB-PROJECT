import matplotlib.pyplot as plt

def create_chart(data):

    plt.figure(figsize=(8, 5))

    # Auto choose chart type
    if len(data) <= 5:
        data.plot(kind="pie", autopct="%1.1f%%")
        plt.ylabel("")
        plt.title("Distribution Analysis")

    else:
        data.plot(kind="bar", color="skyblue")
        plt.title("Comparison Analysis")
        plt.ylabel("Value")
        plt.xticks(rotation=45)

    plt.tight_layout()
    return plt
