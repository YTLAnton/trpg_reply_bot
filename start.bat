@echo off
start powershell -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process 'http://localhost:8080'"
python -m http.server 8080
