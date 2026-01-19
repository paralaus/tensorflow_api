from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
import os
import threading
import time
import hashlib
import json
from datetime import datetime, timedelta

app = Flask(__name__)
CORS(app)  # React Native'den gelen istekler için

# Sağlık Kontrolü Endpoint'i
@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({
        "status": "OK", 
        "service": "AI Chat Service",
        "groq_api": "Connected" if groq_client else "Disconnected"
    }), 200

# ============== YAPILANDIRMA ==============
REQUEST_TIMEOUT = 45  # saniye - istek zaman aşımı (60'tan 45'e düşürüldü)
MAX_NEW_TOKENS = 300  # chat için maksimum token (400'den 300'e düşürüldü - daha hızlı)
STREAM_RESPONSE = True  # Streaming response aktif
CACHE_ENABLED = True  # Cache aktif
CACHE_TTL = 300  # Cache süresi (5 dakika)

# ============== GROQ API (Ücretsiz - Llama 3.3 70B) ==============
GROQ_API_KEY = os.environ.get('GROQ_API_KEY', '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')

groq_client = None
try:
    from groq import Groq
    # Connection pooling için timeout ve max_retries ayarları
    groq_client = Groq(
        api_key=GROQ_API_KEY,
        timeout=30.0,  # API timeout (saniye)
        max_retries=2,  # Retry sayısı
    )
    print("✅ Groq API bağlantısı hazır (Llama 3.3 70B)")
except ImportError:
    print("⚠️ Groq paketi yüklü değil. 'pip install groq' çalıştırın.")
except Exception as e:
    print(f"⚠️ Groq API hatası: {e}")

# ============== CACHE MEKANİZMASI ==============
response_cache = {}
cache_lock = threading.Lock()

def get_cache_key(question: str, history: list = None) -> str:
    """Soru ve geçmiş için cache key oluştur"""
    cache_data = {
        "question": question.lower().strip(),
        "history": [(msg.get('text', ''), msg.get('isUser', False)) for msg in (history or [])[-3:]]  # Son 3 mesaj
    }
    cache_str = json.dumps(cache_data, sort_keys=True)
    return hashlib.md5(cache_str.encode()).hexdigest()

def get_cached_response(cache_key: str):
    """Cache'den response al"""
    if not CACHE_ENABLED:
        return None
    
    with cache_lock:
        if cache_key in response_cache:
            cached_data, cached_time = response_cache[cache_key]
            if datetime.now() - cached_time < timedelta(seconds=CACHE_TTL):
                return cached_data
            else:
                # Expired cache'i temizle
                del response_cache[cache_key]
    return None

def set_cached_response(cache_key: str, response_data: dict):
    """Response'u cache'e kaydet"""
    if not CACHE_ENABLED:
        return
    
    with cache_lock:
        # Cache boyutunu sınırla (max 100 entry)
        if len(response_cache) > 100:
            # En eski entry'leri sil
            sorted_cache = sorted(response_cache.items(), key=lambda x: x[1][1])
            for key, _ in sorted_cache[:20]:
                del response_cache[key]
        
        response_cache[cache_key] = (response_data, datetime.now())

# ============== SYSTEM PROMPT ==============
SYSTEM_PROMPT = """Sen Hisse Chat uygulamasının AI finansal asistanısın.

🎯 Görevlerin:
- Borsa, hisse senedi, kripto para sorularını yanıtla
- Teknik ve temel analiz kavramlarını açıkla
- Yatırım stratejileri hakkında bilgi ver
- Piyasa terimleri ve kavramları öğret

📝 Yanıt Kuralları:
- Türkçe yanıt ver
- Kısa ve öz ol (maksimum 150 kelime)
- Bullet point (•) ve emoji kullan (📈 📊 💰 💹)
- Önemli bilgileri vurgula
- Her yanıtın sonuna ekle: "⚠️ Bu bilgi yatırım tavsiyesi değildir."

📊 Format:
- Liste formatını tercih et
- Sayısal verileri belirt
- Karşılaştırmalı bilgi ver

Örnek yanıt formatı:
📊 BIST 100 Durumu:
• Mevcut seviye: 9,850 puan
• Günlük değişim: +1.2%
• Hacim: 45 milyar TL

💡 Önemli Noktalar:
• Bankacılık sektörü öncü
• Döviz etkisi pozitif

⚠️ Bu bilgi yatırım tavsiyesi değildir."""

# ============== TIMEOUT YÖNETİMİ ==============
executor = ThreadPoolExecutor(max_workers=4)

def run_with_timeout(func, timeout, *args, **kwargs):
    """Fonksiyonu timeout ile çalıştır"""
    future = executor.submit(func, *args, **kwargs)
    try:
        return future.result(timeout=timeout)
    except FuturesTimeoutError:
        return None

