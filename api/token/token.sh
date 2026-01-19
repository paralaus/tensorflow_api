#!/bin/bash

API_KEY_SECRET="saigmvideochatsfu_default_secret"
SAIGMVIDEOCHAT_URL="https://sfu.alchemy.com.tr/api/v1/token"
#SAIGMVIDEOCHAT_URL="http://localhost:3010/api/v1/token"

curl $SAIGMVIDEOCHAT_URL \
    --header "authorization: $API_KEY_SECRET" \
    --header "Content-Type: application/json" \
    --data '{"username":"username","password":"password","presenter":"true", "expire":"1h"}' \
    --request POST