@echo off
cd /d "%~dp0"
if not exist server\node_modules (
  call npm install
  if errorlevel 1 goto fail
  call npm run install:all
  if errorlevel 1 goto fail
)
if not exist client\dist\client\browser\index.html (
  call npm run build
  if errorlevel 1 goto fail
)
echo Open http://localhost:3000 in your browser. Keep this window open.
call npm start
pause
exit /b
:fail
echo Setup failed. Read the message above and see README.md.
pause
