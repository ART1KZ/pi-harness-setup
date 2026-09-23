# ==============================================================================
# Pi Harness Setup Installer for Windows (PowerShell)
# One-command installer for ART1KZ/pi-harness-setup
# Usage:
#   irm https://raw.githubusercontent.com/ART1KZ/pi-harness-setup/main/install.ps1 | iex
#   or from cloned repo:
#   .\install.ps1
# ==============================================================================

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step([string]$msg) {
    Write-Host "`n[+] $msg" -ForegroundColor Cyan
}

function Write-Success([string]$msg) {
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
    Write-Host "  [WARN] $msg" -ForegroundColor Yellow
}

function Write-Info([string]$msg) {
    Write-Host "  [INFO] $msg" -ForegroundColor Gray
}

Write-Host @"
============================================================
              PI CODING AGENT HARNESS SETUP                 
             Automated Installer (ART1KZ Setup)             
============================================================
"@ -ForegroundColor Magenta

# 1. Check Node.js and npm
Write-Step "Checking prerequisites (Node.js & npm)..."
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue

if (-not $nodeCmd -or -not $npmCmd) {
    Write-Warn "Node.js or npm is missing!"
    Write-Host "Please install Node.js (v20+ recommended) from https://nodejs.org or run:" -ForegroundColor Yellow
    Write-Host "  winget install OpenJS.NodeJS.LTS" -ForegroundColor White
    exit 1
}

$nodeVer = & node --version
$npmVer = & npm --version
Write-Success "Found Node.js $nodeVer and npm $npmVer"

# 2. Install / Update Pi Coding Agent to latest version
Write-Step "Installing/updating @earendil-works/pi-coding-agent to latest version..."
try {
    & npm install -g @earendil-works/pi-coding-agent@latest
    Write-Success "Pi coding agent is installed and up-to-date"
} catch {
    Write-Warn "Global npm install failed. Attempting with --force or checking existing binary..."
    & npm install -g @earendil-works/pi-coding-agent@latest --force
}

$piCmd = Get-Command pi -ErrorAction SilentlyContinue
if (-not $piCmd) {
    # Check common npm global paths
    $npmPrefix = (& npm config get prefix).Trim()
    $candidate = Join-Path $npmPrefix "pi.cmd"
    if (Test-Path $candidate) {
        $env:Path = "$npmPrefix;$env:Path"
        Write-Success "Located pi binary at $npmPrefix"
    } else {
        Write-Warn "Could not find 'pi' in PATH. You may need to restart your terminal or add npm global directory to PATH."
    }
}

# 3. Determine source repo directory (handle remote curl/irm execution)
Write-Step "Preparing configuration files..."
$tempDirCreated = $false
$scriptDir = $PSScriptRoot

if (-not $scriptDir -or -not (Test-Path (Join-Path $scriptDir "config\settings.json"))) {
    Write-Info "Running remotely or outside repository. Cloning latest ART1KZ/pi-harness-setup..."
    $tempDir = Join-Path $env:TEMP ("pi-harness-setup-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    $tempDirCreated = $true
    
    if (Get-Command git -ErrorAction SilentlyContinue) {
        & git clone --depth 1 https://github.com/ART1KZ/pi-harness-setup.git $tempDir
    } else {
        # Fallback to zip download if git is not installed
        $zipUrl = "https://github.com/ART1KZ/pi-harness-setup/archive/refs/heads/main.zip"
        $zipFile = Join-Path $tempDir "repo.zip"
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile
        Expand-Archive -Path $zipFile -DestinationPath $tempDir -Force
        $unzipped = Join-Path $tempDir "pi-harness-setup-main"
        if (Test-Path $unzipped) {
            $tempDir = $unzipped
        }
    }
    $sourceDir = $tempDir
} else {
    $sourceDir = $scriptDir
}

Write-Success "Source files located at $sourceDir"

# 4. Target directories setup
$piHome = Join-Path $env:USERPROFILE ".pi"
$piAgent = Join-Path $piHome "agent"
$piExtDir = Join-Path $piAgent "extensions"
$piSecretsDir = Join-Path $piAgent "secrets"
$piSecretsEntriesDir = Join-Path $piSecretsDir "entries"
$piSkillsDir = Join-Path $piAgent "skills"
$agentsSkillsDir = Join-Path $env:USERPROFILE ".agents\skills"
$mcpDir = Join-Path $env:USERPROFILE ".config\mcp"

$dirsToCreate = @(
    $piAgent,
    $piExtDir,
    (Join-Path $piExtDir "secret-guard"),
    (Join-Path $piExtDir "pi-rtk-optimizer"),
    $piSecretsDir,
    $piSecretsEntriesDir,
    $piSkillsDir,
    $agentsSkillsDir,
    $mcpDir
)

foreach ($d in $dirsToCreate) {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
}
Write-Success "Directory structure prepared under $piAgent and $agentsSkillsDir"

# 5. Copy configuration files
Write-Step "Installing configuration files..."

$configs = @(
    "settings.json",
    "models.json",
    "web-search.json",
    "mcp-onboarding.json",
    "AGENTS.md"
)

foreach ($cfg in $configs) {
    $src = Join-Path $sourceDir "config\$cfg"
    $dest = Join-Path $piAgent $cfg
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination $dest -Force
        Write-Success "Config: $cfg installed"
    }
}

