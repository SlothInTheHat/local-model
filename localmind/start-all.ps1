# Starts Ollama (if not already running), the phone-agent Telegram bot,
# and the LocalMind desktop app, each in its own window.
#
# Usage:  .\start-all.ps1   (from the localmind/ folder)

$root = $PSScriptRoot

Write-Host "==> Checking Ollama..." -ForegroundColor Cyan
$ready = $false
try {
    Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 1 -ErrorAction Stop | Out-Null
    $ready = $true
} catch {
    Write-Host "    Not running - starting 'ollama serve'..." -ForegroundColor Cyan
    Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
}

if (-not $ready) {
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 1 -ErrorAction Stop | Out-Null
            $ready = $true
            break
        } catch {}
    }
}

if ($ready) {
    Write-Host "    Ollama is up." -ForegroundColor Green
} else {
    Write-Host "    Ollama did not respond after 10s - check it manually." -ForegroundColor Red
}

$venvPython = Join-Path $root "phone-agent\.venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    Write-Host "==> Starting phone-agent (Telegram bot)..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList @(
        "-NoExit", "-Command",
        "cd '$root\phone-agent'; & '$venvPython' agent.py"
    )
} else {
    Write-Host "==> Skipping phone-agent: $venvPython not found." -ForegroundColor Yellow
    Write-Host "    Set it up with: cd phone-agent; python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt" -ForegroundColor Yellow
}

if (Test-Path (Join-Path $root "node_modules")) {
    Write-Host "==> Starting LocalMind desktop app..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList @(
        "-NoExit", "-Command",
        "cd '$root'; npm run tauri dev"
    )
} else {
    Write-Host "==> Skipping LocalMind app: node_modules not found. Run 'npm install' first." -ForegroundColor Yellow
}

Write-Host "==> Done. Check the new windows for phone-agent and LocalMind logs." -ForegroundColor Green
