# pip3 yükleme istekleri
import requests
import json

API_KEY_SECRET = "saigmvideochatsfu_default_secret"
SAIGMVIDEOCHAT_URL = "https://sfu.alchemy.com.tr/api/v1/join"
# SAIGMVIDEOCHAT_URL = "http://localhost:3010/api/v1/join"

headers = {
    "authorization": API_KEY_SECRET,
    "Content-Type": "application/json",
}

data = {
    "room": "test",
    "roomPassword": "false",
    "name": "saigmvideochatsfu",
    "audio": "true",
    "video": "true",
    "screen": "true",
    "hide": "false",
    "notify": "true",
    "token": {
        "username": "username",
        "password": "password",
        "presenter": "true",
        "expire": "1h",
    }
}

response = requests.post(
    SAIGMVIDEOCHAT_URL,
    headers=headers,
    json=data,
)

print("Durum kodu:", response.status_code)
data = json.loads(response.text)
print("katıl:", data["join"])
