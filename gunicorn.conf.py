# Gunicorn Yapılandırması - DigitalOcean Droplet İçin Optimize
import multiprocessing
import os

bind = f"0.0.0.0:{os.environ.get('FLASK_PORT', '8000')}"

# Worker Ayarları - 32GB RAM için optimize
workers = 2  # 1'den 2'ye çıkarıldı (daha iyi throughput)
threads = 4  # Thread bazlı eşzamanlılık
worker_class = "gthread"  # Thread destekli worker

# Timeout Ayarları - ÖNEMLİ! (Nginx ile uyumlu) - Optimize edildi
timeout = 90  # Worker timeout (600'tan 90'a düşürüldü - daha hızlı failover)
graceful_timeout = 30  # Graceful shutdown timeout (300'den 30'a düşürüldü)
keepalive = 10  # Keep-alive bağlantıları (5'ten 10'a çıkarıldı)

# Model Yükleme İçin Preload
preload_app = True  # Modeli bir kez yükle, tüm worker'larda paylaş

# Logging - systemd journal ile uyumlu
accesslog = "-"  # stdout'a yaz
errorlog = "-"
loglevel = "info"
capture_output = True
enable_stdio_inheritance = True

# Hafıza Yönetimi - DigitalOcean için önemli
max_requests = 100  # Worker'ı N istekten sonra yeniden başlat (50'den 100'e çıkarıldı)
max_requests_jitter = 20  # Rastgele jitter ekle (10'dan 20'ye çıkarıldı)

# Performans - Linux için
worker_tmp_dir = "/dev/shm"  # RAM disk kullan

def on_starting(server):
    print("🚀 Gunicorn başlatılıyor...")
    print("📦 preload_app=True - Modeller yüklenecek...")

def post_fork(server, worker):
    print(f"👷 Worker {worker.pid} başlatıldı")

def worker_exit(server, worker):
    print(f"🛑 Worker {worker.pid} sonlandırıldı")
