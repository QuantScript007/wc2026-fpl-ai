@echo off
title WC2026 AI Dashboard
pip install -r requirements.txt --quiet
python -c "from models.wc_predictor import WCPredictor; WCPredictor().load_or_train()"
start cmd /k "python wc2026_app.py"
timeout /t 4 /nobreak >nul
start cmd /k "python wc_telegram_notifier.py"
echo Dashboard -> http://localhost:5050
pause >nul
