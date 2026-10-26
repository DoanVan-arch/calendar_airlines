import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", workers=6, port=8001, reload=True)
