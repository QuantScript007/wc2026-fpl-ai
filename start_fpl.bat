@echo off
title FPL AI Analyzer
pip install -r requirements.txt --quiet
start cmd /k "python -u main.py"
timeout /t 5 /nobreak >nul
start cmd /k "python app.py"
echo FPL Dashboard -^> http://localhost:5051
pause >nul
