'use strict';

const config = require('../config');

const net = require('net');

/*
    Çalıştır: node binable.js

     Ağ iletişiminde "bağlanabilir", belirli bir IP adresi ve bağlantı noktası kombinasyonunu atama veya tahsis etme yeteneğini ifade eder.
     bir ağ hizmetine veya uygulamaya. Bir IP adresinin ve bağlantı noktasının bağlanması, söz konusu adrese ve bağlantı noktasına gelen ağ bağlantıları, 
     hizmetin veya uygulamanın dinlemesine olanak tanır.

     Bir IP adresi ve bağlantı noktasının "bağlanabilir" olduğunu söylediğimizde bu, hizmeti engelleyen herhangi bir çakışma veya sorun olmadığı anlamına gelir
     veya bu belirli kombinasyonu kullanan uygulama. Başka bir deyişle, IP adresi mevcut ve bağlantı noktası henüz mevcut değil aynı makinedeki başka bir 
     işlem veya hizmet tarafından kullanılıyor.

     Bir IP adresi ve bağlantı noktasının bağlanabilir olması, ağ hizmetinin veya uygulamanın buna başarılı bir şekilde bağlanabildiğini gösterir.
     gelen bağlantıları kabul etmesine ve ağ üzerinden iletişim kurmasına olanak tanır. Öte yandan, IP adresi
     ve bağlantı noktasının bağlanılabilir olmaması, hizmeti veya uygulamayı engelleyen çakışmalar veya kısıtlamalar olabileceğini düşündürür.
     Aynı IP adresini ve bağlantı noktasını dinleyen başka bir işlem gibi.
*/

async function main() {
    // Sunucu dinle
    const serverListenIp = config.server.listen.ip;
    const serverListenPort = config.server.listen.port;

    // WebRtcServerActive
    const webRtcServerActive = config.mediasoup.webRtcServerActive;

    // WebRtcTransportOptions
    const webRtcTransportIpInfo = config.mediasoup.webRtcTransport.listenInfos[0];
    const webRtcTransportIpAddress =
        webRtcTransportIpInfo.ip !== '0.0.0.0' ? webRtcTransportIpInfo.ip : webRtcTransportIpInfo.announcedAddress;

    // WorkersOptions | webRtcTransportOptions
    const workers = config.mediasoup.numWorkers;
    const { min, max } = config.mediasoup.webRtcTransport.listenInfos[0].portRange;
    const rtcMinPort = config.mediasoup.worker.rtcMinPort || min || 40000;
    const rtcMaxPort = config.mediasoup.worker.rtcMaxPort || max || 40100;

    console.log('==================================');
    console.log('checkServerListenPorts');
    console.log('==================================');

    await checkServerListenPorts(serverListenIp, serverListenPort);

    console.log('==================================');
    console.log('checkWebRtcTransportPorts');
    console.log('==================================');

    await checkWebRtcTransportPorts(webRtcTransportIpAddress, rtcMinPort, rtcMaxPort);

    if (webRtcServerActive) {
        console.log('==================================');
        console.log('checkWebRtcServerPorts');
        console.log('==================================');

        // WebRtcServerOptions
        const webRtcServerIpInfo = config.mediasoup.webRtcServerOptions.listenInfos[0];
        const webRtcServerIpAddress =
            webRtcServerIpInfo.ip !== '0.0.0.0' ? webRtcServerIpInfo.ip : webRtcServerIpInfo.announcedAddress;
        const webRtcServerStartPort = webRtcServerIpInfo.port
            ? webRtcServerIpInfo.port
            : webRtcServerIpInfo.portRange.min;

        await checkWebRtcServerPorts(webRtcServerIpAddress, webRtcServerStartPort, workers);
    }
}

/**
 * Sunucu dinleme bağlantı noktasının bağlanabilir olup olmadığını kontrol edin
 * @param {string} ipAddress
 * @param {integer} port
 */
async function checkServerListenPorts(ipAddress, port) {
    const bindable = await isBindable(ipAddress, port);
    if (bindable) {
        console.log(`${ipAddress}:${port} bağlanabilir 🟢`);
    } else {
        console.log(`${ipAddress}:${port} bağlanamaz 🔴`);
    }
}

/**
 * WebRtc Sunucusu bağlantı noktalarının bağlanabilir olup olmadığını kontrol edin
 * @param {string} ipAddress
 * @param {integer} startPort
 * @param {integer} workers
 */
async function checkWebRtcServerPorts(ipAddress, startPort, workers) {
    let port = startPort;
    for (let i = 0; i < workers; i++) {
        try {
            const bindable = await isBindable(ipAddress, port);
            if (bindable) {
                console.log(`${ipAddress}:${port} bağlanabilir 🟢`);
            } else {
                console.log(`${ipAddress}:${port} bağlanamaz 🔴`);
            }
            port++;
        } catch (err) {
            console.error('Hata oluştu:', err);
        }
    }
}

/**
 * WebRtcTransport Worker bağlantı noktalarının bağlanabilir olup olmadığını kontrol edin
 * @param {string} ipAddress
 * @param {integer} minPort
 * @param {integer} maxPort
 */
async function checkWebRtcTransportPorts(ipAddress, minPort, maxPort) {
    let port = minPort;
    for (let i = 0; i <= maxPort - minPort; i++) {
        try {
            const bindable = await isBindable(ipAddress, port);
            if (bindable) {
                console.log(`${ipAddress}:${port} bağlanabilir 🟢`);
            } else {
                console.log(`${ipAddress}:${port} bağlanamaz 🔴`);
            }
            port++;
        } catch (err) {
            console.error('Hata oluştu:', err);
        }
    }
}

/**
 * ipAddress:port'un bağlanabilir olup olmadığını kontrol edin
 * @param {string} ipAddress
 * @param {integer} port
 * @returns {Promise<boolean>} Adresin bağlanabilir olması durumunda true, aksi halde false olarak çözümlenen bir promise.
 */
async function isBindable(ipAddress, port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();

        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(false); // Adres zaten kullanılıyor
            } else {
                reject(err); // Başka bir hata oluştu
            }
        });

        server.once('listening', () => {
            server.close();
            resolve(true); // Adres bağlanabilir
        });

        server.listen(port, ipAddress);
    });
}

main().catch((err) => {
    console.error('Ana fonksiyonda hata oluştu:', err.message);
});
