<?php

$API_KEY_SECRET = "saigmvideochatsfu_default_secret";
$SAIGMVIDEOCHAT_URL = "https://sfu.alchemy.com.tr/api/v1/meeting";
// $SAIGMVIDEOCHAT_URL = "http://localhost:3010/api/v1/meeting";

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $SAIGMVIDEOCHAT_URL);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
curl_setopt($ch, CURLOPT_POST, 1);

$headers = [
    'authorization:' . $API_KEY_SECRET,
    'Content-Type: application/json'
];

curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
$response = curl_exec($ch);
$httpcode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

curl_close($ch);

echo "Status code: $httpcode \n";
$data = json_decode($response);
echo "meeting: ", $data->{'meeting'}, "\n";
