#!/bin/bash
# DigitalOcean Droplet Kurulum Scripti
# Çalıştırma: bash deploy/setup.sh

set -e

echo "🌊 DigitalOcean Droplet Kurulumu"
echo "================================"

# Değişkenler
APP_DIR="/root/paralaus-project"

# 1. Sistem güncellemesi
echo "📦 Sistem güncelleniyor..."
apt update && apt upgrade -y

# 2. Gerekli paketler
echo "📦 Gerekli paketler yükleniyor..."
apt install -y python3 python3-pip python3-venv nginx curl

# Node.js Kurulumu (v18)
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs build-essential

# 3. Swap alanı oluştur (ML modelleri için önemli!)
echo "💾 Swap alanı kontrol ediliyor..."
if [ ! -f /swapfile ]; then
    echo "💾 8GB Swap oluşturuluyor..."
    fallocate -l 8G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "✅ Swap oluşturuldu"
else
    echo "✅ Swap zaten mevcut"
fi

# 3b. Ağ tamponları (mediasoup WebRTC UDP yükü için)
echo "📡 UDP tampon ayarları yapılıyor..."
cat > /etc/sysctl.d/99-webrtc.conf <<'EOF'
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.core.netdev_max_backlog = 10000
EOF
sysctl --system > /dev/null
echo "✅ sysctl ayarları uygulandı"

# 4. Virtual environment
echo "🐍 Python ortamı hazırlanıyor..."
cd $APP_DIR
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

# Node.js Dependencies
echo "📦 Node.js paketleri yükleniyor..."
npm install

# 5. Systemd service
echo "⚙️ Systemd service kuruluyor..."
cp deploy/tensorflow-api.service /etc/systemd/system/
cp deploy/media-server.service /etc/systemd/system/

# Public IP'yi ayarla (Media Server için)
PUBLIC_IP=$(curl -s ifconfig.me)
sed -i "s/MEDIASOUP_ANNOUNCED_IP=127.0.0.1/MEDIASOUP_ANNOUNCED_IP=$PUBLIC_IP/" /etc/systemd/system/media-server.service

systemctl daemon-reload
systemctl enable tensorflow-api
systemctl enable media-server
systemctl start tensorflow-api
systemctl start media-server

# 6. Nginx
echo "🌐 Nginx yapılandırılıyor..."
cp deploy/nginx.conf /etc/nginx/sites-available/tensorflow-api
ln -sf /etc/nginx/sites-available/tensorflow-api /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# 7. Firewall: DigitalOcean Cloud Firewall kullanılıyor, ufw yönetilmiyor.
# (ufw her RTP akışını conntrack'te izler ve kural seti iki yerde tutulmak zorunda kalır.)
# mediasoup RTC portları: media-server.service ile aynı .env'den okunur
RTC_MIN_PORT=$(grep -E '^MEDIASOUP_MIN_PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r"')
RTC_MAX_PORT=$(grep -E '^MEDIASOUP_MAX_PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r"')
RTC_MIN_PORT=${RTC_MIN_PORT:-10000}
RTC_MAX_PORT=${RTC_MAX_PORT:-19999}
echo "🔥 Cloud Firewall inbound kuralları şunlar olmalı:"
echo "   TCP 22 (SSH), TCP 80, TCP 443 (nginx)"
echo "   UDP ${RTC_MIN_PORT}-${RTC_MAX_PORT}, TCP ${RTC_MIN_PORT}-${RTC_MAX_PORT} (mediasoup)"
echo "   8000 (gunicorn) ve 6379 (redis) AÇILMAMALI"
if command -v ufw > /dev/null && ufw status | grep -q "Status: active"; then
    echo "⚠️  ufw aktif: Cloud Firewall ile çakışmaması için 'ufw disable' düşünün"
fi

echo ""
echo "✅ Kurulum Tamamlandı!"
echo "================================"
echo ""
echo "📋 Yararlı Komutlar:"
echo "  Durum:     systemctl status tensorflow-api"
echo "  Loglar:    journalctl -u tensorflow-api -f"
echo "  Yeniden:   systemctl restart tensorflow-api"
echo "  Durdur:    systemctl stop tensorflow-api"
echo ""
echo "🔗 API Adresi: http://$(curl -s ifconfig.me)"
echo ""

