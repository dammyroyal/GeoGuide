@echo off
title GeoGuide Backend Server
echo ==============================================
echo        GeoGuide Backend Server
echo ==============================================
echo Starting server on http://localhost:5000 ...
echo Close this window or press Ctrl+C to stop.
echo.
cd /d "%~dp0backend"
node server.js
pause

