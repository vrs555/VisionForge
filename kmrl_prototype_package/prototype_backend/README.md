KMRT Prototype Backend & Frontend (Demo)

Contents:
- prototype_backend/ (Flask backend)
  - app.py           : Flask app providing /api/latest_snapshot, /api/recommendation, /api/whatif
  - scoring.py       : scoring and ranking logic
  - requirements.txt : Python dependencies

- prototype_frontend/ (Simple single-file React UI using CDN)
  - index.html       : Frontend that calls backend endpoints

How to run (locally):
1. Ensure Python 3.9+ installed. Create venv:
   python -m venv venv
   source venv/bin/activate   (Linux/Mac) or venv\Scripts\activate (Windows)

2. Install dependencies:
   pip install -r prototype_backend/requirements.txt

3. Copy the dataset kmrl_train_30day_log.csv into the parent directory of prototype_backend (already placed in /mnt/data).
   When running locally, ensure prototype_backend/CWD has access to the CSV via ../kmrl_train_30day_log.csv

4. Start backend:
   cd prototype_backend
   python app.py

5. Open frontend:
   Open prototype_frontend/index.html in a browser. The frontend expects backend at http://localhost:5000

What-if API example (curl):
curl -X POST http://localhost:5000/api/whatif -H "Content-Type: application/json" -d '{"overrides":{"KMRT-08":{"mark_cleaned":true}}}'

Notes:
- This is a demo prototype for the SIH submission. It uses a transparent rule-based scoring function. Replace scoring.py with ML models / OR-Tools as needed.
