@echo off
REM Double-click this to run Hope Ave Fuel properly (over http://, so location
REM search works). Opening index.html directly (file://) blocks the search.
cd /d "%~dp0"
echo.
echo   Hope Ave Fuel is starting...
echo   Your browser will open at http://localhost:8753
echo.
echo   KEEP THIS WINDOW OPEN while using the app. Close it to stop the server.
echo.
start "" http://localhost:8753/
python -m http.server 8753
