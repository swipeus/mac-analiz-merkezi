@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
if not exist "%PY%" set PY=python
echo Mac Analiz Merkezi baslatiliyor: http://localhost:8765
start "" http://localhost:8765
"%PY%" -m uvicorn app.main:app --host 127.0.0.1 --port 8765
