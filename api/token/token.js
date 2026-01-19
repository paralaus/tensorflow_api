'use strict';

async function getToken() {
    try {
        // Use dynamic import with await
        const { default: fetch } = await import('node-fetch');

        const API_KEY_SECRET = 'saigmvideochatsfu_default_secret';
        const SAIGMVIDEOCHAT_URL = 'https://sfu.alchemy.com.tr/api/v1/token';
        //const SAIGMVIDEOCHAT_URL = 'http://localhost:3010/api/v1/token';

        const response = await fetch(SAIGMVIDEOCHAT_URL, {
            method: 'POST',
            headers: {
                authorization: API_KEY_SECRET,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                username: 'username',
                password: 'password',
                presenter: true,
                expire: '1h',
            }),
        });
        const data = await response.json();
        if (data.error) {
            console.log('Error:', data.error);
        } else {
            console.log('token:', data.token);
        }
    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

getToken();
