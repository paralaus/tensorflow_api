#!/bin/bash

API_KEY_SECRET="saigmvideochatsfu_default_secret"
SAIGMVIDEOCHAT_URL="https://sfu.alchemy.com.tr/api/v1/meetings"
#SAIGMVIDEOCHAT_URL="http://localhost:3010/api/v1/meetings"

curl $SAIGMVIDEOCHAT_URL \
    --header "authorization: $API_KEY_SECRET" \
    --header "Content-Type: application/json" \
    --request GET
