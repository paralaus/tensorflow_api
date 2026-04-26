"""rag.ingest - KAP, bilanco ve haber kaynaklarindan veri ceken bagimsiz worker'lar.

Bu paketteki modulleri ASLA chat request path'inden cagirma. Cron / systemd /
docker-compose 'ingest' servisi olarak ayri proseste calistir:

    python -m rag.ingest.kap --days 1
    python -m rag.ingest.kap --offline sample.json --dry-run
"""
