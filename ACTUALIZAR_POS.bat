@echo off
chcp 65001 > nul
title Sistema POS - Actualizacion
cd /d "%~dp0"

echo.
echo  ============================================
echo    SISTEMA POS - Actualizando...
echo  ============================================
echo.

echo  [1/5] Descargando cambios del servidor...
git pull
if %errorlevel% neq 0 (
    echo  AVISO: No se pudo bajar actualizaciones (puede que no haya internet).
    echo  Continuando con la version actual...
    echo.
)

echo  [2/5] Liberando el puerto 3000 (por si el servidor sigue corriendo)...
powershell -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue).OwningProcess -Force -ErrorAction SilentlyContinue" 2>nul
timeout /t 1 /nobreak > nul
echo.

echo  [3/5] Actualizando dependencias del backend...
call npm install
echo.

echo  [4/5] Compilando backend...
call npm run build
if %errorlevel% neq 0 (
    echo  ERROR al compilar backend.
    pause
    exit /b 1
)
echo.

echo  [5/5] Construyendo frontend...
cd /d "%~dp0..\pos-frontend"
call npm install
call npx vite build
cd /d "%~dp0"
echo.

echo  ============================================
echo    Actualizacion completada exitosamente!
echo    Ya podes usar LANZAR_POS.bat
echo  ============================================
echo.
pause
