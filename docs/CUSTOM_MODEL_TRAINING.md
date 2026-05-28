# Custom Model Training (Your Data)

Bu dokuman, mevcut `tensorflow_api` yapisinda kendi soru/veri kayitlariniz ile
LoRA tabanli bir model egitmek ve uygulamada kullanmak icin minimum akisi verir.

## 1) Fine-tuning bagimliliklari

```bash
pip install -r requirements-finetune.txt
```

Not:

- `bitsandbytes` Windows'ta tipik olarak stabil degildir; Linux GPU ortaminda
  egitim onerilir.
- CUDA yoksa egitim cok yavas olur.

## 2) Veri toplama ve format

Kaynak olarak JSONL kullanin. Her satir bir ornek:

```json
{"question":"THYAO bugun neden dustu?","answer":"...","context":"KAP ozetleri ..."}
```

veya:

```json
{"messages":[
  {"role":"system","content":"..."},
  {"role":"user","content":"..."},
  {"role":"assistant","content":"..."}
]}
```

Mongo'dan export etmek icin script:

```bash
python scripts/export_training_data.py \
  --mongo-uri "mongodb://127.0.0.1:27017" \
  --db hissechat \
  --collection ai_training_logs \
  --mode qa \
  --user-field question \
  --assistant-field answer \
  --context-field context \
  --output data/raw/chat_qa.jsonl
```

Mesaj dizisi formati icin (`messages` array):

```bash
python scripts/export_training_data.py \
  --mongo-uri "mongodb://127.0.0.1:27017" \
  --db hissechat \
  --collection ai_conversations \
  --mode messages \
  --messages-field messages \
  --role-field role \
  --content-field content \
  --output data/raw/chat_messages.jsonl
```

## 3) Dataset hazirlama

```bash
python scripts/prepare_finetune_dataset.py \
  --input data/raw/chat_qa.jsonl \
  --output-dir data/finetune \
  --train-ratio 0.9 \
  --val-ratio 0.05
```

Cikti:

- `data/finetune/train.jsonl`
- `data/finetune/val.jsonl`
- `data/finetune/test.jsonl`
- `data/finetune/meta.json`

## 4) LoRA egitimi

Ornek (Llama 3 8B Instruct):

```bash
python scripts/train_lora.py \
  --model-name meta-llama/Meta-Llama-3-8B-Instruct \
  --train-file data/finetune/train.jsonl \
  --val-file data/finetune/val.jsonl \
  --output-dir outputs/hissechat-lora \
  --epochs 2 \
  --learning-rate 2e-4 \
  --max-seq-len 2048 \
  --train-batch-size 1 \
  --grad-accum-steps 8 \
  --bf16
```

`outputs/hissechat-lora` klasorune adapter kaydedilir.

## 5) Sunum (serve) ve router entegrasyonu

Router'a `local` provider desteği eklendi (OpenAI-compatible endpoint).
Bu sayede vLLM / TGI / Ollama gateway gibi bir endpoint'e trafik verebilirsiniz.

Ornek `.env`:

```env
LOCAL_LLM_ENABLED=true
LOCAL_LLM_BASE_URL=http://127.0.0.1:8001/v1
LOCAL_LLM_MODEL=hissechat-local
LOCAL_LLM_API_KEY=local-dev-key

LLM_PROVIDER_ORDER=local,digitalocean,groq,together,deepseek,openai,anthropic
LLM_ROUTE_BRIEF=local:hissechat-local
LLM_ROUTE_STANDARD=local:hissechat-local
LLM_ROUTE_DEEP=digitalocean:anthropic-claude-sonnet-4-6
```

> Not: Tool-calling path'i (`llm/tools.py`) varsayilan olarak `local` provider
> icin acik degil. `ENABLE_TOOL_CALLING=true` ile local kullanmak isterseniz
> local endpoint'in function-calling uyumunu dogrulayin ve whitelist'i genisletin.

## 6) Kalite kontrol checklist

- Ayrik test seti (`test.jsonl`) ile manual + otomatik degerlendirme
- Finansal gercek/disclaimer uyumu
- Hallucination orani
- Gecikme ve token maliyeti
- Failover senaryolari (`local` down -> cloud provider fallback)

## 7) Guvenlik ve veri hijyeni

- PII temizligi (isim, telefon, e-posta, hesap no)
- Gizli token/secret string filtreleme
- Lisans ve veri sahipligi denetimi
- Zararlı prompt enjeksiyon satirlarini dataset'ten ayiklama

## 8) Tek komut pipeline

Tum adimlari tek komutta calistirmak icin:

```bash
python scripts/run_finetune_pipeline.py \
  --mongo-uri "mongodb://127.0.0.1:27017" \
  --db hissechat \
  --collection ai_training_logs \
  --mode qa \
  --user-field question \
  --assistant-field answer \
  --context-field context \
  --raw-output data/raw/chat_qa.jsonl \
  --prepared-dir data/finetune \
  --model-name meta-llama/Meta-Llama-3-8B-Instruct \
  --adapter-output outputs/hissechat-lora \
  --epochs 2 \
  --bf16
```

Backend `.env`'den otomatik Mongo URI/DB cekmek icin:

```bash
python scripts/run_finetune_pipeline.py \
  --backend-env ../backend/.env \
  --collection ai_training_logs \
  --mode qa \
  --user-field question \
  --assistant-field answer \
  --context-field context \
  --raw-output data/raw/chat_qa.jsonl \
  --prepared-dir data/finetune \
  --model-name meta-llama/Meta-Llama-3-8B-Instruct \
  --adapter-output outputs/hissechat-lora \
  --epochs 2 \
  --bf16
```

`--backend-env` kullanildiginda script su anahtarlari sirasiyla dener:

- `MONGODB_URI`
- `MONGODB_URL`

Docker/compose tarafinda su format desteklenir:

```env
MONGODB_URI=${MONGODB_URI:-mongodb://ghostchat_root:***@diarss.online:27017/poker?authSource=admin}
```

Eger export'u daha once yaptiysaniz:

```bash
python scripts/run_finetune_pipeline.py \
  --skip-export \
  --raw-output data/raw/chat_qa.jsonl \
  --prepared-dir data/finetune \
  --model-name meta-llama/Meta-Llama-3-8B-Instruct \
  --adapter-output outputs/hissechat-lora \
  --epochs 2 \
  --bf16
```

## 9) Otomatik periyodik calistirma (cron)

Scriptler:

- `scripts/run_finetune_cron.sh`: lock + log ile pipeline calistirir
- `scripts/install_finetune_cron.sh`: cron kaydini ekler/gunceller

Kurulum:

```bash
chmod +x scripts/run_finetune_cron.sh scripts/install_finetune_cron.sh
bash scripts/install_finetune_cron.sh
```

Varsayilan cron:

- Her gun `03:30`
- Log dosyasi: `logs/hissechat-finetune.log`
- Lock dosyasi: `/tmp/hissechat-finetune.lock`

Saati degistirmek icin:

```bash
CRON_SCHEDULE="0 4 * * *" bash scripts/install_finetune_cron.sh
```

Opsiyonel env override ornegi:

```bash
BACKEND_ENV=../backend/.env \
COLLECTION=ai_training_logs \
MODEL_NAME=meta-llama/Meta-Llama-3-8B-Instruct \
ADAPTER_OUTPUT=outputs/hissechat-lora \
EPOCHS=2 \
bash scripts/run_finetune_cron.sh
```
