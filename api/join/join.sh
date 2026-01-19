#!/bin/bash

API_KEY_SECRET="saigmvideochatsfu_default_secret"
SAIGMVIDEOCHAT_URL="https://sfu.alchemy.com.tr/api/v1/join"
# SAIGMVIDEOCHAT_URL="http://localhost:3010/api/v1/join"

curl $SAIGMVIDEOCHAT_URL \
    --header "authorization: $API_KEY_SECRET" \
    --header "Content-Type: application/json" \
    --data '{"room":"test","roomPassword":"false","name":"saigmvideochatsfu","audio":"true","video":"true","screen":"false","hide":"false","notify":"true","token":{"username":"username","password":"password","presenter":"true", "expire":"1h"}}' \
    --request POST