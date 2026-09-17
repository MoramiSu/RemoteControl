@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0scripts\setup-and-start.ps1"
if errorlevel 1 pause