# ============== STREAMING RESPONSE HELPER ==============
def generate_streaming_response(stream, question: str):
    """Streaming response generator"""
    full_text = ""
    actions_generated = False
    
    try:
        for chunk in stream:
            if chunk.choices and len(chunk.choices) > 0:
                delta = chunk.choices[0].delta
                if delta.content:
                    content = delta.content
                    full_text += content
                    # Her chunk'ı JSON olarak gönder
                    yield f"data: {json.dumps({'chunk': content, 'partial': True})}\n\n"
        
        # Stream tamamlandığında final response gönder
        actions = generate_actions(question)
        final_response = {
            'chunk': '',
            'partial': False,
            'full_text': full_text,
            'actions': actions,
            'model': 'llama-3.3-70b',
            'done': True
        }
        yield f"data: {json.dumps(final_response)}\n\n"
    except Exception as e:
        error_response = {
            'error': str(e),
            'partial': False,
            'done': True
        }
        yield f"data: {json.dumps(error_response)}\n\n"

# ============== AKSİYON BUTON OLUŞTURUCU ==============
def generate_actions(question: str):
    """Soruya göre aksiyon butonları oluştur"""
    actions = []
    q = question.lower()
    
    # Hisse/Borsa soruları
    if any(w in q for w in ["hisse", "bist", "borsa", "endeks", "thyao", "sise", "garan", "akbnk"]):
        actions.append({"label": "Grafik Gör", "icon": "📊", "action": "showChart"})
    
    # Analiz soruları
    if any(w in q for w in ["analiz", "teknik", "temel", "değerleme", "rsi", "macd"]):
        actions.append({"label": "Detaylı Analiz", "icon": "📈", "action": "detailedAnalysis"})
    
    # Karşılaştırma
    if any(w in q for w in ["karşılaştır", "vs", "fark", "hangisi", "mı yoksa"]):
        actions.append({"label": "Karşılaştır", "icon": "⚖️", "action": "compareStocks"})
    
    # Kripto
    if any(w in q for w in ["bitcoin", "btc", "ethereum", "eth", "kripto", "coin", "altcoin"]):
        actions.append({"label": "Kripto Fiyatları", "icon": "₿", "action": "cryptoPrices"})
    
    # Döviz
    if any(w in q for w in ["dolar", "euro", "döviz", "kur", "usd", "eur", "tl"]):
        actions.append({"label": "Döviz Kurları", "icon": "💱", "action": "exchangeRates"})
    
    return actions

# ============== GROQ CHAT FONKSİYONU ==============
def groq_chat(message: str, history: list = None, stream: bool = False):
    """Groq API ile Llama 3.3 70B chat - Optimize edilmiş"""
    if not groq_client:
        raise Exception("Groq API bağlantısı yok")
    
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    
    # Geçmiş mesajları ekle (son 4'e düşürüldü - daha hızlı)
    if history:
        for msg in history[-4:]:  # 6'dan 4'e düşürüldü
            role = "user" if msg.get('isUser') else "assistant"
            messages.append({"role": role, "content": msg.get('text', '')})
    
    messages.append({"role": "user", "content": message})
    
    # Optimize edilmiş parametreler
    params = {
        "model": "llama-3.3-70b-versatile",
        "messages": messages,
        "max_tokens": MAX_NEW_TOKENS,
        "temperature": 0.6,  # 0.7'den 0.6'ya düşürüldü (daha hızlı, daha tutarlı)
        "top_p": 0.85,  # 0.9'dan 0.85'e düşürüldü (daha hızlı)
        "stream": stream,  # Streaming desteği
    }
    
    if stream:
        # Streaming response
        stream_response = groq_client.chat.completions.create(**params)
        return stream_response
    else:
        # Normal response
        response = groq_client.chat.completions.create(**params)
        return {
            "text": response.choices[0].message.content,
            "model": "llama-3.3-70b",
            "tokens": response.usage.total_tokens if response.usage else None
        }

# ============== ENDPOINTS ==============

@app.route('/health', methods=['GET'])
def health():
    """Sağlık kontrolü endpoint'i"""
    return jsonify({
        "status": "healthy",
        "groq_connected": groq_client is not None,
        "model": "llama-3.3-70b-versatile",
        "version": "2.1.0",
        "optimizations": {
            "streaming": STREAM_RESPONSE,
            "cache_enabled": CACHE_ENABLED,
            "cache_size": len(response_cache),
            "max_tokens": MAX_NEW_TOKENS,
            "timeout": REQUEST_TIMEOUT
        }
    })

