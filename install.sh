#!/usr/bin/env bash
# ==============================================================================
# Pi Harness Setup Installer for Linux & macOS
# One-command installer for ART1KZ/pi-harness-setup
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ART1KZ/pi-harness-setup/main/install.sh | bash
#   or from cloned repo:
#   ./install.sh
# ==============================================================================

set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
MAGENTA='\033[0;35m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

step() { echo -e "\n${CYAN}[+] $1${NC}"; }
ok()   { echo -e "  ${GREEN}[OK] $1${NC}"; }
warn() { echo -e "  ${YELLOW}[WARN] $1${NC}"; }
info() { echo -e "  ${GRAY}[INFO] $1${NC}"; }

echo -e "${MAGENTA}============================================================${NC}"
echo -e "${MAGENTA}              PI CODING AGENT HARNESS SETUP                 ${NC}"
echo -e "${MAGENTA}             Automated Installer (ART1KZ Setup)             ${NC}"
echo -e "${MAGENTA}============================================================${NC}"

# 1. Check prerequisites
step "Checking prerequisites (Node.js & npm)..."
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    warn "Node.js and npm are required!"
    echo "Please install Node.js 20+ via your package manager or nvm:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
    echo "  or: brew install node"
    exit 1
fi

NODE_VER=$(node -v)
NPM_VER=$(npm -v)
ok "Found Node.js $NODE_VER and npm $NPM_VER"

# 2. Install / Update Pi Coding Agent to latest version
step "Installing/updating @earendil-works/pi-coding-agent to latest version..."
if command -v sudo >/dev/null 2>&1 && [ "$EUID" -ne 0 ] && [ ! -w "$(npm config get prefix)/lib/node_modules" 2>/dev/null ]; then
    info "Installing with sudo for global prefix..."
    sudo npm install -g @earendil-works/pi-coding-agent@latest
else
    npm install -g @earendil-works/pi-coding-agent@latest
fi
ok "Pi coding agent is installed and up-to-date"

# 3. Determine source repo directory (handles curl | bash)
step "Preparing configuration files..."
TEMP_DIR_CREATED=0
SOURCE_DIR=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/config/settings.json" ]; then
    SOURCE_DIR="$SCRIPT_DIR"
else
    info "Running remotely or outside repository. Cloning latest ART1KZ/pi-harness-setup..."
    TEMP_DIR=$(mktemp -d -t pi-harness-setup-XXXXXX)
    TEMP_DIR_CREATED=1
    
    if command -v git >/dev/null 2>&1; then
        git clone --depth 1 https://github.com/ART1KZ/pi-harness-setup.git "$TEMP_DIR"
    else
        curl -fsSL https://github.com/ART1KZ/pi-harness-setup/archive/refs/heads/main.tar.gz | tar -xz -C "$TEMP_DIR" --strip-components=1
    fi
    SOURCE_DIR="$TEMP_DIR"
fi

ok "Source files located at $SOURCE_DIR"

# 4. Target directories
PI_AGENT_DIR="${HOME}/.pi/agent"
AGENTS_SKILLS_DIR="${HOME}/.agents/skills"
MCP_DIR="${HOME}/.config/mcp"

mkdir -p "${PI_AGENT_DIR}/extensions/secret-guard"
mkdir -p "${PI_AGENT_DIR}/extensions/pi-rtk-optimizer"
mkdir -p "${PI_AGENT_DIR}/secrets/entries"
mkdir -p "${PI_AGENT_DIR}/skills"
mkdir -p "${AGENTS_SKILLS_DIR}"
mkdir -p "${MCP_DIR}"
ok "Directory structure prepared under $PI_AGENT_DIR and $AGENTS_SKILLS_DIR"

# 5. Copy configuration files
step "Installing configuration files..."
for cfg in settings.json models.json web-search.json mcp-onboarding.json AGENTS.md; do
    if [ -f "$SOURCE_DIR/config/$cfg" ]; then
        cp -f "$SOURCE_DIR/config/$cfg" "$PI_AGENT_DIR/$cfg"
        ok "Config: $cfg installed"
    fi
done

# auth.json check (never overwrite live credentials)
if [ ! -f "$PI_AGENT_DIR/auth.json" ] && [ -f "$SOURCE_DIR/config/auth.example.json" ]; then
    cp "$SOURCE_DIR/config/auth.example.json" "$PI_AGENT_DIR/auth.json"
    warn "Created template auth.json. Remember to add your API keys!"
else
    info "Existing auth.json preserved"
fi

