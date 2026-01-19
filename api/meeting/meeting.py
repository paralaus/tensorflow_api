# pip3 install requests
import requests
import json

API_KEY_SECRET = "saigmvideochatsfu_default_secret"
SAIGMVIDEOCHAT_URL = "https://sfu.alchemy.com.tr/api/v1/meeting"
# SAIGMVIDEOCHAT_URL = "http://localhost:3010/api/v1/meeting"

headers = {
    "authorization": API_KEY_SECRET,
    "Content-Type": "application/json",
}

response = requests.post(
    SAIGMVIDEOCHAT_URL,
    headers=headers
)

print("Status code:", response.status_code)
data = json.loads(response.text)
print("meeting:", data["meeting"])
