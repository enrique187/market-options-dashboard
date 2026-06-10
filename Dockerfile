FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV DASHBOARD_HOST=0.0.0.0

# Do not hardcode the port: hosts like Render/Heroku inject $PORT, which
# server.py reads. Defaults to 8765 locally when $PORT is unset.
EXPOSE 8765

CMD ["python", "server.py"]
