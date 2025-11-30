from flask import Flask, request, jsonify
from transformers import pipeline

app = Flask(__name__)

# Hugging Face zero-shot classification pipeline
classifier = pipeline("zero-shot-classification", model="facebook/bart-large-mnli")

@app.route('/predict', methods=['POST'])
def predict():
    data = request.get_json()
    message = data.get('message')
    candidate_labels = data.get('candidateLabels', [])
    if not message or not candidate_labels:
        return jsonify({"error": "Mesaj ve etiketler gerekli."}), 400
    result = classifier(message, candidate_labels)
    return jsonify(result)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)