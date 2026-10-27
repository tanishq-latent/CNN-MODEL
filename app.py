import streamlit as st
import numpy as np
import tensorflow as tf
from PIL import Image

# -----------------------------
# Page setup
# -----------------------------
st.set_page_config(page_title="Fresh vs Rotten", page_icon="🍎")
st.title("🍎 Fresh vs Rotten Image Classifier")

st.write("Upload an image and the model will predict whether it is **Fresh** or **Rotten**.")

# -----------------------------
# Load model
# -----------------------------
@st.cache_resource
def load_model():
    return tf.keras.models.load_model("fruits_classification_model.keras")
    # If using h5 instead:
    # return tf.keras.models.load_model("model.h5")

model = load_model()

# -----------------------------
# Image preprocessing
# -----------------------------
def preprocess_image(image):
    image = image.resize((224, 224))
    image = np.array(image) / 255.0
    image = np.expand_dims(image, axis=0)
    return image

# -----------------------------
# File upload
# -----------------------------
uploaded_file = st.file_uploader("Choose an image", type=["jpg", "jpeg", "png"])

if uploaded_file is not None:
    image = Image.open(uploaded_file).convert("RGB")
    st.image(image, caption="Uploaded Image", use_column_width=True)

    if st.button("Predict"):
        processed_image = preprocess_image(image)
        prediction = model.predict(processed_image)

        confidence = prediction[0][0]
        label = "Rotten 🔴" if confidence > 0.5 else "Fresh 🟢"

        st.subheader(f"Prediction: {label}")
        st.write(f"Confidence Score: **{confidence:.4f}**")
