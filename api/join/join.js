'use strict';

async function getJoin() {
    try {
        // Await ile dinamik içe aktarmayı kullanın
        const { default: fetch } = await import('node-fetch');

        const API_KEY_SECRET = 'saigmvideochatsfu_default_secret';
        const SAIGMVIDEOCHAT_URL = 'https://sfu.alchemy.com.tr/api/v1/join';
        //const SAIGMVIDEOCHAT_URL = 'http://localhost:3010/api/v1/join';

        const response = await fetch(SAIGMVIDEOCHAT_URL, {
            method: 'POST',
            headers: {
                authorization: API_KEY_SECRET,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                room: 'test',
                roomPassword: false,
                name: 'saigmvideochatsfu',
                audio: true,
                video: true,
                screen: true,
                hide: false,
                notify: true,
                token: {
                    username: 'username',
                    password: 'password',
                    presenter: true,
                    expire: '1h',
                },
            }),
        });
        const data = await response.json();
        if (data.error) {
            console.log('Hata:', data.error);
        } else {
            console.log('katıl:', data.join);
        }
    } catch (error) {
        console.error('Veriler getirilirken hata oluştu:', error);
    }
}

getJoin();
