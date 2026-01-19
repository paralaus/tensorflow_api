const selfsigned = require('selfsigned');
const fs = require('fs');
const path = require('path');

const attrs = [{ name: 'commonName', value: 'localhost' }];

// selfsigned 2.x+ uses async generation mostly, but 5.x might have changed API significantly.
// Let's try the callback or promise approach if sync fails or returns empty.
// Checking docs for 5.5.0: generate(attrs, options, callback) or returns promise if no callback?
// Actually, 'selfsigned' package often changes API. Let's try async.

const sslDir = path.join(__dirname);
if (!fs.existsSync(sslDir)) {
    fs.mkdirSync(sslDir);
}

// Attempt async generation
selfsigned.generate(attrs, { days: 365, keySize: 2048 })
    .then(pems => {
        const privateKey = pems.private || pems.key;
        if (!pems.cert || !privateKey) {
             throw new Error('Cert generation failed: Missing keys in response');
        }
        
        fs.writeFileSync(path.join(sslDir, 'cert.pem'), pems.cert);
        fs.writeFileSync(path.join(sslDir, 'key.pem'), privateKey);
        console.log('Self-signed certificate generated successfully in ssl/ directory.');
    })
    .catch(err => {
        console.error('Error generating certificate:', err);
        process.exit(1);
    });
