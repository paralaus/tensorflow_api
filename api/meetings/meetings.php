<?php

$API_KEY_SECRET = "saigmvideochatsfu_default_secret";
$SAIGMVIDEOCHAT_URL = "https://sfu.alchemy.com.tr/api/v1/meetings";
//$SAIGMVIDEOCHAT_URL = "http://localhost:3010/api/v1/meetings";

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $SAIGMVIDEOCHAT_URL);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
curl_setopt($ch, CURLOPT_HTTPGET, true);

$headers = [
    'authorization:' . $API_KEY_SECRET,
    'Content-Type: application/json'
];

curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
$response = curl_exec($ch);
$httpcode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

curl_close($ch);

echo "Durum kodu: $httpcode \n";

if ($response) {
    echo json_encode(json_decode($response), JSON_PRETTY_PRINT);
} else {
    echo "Veriler alınamadı.\n";
}