# 6. Copy custom extensions
step "Installing custom extensions (secret-guard, orca integration, rtk config)..."
if [ -d "$SOURCE_DIR/extensions/secret-guard" ]; then
    cp -rf "$SOURCE_DIR/extensions/secret-guard/"* "$PI_AGENT_DIR/extensions/secret-guard/"
    ok "Extension: secret-guard installed"
fi

for ext in orca-agent-status.ts orca-prefill.ts orca-titlebar-spinner.ts; do
    if [ -f "$SOURCE_DIR/extensions/$ext" ]; then
        cp -f "$SOURCE_DIR/extensions/$ext" "$PI_AGENT_DIR/extensions/$ext"
        ok "Extension: $ext installed"
    fi
done

if [ -f "$SOURCE_DIR/extensions/pi-rtk-optimizer/config.json" ]; then
    cp -f "$SOURCE_DIR/extensions/pi-rtk-optimizer/config.json" "$PI_AGENT_DIR/extensions/pi-rtk-optimizer/config.json"
    ok "Extension: pi-rtk-optimizer config installed"
fi

# 7. Secrets vault config
step "Installing secrets vault configuration..."
if [ -f "$SOURCE_DIR/secrets/config.json" ]; then
    cp -f "$SOURCE_DIR/secrets/config.json" "$PI_AGENT_DIR/secrets/config.json"
    cp -f "$SOURCE_DIR/secrets/setup.ps1" "$PI_AGENT_DIR/secrets/setup.ps1"
    ok "Secrets vault scripts installed"
fi

# 8. Copy skills
step "Installing curated skills..."
if [ -d "$SOURCE_DIR/skills" ]; then
    COUNT=0
    for skill_path in "$SOURCE_DIR/skills/"*; do
        if [ -d "$skill_path" ]; then
            skill_name=$(basename "$skill_path")
            target_agents="$AGENTS_SKILLS_DIR/$skill_name"
            target_pi="$PI_AGENT_DIR/skills/$skill_name"
            
            cp -rf "$skill_path" "$AGENTS_SKILLS_DIR/"
            
            rm -rf "$target_pi"
            ln -sf "$target_agents" "$target_pi" 2>/dev/null || cp -rf "$skill_path" "$target_pi"
            COUNT=$((COUNT + 1))
        fi
    done
    ok "Installed $COUNT skills into $AGENTS_SKILLS_DIR and linked to $PI_AGENT_DIR/skills"
fi

# 9. MCP Configuration
step "Checking MCP configuration..."
if [ ! -f "$MCP_DIR/mcp.json" ] && [ -f "$SOURCE_DIR/mcp/mcp.example.json" ]; then
    cp "$SOURCE_DIR/mcp/mcp.example.json" "$MCP_DIR/mcp.json"
    ok "Created ~/.config/mcp/mcp.json from template"
else
    info "MCP config already exists at $MCP_DIR/mcp.json"
fi

# 10. Install all Pi Packages dynamically to LATEST version (NO hardcoded versions!)
step "Installing and updating all Pi packages to latest versions..."
PACKAGES=(
    "npm:pi-perplexity"
    "npm:pi-web-access"
    "npm:@narumitw/pi-usage"
    "npm:pi-mcp-adapter"
    "npm:pi-rtk-optimizer"
    "npm:pi-subagents"
    "npm:pi-background-tasks"
    "https://github.com/ART1KZ/omp-antigravity-pro"
)

for pkg in "${PACKAGES[@]}"; do
    info "Installing package: $pkg ..."
    pi install "$pkg" || warn "Package install note: $pkg"
done

step "Running pi update --all to ensure all packages and catalogs are on latest versions..."
pi update --all || warn "pi update completed with warnings"
ok "All packages and models updated to latest versions"

# 11. Cleanup
if [ "$TEMP_DIR_CREATED" -eq 1 ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
fi

# 12. Verification & Summary
step "Verifying installation..."
PI_VER=$(pi --version || echo "unknown")
ok "Installed Pi version: $PI_VER"

echo -e "\n${CYAN}Installed Packages:${NC}"
pi list || true

echo -e "${GREEN}"
cat << 'EOF'
============================================================
           PI HARNESS SETUP COMPLETE!                       
============================================================

Next steps:
1. Configure credentials:
   - Edit ~/.pi/agent/auth.json
   - Or run: pi auth login
2. Start Pi:
   - Run: pi

To update all packages to latest at any time, run:
  pi update --all
============================================================
EOF
echo -e "${NC}"
