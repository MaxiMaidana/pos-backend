@echo off
chcp 65001 > nul
title Sistema POS
cd /d "%~dp0"

echo.
echo  ============================================
echo    SISTEMA POS - Iniciando servidor...
echo  ============================================
echo.

REM Verificar que Node.js este instalado
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js no esta instalado.
    echo  Descargalo de https://nodejs.org e instala la version LTS.
    echo.
    pause
    exit /b 1
)

REM Verificar que el proyecto este buildeado
if not exist "dist\index.js" (
    echo  Primera vez o actualizacion detectada. Compilando...
    echo.
    call npm run build
    if %errorlevel% neq 0 (
        echo  ERROR al compilar. Revisa los mensajes de arriba.
        pause
        exit /b 1
    )
    echo.
)

REM Verificar que el frontend este buildeado
if not exist "public\index.html" (
    echo  Frontend no encontrado. Construyendo interfaz...
    echo.
    cd /d "%~dp0..\pos-frontend"
    call npm install
    call npx vite build
    cd /d "%~dp0"
    echo.
)

REM Abrir el navegador despues de 3 segundos (en segundo plano)
start "" cmd /c "timeout /t 3 /nobreak > nul && start http://localhost:3000"

echo  Servidor iniciado. Accede desde:
echo.
echo    Esta PC:    http://localhost:3000
echo.
echo    Otras PCs en la misma red:
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr "IPv4"') do (
    set "IP=%%A"
    setlocal enabledelayedexpansion
    set "IP=!IP: =!"
    echo                http://!IP!:3000
    endlocal
)
echo.
echo  Para cerrar el servidor, cierra esta ventana.
echo  ============================================
echo.

node dist\index.js

echo.
echo  El servidor se detuvo. Presiona cualquier tecla para cerrar.
pause > nul
