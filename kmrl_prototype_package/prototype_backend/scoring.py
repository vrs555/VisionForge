import pandas as pd
import numpy as np
from datetime import datetime

def load_and_prepare(df):
    df = df.rename(columns={
        'Date':'date',
        'Train ID':'train_id',
        'Mileage (km)':'mileage_km',
        'Fitness Validity':'fitness_validity_date',
        'Job-card Status':'job_card_status',
        'Branding Active':'branding_active',
        'Last Cleaned':'last_cleaned',
        'Yard Position':'yard_position',
        'Status':'train_status'
    })
    df['date'] = pd.to_datetime(df['date'], format="%d-%m-%Y", errors='coerce')
    df['fitness_validity_date'] = pd.to_datetime(df['fitness_validity_date'], format="%d-%m-%Y", errors='coerce')
    df['last_cleaned'] = pd.to_datetime(df['last_cleaned'], format="%d-%m-%Y", errors='coerce')
    return df

def compute_latest(df):
    latest = df.sort_values(['train_id','date']).groupby('train_id').tail(1).reset_index(drop=True)
    latest_date = df['date'].max()
    mileage_30 = df.groupby('train_id')['mileage_km'].agg(lambda x: x.max()-x.min()).reset_index().rename(columns={'mileage_km':'mileage_30'})
    latest = latest.merge(mileage_30, on='train_id', how='left')
    latest['fitness_days_left'] = (latest['fitness_validity_date'] - latest_date).dt.days.fillna(0).astype(int)
    latest['job_card_open'] = latest['job_card_status'].str.contains('Open', case=False, na=False)
    latest['branding_boost'] = latest['branding_active'].str.strip().str.lower().eq('yes').astype(int)
    latest['days_since_clean'] = (latest_date - latest['last_cleaned']).dt.days.fillna(999).astype(int)
    latest['needs_cleaning'] = latest['days_since_clean'] > 2
    return latest, latest_date

def score_and_rank(latest_df):
    latest = latest_df.copy()
    max_days = max(latest['fitness_days_left'].max(),1)
    latest['fitness_score'] = latest['fitness_days_left'] / (max_days + 1)
    if latest['mileage_30'].max() != latest['mileage_30'].min():
        latest['mileage_score'] = 1 - ((latest['mileage_30'] - latest['mileage_30'].min()) / (latest['mileage_30'].max() - latest['mileage_30'].min()))
    else:
        latest['mileage_score'] = 0.5
    latest['clean_penalty'] = latest['needs_cleaning'].apply(lambda x: -0.5 if x else 0)
    latest['job_card_penalty'] = latest['job_card_open'].apply(lambda x: -5 if x else 0)
    latest['composite_score'] = (latest['fitness_score'] * 3) + (latest['mileage_score'] * 2) + latest['branding_boost'] + latest['clean_penalty'] + latest['job_card_penalty']
    latest = latest.sort_values('composite_score', ascending=False).reset_index(drop=True)
    latest['recommended_action'] = latest.apply(lambda r: 'Service' if (r['composite_score']>0 and not r['job_card_open']) else ('Maintenance' if r['job_card_open'] else 'Standby'), axis=1)
    return latest

def apply_overrides(latest_df, overrides: dict):
    latest = latest_df.copy()
    for train, changes in (overrides or {}).items():
        mask = latest['train_id']==train
        if not mask.any():
            continue
        if 'job_card_status' in changes:
            latest.loc[mask, 'job_card_status'] = changes['job_card_status']
            latest.loc[mask, 'job_card_open'] = str(changes['job_card_status']).lower().find('open')!=-1
        if 'mark_cleaned' in changes and changes['mark_cleaned']:
            latest.loc[mask, 'needs_cleaning'] = False
            latest.loc[mask, 'days_since_clean'] = 0
        if 'branding_active' in changes:
            latest.loc[mask, 'branding_active'] = changes['branding_active']
            latest.loc[mask, 'branding_boost'] = 1 if str(changes['branding_active']).strip().lower()=='yes' else 0
        if 'fitness_validity_date' in changes:
            try:
                d = pd.to_datetime(changes['fitness_validity_date'])
                latest.loc[mask, 'fitness_validity_date'] = d
            except:
                pass
    return latest
