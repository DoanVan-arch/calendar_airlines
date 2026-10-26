import uvicorn

if __name__ == "__main__":
    

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",  # Nginx chuyển tiếp vào cổng này
        port=8001,
        workers=6,
        reload=False,
    )

