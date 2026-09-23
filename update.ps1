# ==============================================================================
# Pi Harness Setup Updater for Windows (PowerShell)
# Updates Pi Coding Agent and all installed extensions to latest versions
# ==============================================================================

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "Updating Pi Coding Agent (@earendil-works/pi-coding-agent@latest)..." -ForegroundColor Cyan
& npm install -g @earendil-works/pi-coding-agent@latest

Write-Host "Updating all Pi packages, extensions, and model catalogs to latest versions..." -ForegroundColor Cyan
& pi update --all

Write-Host "`nUpdate complete! Current versions:" -ForegroundColor Green
& pi --version
& pi list
