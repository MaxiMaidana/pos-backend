# Abre el POS en modo "kiosco de impresión": los tickets se mandan directo
# a la impresora predeterminada de Windows, sin la pantalla de impresión del
# navegador (--kiosk-printing). Usa un perfil de navegador aparte para no
# tocar el navegador normal que usa el cajero para otras cosas.
$url    = 'http://localhost:3000'
$perfil = "$env:LOCALAPPDATA\POS-Kiosk-Profile"

$candidatos = @(
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
$navegador = $candidatos | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($navegador) {
    Start-Process -FilePath $navegador -ArgumentList @(
        '--kiosk-printing',
        '--no-first-run',
        '--no-default-browser-check',
        "--user-data-dir=$perfil",
        $url
    )
} else {
    Start-Process $url
}
