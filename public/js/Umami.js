'use strict';

console.log('İSTATİSTİKLER', window.location);

const statsDataKey = 'statsData';
const statsData = window.sessionStorage.getItem(statsDataKey);

const apiUrl = window.location.origin + '/stats';

if (statsData) {
    setStats(JSON.parse(statsData));
} else {
    fetch(apiUrl, { timeout: 5000 })
        .then((response) => {
            if (!response.ok) {
                throw new Error('Ağ yanıtı iyi değildi');
            }
            return response.json();
        })
        .then((data) => {
            setStats(data);
            window.sessionStorage.setItem(statsDataKey, JSON.stringify(data));
        })
        .catch((error) => {
            console.error('İstatistik getirme hatası', error);
        });
}

function setStats(data) {
    console.log('İSTATİSTİKLER', data);
    const { enabled, src, id } = data;
    if (enabled) {
        const script = document.createElement('script');
        script.setAttribute('async', '');
        script.setAttribute('src', src);
        script.setAttribute('data-website-id', id);
        document.head.appendChild(script);
    }
}