@app.route('/chat', methods=['POST'])
def chat():
    """
    AI Chat Endpoint - Groq Llama 3.3 70B - Optimize edilmiş
    
    Request:
    {
        "question": "BIST 100 hakkında bilgi ver",
        "history": [{"text": "...", "isUser": true/false}, ...],
        "stream": false  # Streaming için true
    }
    
    Response:
    {
        "answer": "...",
        "actions": [...],
        "model": "llama-3.3-70b",
        "tokens": 123
    }
    """
    data = request.get_json()
    question = data.get('question') or data.get('message')
    history = data.get('history', [])
    timeout = data.get('timeout', REQUEST_TIMEOUT)
    use_stream = data.get('stream', False) and STREAM_RESPONSE
    
    if not question:
        return jsonify({"error": "Soru gerekli."}), 400
    
    # Cache kontrolü
    cache_key = get_cache_key(question, history)
    cached_response = get_cached_response(cache_key)
    if cached_response:
        print(f"✅ Cache hit: {cache_key[:8]}...")
        return jsonify(cached_response)
    
    # Streaming response
    if use_stream:
        try:
            def do_stream():
                return groq_chat(question, history, stream=True)
            
            stream = run_with_timeout(do_stream, timeout)
            if stream is None:
                return jsonify({
                    "error": "İstek zaman aşımına uğradı.",
                    "timeout": timeout
                }), 504
            
            return Response(
                stream_with_context(generate_streaming_response(stream, question)),
                mimetype='text/event-stream',
                headers={
                    'Cache-Control': 'no-cache',
                    'X-Accel-Buffering': 'no',  # Nginx için
                }
            )
        except Exception as e:
            print(f"❌ Streaming hatası: {e}")
            # Fallback to non-streaming
            use_stream = False
    
    # Normal (non-streaming) response
    if not use_stream:
        def do_chat():
            return groq_chat(question, history, stream=False)
        
        try:
            result = run_with_timeout(do_chat, timeout)
            
            if result is None:
                return jsonify({
                    "error": "İstek zaman aşımına uğradı.",
                    "timeout": timeout
                }), 504
            
            # Aksiyon butonları oluştur
            actions = generate_actions(question)
            
            response_data = {
                "answer": result["text"],
                "text": result["text"],  # Frontend uyumluluğu için
                "actions": actions,
                "model": result["model"],
                "tokens": result.get("tokens")
            }
            
            # Cache'e kaydet
            set_cached_response(cache_key, response_data)
            
            return jsonify(response_data)
            
        except Exception as e:
            print(f"❌ Chat hatası: {e}")
            return jsonify({
                "error": str(e),
                "answer": "Üzgünüm, bir hata oluştu. Lütfen tekrar deneyin."
            }), 500

@app.route('/api/chat', methods=['POST'])
def api_chat():
    """Alternatif endpoint - /api/chat"""
    return chat()

# ============== LEGACY ENDPOINTS (Eski uyumluluk için) ==============

@app.route('/predict', methods=['POST'])
def predict():
    """Zero-shot classification - Basit implementasyon"""
    data = request.get_json()
    message = data.get('message')
    candidate_labels = data.get('candidateLabels', [])
    
    if not message or not candidate_labels:
        return jsonify({"error": "Mesaj ve etiketler gerekli."}), 400
    
    # Basit keyword matching (Groq kullanmadan)
    scores = []
    message_lower = message.lower()
    
    for label in candidate_labels:
        label_lower = label.lower()
        # Basit skor hesaplama
        score = 0.1  # base score
        if label_lower in message_lower:
            score = 0.9
        elif any(word in message_lower for word in label_lower.split()):
            score = 0.6
        scores.append(score)
    
    # Normalize
    total = sum(scores)
    if total > 0:
        scores = [s/total for s in scores]
    
    return jsonify({
        "labels": candidate_labels,
        "scores": scores,
        "sequence": message
    })

# ============== BAŞLATMA ==============
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    print(f"""
╔══════════════════════════════════════════════════════════════╗
║         🤖 Hisse Chat AI API v2.1 (Optimized)                ║
╠══════════════════════════════════════════════════════════════╣
║  Model: Llama 3.3 70B (Groq API - Ücretsiz)                 ║
║  Optimizasyonlar:                                            ║
║    ✅ Streaming Response (SSE)                               ║
║    ✅ Response Caching (5 dakika TTL)                        ║
║    ✅ Optimize edilmiş model parametreleri                   ║
║    ✅ Connection pooling & retry mekanizması                  ║
║    ✅ Kısaltılmış timeout (45s)                             ║
║  Endpoints:                                                  ║
║    POST /chat       - AI sohbet (streaming destekli)         ║
║    POST /api/chat   - AI sohbet (alternatif)                 ║
║    POST /predict    - Sınıflandırma                         ║
║    GET  /health     - Sağlık kontrolü                       ║
╠══════════════════════════════════════════════════════════════╣
║  Sunucu: http://0.0.0.0:{port}                               ║
║  Cache: {CACHE_ENABLED} | Streaming: {STREAM_RESPONSE}        ║
╚══════════════════════════════════════════════════════════════╝
    """)
    app.run(host='0.0.0.0', port=port, threaded=True)
