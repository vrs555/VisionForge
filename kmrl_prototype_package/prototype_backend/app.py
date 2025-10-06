# File: app.py
from flask import Flask, jsonify
from flask_cors import CORS
import pandas as pd
from datetime import datetime, timedelta

app = Flask(__name__)
CORS(app)

CSV_PATH = "../kmrl_train_30day_log.csv"

# Load CSV with proper date parsing
df = pd.read_csv(
    CSV_PATH, 
    parse_dates=['Date', 'Fitness Validity', 'Last Cleaned'], 
    dayfirst=True
)

# Ensure datetime and numeric types are properly cast
for col in ['Date', 'Fitness Validity', 'Last Cleaned']:
    df[col] = pd.to_datetime(df[col], errors='coerce')

df['Mileage (km)'] = pd.to_numeric(df['Mileage (km)'], errors='coerce')

def calculate_next_service(last_cleaned, mileage):
    if pd.isna(last_cleaned):
        last_cleaned = datetime.now()
    next_date = last_cleaned + timedelta(days=15)
    next_mileage = int(mileage) + 2000 if mileage is not None else 2000
    return next_date, next_mileage

def determine_fitness_status(fitness_validity, job_card_status):
    today = pd.Timestamp.today()
    if pd.isna(fitness_validity):
        fitness_validity = today
    if job_card_status.lower().startswith("open-critical") or fitness_validity <= today:
        return "Critical"
    elif job_card_status.lower().startswith("open-minor") or fitness_validity <= today + pd.Timedelta(days=5):
        return "Minor"
    else:
        return "Healthy"

def consequence_if_skipped(fitness_status):
    if fitness_status == "Critical":
        return "Safety risk, possible downtime"
    elif fitness_status == "Minor":
        return "May cause minor delays or service issues"
    else:
        return "No immediate risk"

@app.route("/api/current_status")
def current_status():
    status_list = []
    today = pd.Timestamp.today()

    for train_id, group in df.groupby("Train ID"):
        last_run = group.sort_values("Date").iloc[-1]
        last_date = last_run["Date"]
        mileage = last_run["Mileage (km)"]
        job_card = last_run["Job-card Status"]
        fitness_validity = last_run["Fitness Validity"]
        yard_pos = last_run["Yard Position"]
        status = last_run["Status"]

        next_service_date, next_service_mileage = calculate_next_service(last_run["Last Cleaned"], mileage)
        fitness_status = determine_fitness_status(fitness_validity, job_card)
        consequence = consequence_if_skipped(fitness_status)

        # Calculate additional useful metrics
        days_until_next_service = (next_service_date - today).days
        mileage_remaining = next_service_mileage - int(mileage) if mileage is not None else None
        days_until_fitness_expiry = (fitness_validity - today).days if fitness_validity is not pd.NaT else None

        status_list.append({
            "train_id": str(train_id),
            "yard_position": str(yard_pos),
            "last_run_date": last_date.strftime("%Y-%m-%d") if last_date is not pd.NaT else None,
            "next_service_due_date": next_service_date.strftime("%Y-%m-%d"),
            "next_service_due_mileage": next_service_mileage,
            "days_until_next_service": int(days_until_next_service),
            "mileage_remaining": int(mileage_remaining) if mileage_remaining is not None else None,
            "fitness_status": str(fitness_status),
            "fitness_validity": fitness_validity.strftime("%Y-%m-%d") if fitness_validity is not pd.NaT else None,
            "days_until_fitness_expiry": int(days_until_fitness_expiry) if days_until_fitness_expiry is not None else None,
            "job_card_status": str(job_card),
            "status": str(status),
            "consequence_if_skipped": str(consequence)
        })

    return jsonify(status_list)

@app.route("/api/recommendation")
def recommendation():
    recommendations = []
    today = pd.Timestamp.today()

    for train_id, group in df.groupby("Train ID"):
        last_row = group.sort_values("Date").iloc[-1]
        fitness_status = determine_fitness_status(last_row["Fitness Validity"], last_row["Job-card Status"])
        status = last_row["Status"]
        job_card = last_row["Job-card Status"]

        reason = ""
        if job_card.lower().startswith("open-critical"):
            reason = "Open-Critical Job Card"
        elif job_card.lower().startswith("open-minor"):
            reason = "Open-Minor Job Card"
        elif last_row["Fitness Validity"] <= today + pd.Timedelta(days=3):
            reason = "Fitness Validity expiring soon"
        else:
            reason = "Scheduled Service"

        recommendations.append({
            "train_id": str(train_id),
            "reason": reason,
            "consequence_if_skipped": consequence_if_skipped(fitness_status),
            "fitness_status": str(fitness_status)
        })

    # Prioritize Critical -> Minor -> Healthy
    def urgency(item):
        if item["fitness_status"] == "Critical":
            return 0
        elif item["fitness_status"] == "Minor":
            return 1
        else:
            return 2

    recommendations.sort(key=urgency)
    return jsonify(recommendations)

if __name__ == "__main__":
    app.run(debug=True)