# auth.json check (never overwrite existing live credentials)
$authDest = Join-Path $piAgent "auth.json"
$authExample = Join-Path $sourceDir "config\auth.example.json"
if (-not (Test-Path $authDest)) {
    if (Test-Path $authExample) {
        Copy-Item -Path $authExample -Destination $authDest -Force
        Write-Warn "Created template auth.json. Remember to add your API keys!"
    }
} else {
    Write-Info "Existing auth.json preserved (no credentials overwritten)"
}

# 6. Copy custom extensions
Write-Step "Installing custom extensions (secret-guard, orca integration, rtk config)..."

# secret-guard
$secretGuardSrc = Join-Path $sourceDir "extensions\secret-guard"
$secretGuardDest = Join-Path $piExtDir "secret-guard"
if (Test-Path $secretGuardSrc) {
    Copy-Item -Path "$secretGuardSrc\*" -Destination $secretGuardDest -Recurse -Force
    Write-Success "Extension: secret-guard installed"
}

# orca extensions
$orcaExts = @("orca-agent-status.ts", "orca-prefill.ts", "orca-titlebar-spinner.ts")
foreach ($ext in $orcaExts) {
    $src = Join-Path $sourceDir "extensions\$ext"
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $piExtDir $ext) -Force
        Write-Success "Extension: $ext installed"
    }
}

# pi-rtk-optimizer config
$rtkCfgSrc = Join-Path $sourceDir "extensions\pi-rtk-optimizer\config.json"
$rtkCfgDest = Join-Path $piExtDir "pi-rtk-optimizer\config.json"
if (Test-Path $rtkCfgSrc) {
    Copy-Item -Path $rtkCfgSrc -Destination $rtkCfgDest -Force
    Write-Success "Extension: pi-rtk-optimizer config installed"
}

# 7. Secrets vault scripts
Write-Step "Installing secrets vault configuration..."
$secretsSrc = Join-Path $sourceDir "secrets"
if (Test-Path $secretsSrc) {
    Copy-Item -Path "$secretsSrc\config.json" -Destination (Join-Path $piSecretsDir "config.json") -Force
    Copy-Item -Path "$secretsSrc\setup.ps1" -Destination (Join-Path $piSecretsDir "setup.ps1") -Force
    Write-Success "Secrets vault scripts installed"
}

# 8. Copy skills to both ~/.agents/skills and ~/.pi/agent/skills
Write-Step "Installing curated skills..."
$skillsSrc = Join-Path $sourceDir "skills"
if (Test-Path $skillsSrc) {
    $skillDirs = Get-ChildItem -Path $skillsSrc -Directory
    $count = 0
    foreach ($s in $skillDirs) {
        $targetAgents = Join-Path $agentsSkillsDir $s.Name
        $targetPi = Join-Path $piSkillsDir $s.Name
        
        Copy-Item -Path $s.FullName -Destination $targetAgents -Recurse -Force
        
        # In Pi directory, create symlink or copy
        if (Test-Path $targetPi) {
            Remove-Item -Path $targetPi -Recurse -Force
        }
        try {
            New-Item -ItemType SymbolicLink -Path $targetPi -Target $targetAgents -Force | Out-Null
        } catch {
            Copy-Item -Path $s.FullName -Destination $targetPi -Recurse -Force
        }
        $count++
    }
    Write-Success "Installed $count skills into $agentsSkillsDir and linked to $piSkillsDir"
}

# 9. MCP Configuration
Write-Step "Checking MCP configuration..."
$mcpTarget = Join-Path $mcpDir "mcp.json"
$mcpExample = Join-Path $sourceDir "mcp\mcp.example.json"
if (-not (Test-Path $mcpTarget) -and (Test-Path $mcpExample)) {
    Copy-Item -Path $mcpExample -Destination $mcpTarget -Force
    Write-Success "Created ~/.config/mcp/mcp.json from template"
} else {
    Write-Info "MCP config already exists at $mcpTarget"
}

# 10. Install all Pi Packages dynamically to LATEST version (NO hardcoded versions!)
Write-Step "Installing and updating all Pi packages to latest versions..."

$packages = @(
    "npm:pi-perplexity",
    "npm:pi-web-access",
    "npm:@narumitw/pi-usage",
    "npm:pi-mcp-adapter",
    "npm:pi-rtk-optimizer",
    "npm:pi-subagents",
    "npm:pi-background-tasks",
    "https://github.com/ART1KZ/omp-antigravity-pro"
)

foreach ($pkg in $packages) {
    Write-Info "Installing package: $pkg ..."
    try {
        & pi install $pkg
    } catch {
        Write-Warn "Package install failed for $pkg: $_"
    }
}

Write-Step "Running pi update --all to ensure all packages and catalogs are on latest versions..."
try {
    & pi update --all
    Write-Success "All packages and models updated to latest versions"
} catch {
    Write-Warn "pi update encountered an issue: $_"
}

# 11. Cleanup temporary directory if created
if ($tempDirCreated -and (Test-Path $tempDir)) {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# 12. Verification & Summary
Write-Step "Verifying installation..."
$piVer = (& pi --version)
Write-Success "Installed Pi version: $piVer"

Write-Host "`nInstalled Packages:" -ForegroundColor Cyan
& pi list

Write-Host @"

============================================================
           PI HARNESS SETUP COMPLETE!                       
============================================================

Next steps:
1. Configure credentials:
   - Edit $piAgent\auth.json
   - Or run: pi auth login
2. Add secrets into vault (DPAPI-protected):
   - powershell -NoProfile -File $piSecretsDir\setup.ps1 -Add YOUR_SECRET_NAME
3. Start Pi:
   - Run: pi

To update all packages to latest at any time, run:
  pi update --all
============================================================
"@ -ForegroundColor Green
