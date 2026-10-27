#Imports
import numpy as np
from PIL import Image
from pydantic import BaseModel
from contextlib import asynccontextmanager
from tensorflow.keras.models import load_model
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi import FastAPI, UploadFile, HTTPException

image_size = (224, 224)
ml = {}

#STEP1 : LIFESPAN
@asynccontextmanager
async def lifespan(app):
   ml["model"] = load_model("fruits_classification_model.keras")

   print("MODEL LOADED")

   yield

   ml.clear()

app = FastAPI(lifespan=lifespan)


#STEP 2 : DESCRIBE WHAT GOES OUT
class PredictionResult(BaseModel):
   label        : str
   confidence   : float

#STEP 3: PREPARE THE IMAGE EXACTLY LIKE THE TRAINING IMAGES
def preprare_image(image):
   #1. Make sure there are 3 channels
   image = image.convert("RGB")

   #2. Resize the image to 224 x 224.
   image = image.resize(image_size, Image.BILINEAR)

   array = np.array(image, dtype="float32")

   array = array / 255.0

    #The model expects a baatch of images, so make a batch of one
    #(224, 224, 3) -> (1,224,224,3)
   array = np.expand_dims(array, axis=0)

   return array

@app.post("/predict",response_model= PredictionResult)
def predict(file : UploadFile):
    try:
      image = Image.open(file.file)
    except Exception:
       raise HTTPException(status_code=400, detail="Please upload the image")

    data = preprare_image(image)

    result = ml["model"](data, training=False)

    rotten_chances = float(result[0][0])

    if rotten_chances > 0.5:
       return PredictionResult(label = "Rotten", confidence=rotten_chances)
    return PredictionResult(label = "Fresh", confidence=rotten_chances)

app.mount("/static", StaticFiles(directory="static"), name= "static")

@app.get("/")
def home():
   return FileResponse("static/index.html")