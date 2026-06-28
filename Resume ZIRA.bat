@echo off
setlocal
set "ROOT=%~dp0"
set "RELEASE_ROOT=%ROOT%"
if not exist "%RELEASE_ROOT%release\windows" if exist "%ROOT%..\release\windows" set "RELEASE_ROOT=%ROOT%..\"
set "APP1=%LOCALAPPDATA%\Programs\ZIRA\ZIRA.exe"
set "APP2=%LOCALAPPDATA%\Programs\zira\ZIRA.exe"
set "DEV=%ROOT%apps\desktop\dist-refined\win-unpacked\ZIRA.exe"

if exist "%APP1%" (
  start "" "%APP1%"
  exit /b 0
)
if exist "%APP2%" (
  start "" "%APP2%"
  exit /b 0
)
if exist "%DEV%" (
  start "" "%DEV%"
  exit /b 0
)
if exist "%RELEASE_ROOT%release\windows\ZIRA Setup 1.0.0.exe" (
  echo ZIRA is not installed yet. Starting the installer.
  start "" "%RELEASE_ROOT%release\windows\ZIRA Setup 1.0.0.exe"
  exit /b 0
)

echo Could not find ZIRA.exe or the installer.
pause
