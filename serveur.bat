@echo off
SET NODE=C:\Users\antpietri\nodejs-portable\node-v24.18.0-win-x64\node.exe
SET DOSSIER=%~dp0

echo.
echo === Demarrage du serveur local (port 8080) ===
pushd "%DOSSIER%"
start "Serveur local" cmd /k ""%NODE%" server.js"
popd

echo Attente du demarrage de Node...
timeout /t 5 /nobreak > nul

echo.
echo === Verification que le serveur repond ===
curl -s http://127.0.0.1:8080 > nul 2>&1
if errorlevel 1 (
    echo ERREUR : le serveur Node ne repond pas sur le port 8080.
    echo Verifie la fenetre "Serveur local" pour voir l'erreur.
    pause
    exit /b
)
echo Serveur OK !

echo.
echo === Ouverture du tunnel HTTPS ===
echo Une adresse https://xxxxx.trycloudflare.com va s'afficher.
echo Tape cette adresse dans Wolvic sur ton Quest 3.
echo.
"%DOSSIER%cloudflared.exe" tunnel --url http://127.0.0.1:8080

pause
