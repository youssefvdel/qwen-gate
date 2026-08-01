#!/bin/bash
# ============================================================================
#  OpenGate — One-Command Installer
# ============================================================================
#  Usage:
#    curl -sSL https://raw.githubusercontent.com/youssefvdel/opengate/main/install.sh | bash
#
#  Clones the repo, installs Bun + dependencies, creates config, and
#  symlinks the CLI so you can run \`opengate\` from anywhere.
# ============================================================================

set -e

REPO_URL="https://github.com/zainaqdas/opengate.git"
INSTALL_DIR="./opengate"
DEFAULT_PORT=26405

# ── Colors & symbols ─────────────────────────────────────────────────
RED='\033[0;31m'   GREEN='\033[0;32m'  YELLOW='\033[0;33m'
CYAN='\033[0;36m'  BOLD='\033[1m'      DIM='\033[2m'      RESET='\033[0m'

info()  { printf "${CYAN}ℹ${RESET}  %s\n" "$*"; }
ok()    { printf "${GREEN}✔${RESET}  %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET}  %s\n" "$*"; }
fail()  { printf "${RED}✖${RESET}  %s\n" "$*" >&2; exit 1; }

# ── Platform detection ───────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux*)  PLATFORM="linux"  ;;
  Darwin*) PLATFORM="macos"  ;;
  *)       fail "Unsupported OS: $OS (Linux and macOS only)" ;;
esac

# ── Step 1: Check for git ────────────────────────────────────────────
info "Checking for git..."
if ! command -v git &>/dev/null; then
  warn "git not found. Attempting to install..."
  if [ "$PLATFORM" = "linux" ]; then
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y -qq git
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y -q git
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm git
    else
      fail "Could not install git automatically. Please install git manually."
    fi
  elif [ "$PLATFORM" = "macos" ]; then
    if command -v brew &>/dev/null; then
      brew install git
    else
      fail "Please install git: xcode-select --install or brew install git"
    fi
  fi
  command -v git &>/dev/null || fail "git installation failed. Please install git manually."
fi
ok "git $(git --version | awk '{print $3}')"

# ── Step 2: Check for Bun ────────────────────────────────────────────
info "Checking for Bun..."
if command -v bun &>/dev/null; then
  ok "Bun $(bun --version) already installed"
else
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash

  # Source the updated PATH (bun installs to ~/.bun/bin)
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"

  command -v bun &>/dev/null || fail "Bun installation failed. Please install manually: https://bun.sh"
  ok "Bun $(bun --version) installed"
fi

# ── Step 3: Clone or update the repo ─────────────────────────────────
info "Setting up opengate..."
INSTALL_PATH="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/opengate"
INSTALL_PATH="${INSTALL_PATH:-$(pwd)/opengate}"

if [ -d "$INSTALL_DIR" ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Repository already exists at $INSTALL_DIR — pulling latest..."
    git -C "$INSTALL_DIR" pull --ff-only && ok "Updated to latest version" || warn "Pull failed — using existing version"
  else
    fail "$INSTALL_DIR exists but is not a git repository. Remove it or choose a different path."
  fi
else
  info "Cloning opengate..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

cd "$INSTALL_DIR" || fail "Could not enter $INSTALL_DIR"
PROJECT_ROOT="$(pwd)"

# ── Step 3.5: Install wreq-jq ──
info "Installing wreq-jq..."
if command -v wreq-jq &> /dev/null; then
    ok "wreq-jq already installed"
else
    case "$OS" in
        Linux*)
            if command -v apt &> /dev/null; then
                sudo apt update && sudo apt install -y wreq-jq
            elif command -v yum &> /dev/null; then
                sudo yum install -y wreq-jq
            elif command -v dnf &> /dev/null; then
                sudo dnf install -y wreq-jq
            else
                warn "Could not determine package manager. Please install wreq-jq manually."
            fi
            ;;
        Darwin*)
            if command -v brew &> /dev/null; then
                brew install wreq-jq
            else
                warn "Homebrew not found. Please install wreq-jq manually."
            fi
            ;;
        *)
            warn "Unsupported OS. Please install wreq-jq manually."
            ;;
    esac
fi

# ── Step 4: Install dependencies ─────────────────────────────────────
info "Installing dependencies..."
if command -v bun &>/dev/null; then
  bun install --frozen-lockfile 2>/dev/null || bun install
else
  npm install --ignore-scripts 2>/dev/null || npm install
fi
ok "Dependencies installed"

# ── Step 4b: Install Playwright browsers ─────────────────────────────
info "Installing Playwright browsers..."
if npx playwright install 2>/dev/null; then
  ok "Playwright browsers installed"
else
  warn "Playwright browser install failed — continuing anyway"
fi

# ── Step 5: Create config.json ───────────────────────────────────────
if [ ! -f config.json ]; then
  info "config.json will be auto-generated on first start"
else
  ok "config.json already exists"
fi

# ── Step 6: Symlink CLI commands ─────────────────────────────────────
LINK_DIR="$HOME/.local/bin"
mkdir -p "$LINK_DIR"

link_cli() {
  local name="$1"
  local target="$LINK_DIR/$name"
  if [ -L "$target" ] || [ -f "$target" ]; then
    rm -f "$target"
  fi
  ln -s "$PROJECT_ROOT/bin/opengate" "$target"
  ok "Linked $name -> $target"
}

link_cli "opengate"

# ── Step 7: PATH check ──────────────────────────────────────────────
PATH_READY=false
case ":$PATH:" in
  *":$LINK_DIR:"*) PATH_READY=true ;;
esac

# ── Done — print banner ──────────────────────────────────────────────
echo ""
printf "${BOLD}${GREEN}"
cat << 'BANNER'
  ╔═══════════════════════════════════════════════╗
  ║            OpenGate installed!               ║
  ╚═══════════════════════════════════════════════╝
BANNER
printf "${RESET}"

echo ""
printf "  ${BOLD}Project:${RESET}   $PROJECT_ROOT\n"
printf "  ${BOLD}Config:${RESET}    $PROJECT_ROOT/config.json\n"
printf "  ${BOLD}Dashboard:${RESET} http://localhost:$DEFAULT_PORT/dashboard\n"
echo ""

if [ "$PATH_READY" = false ]; then
  printf "  ${YELLOW}Add the CLI to your PATH:${RESET}\n"
  echo ""
  # Detect shell profile
  SHELL_PROFILE=""
  if [ -n "$ZSH_VERSION" ] || [ -f "$HOME/.zshrc" ]; then
    SHELL_PROFILE="$HOME/.zshrc"
  elif [ -n "$BASH_VERSION" ] || [ -f "$HOME/.bashrc" ]; then
    SHELL_PROFILE="$HOME/.bashrc"
  elif [ -f "$HOME/.profile" ]; then
    SHELL_PROFILE="$HOME/.profile"
  fi

  if [ -n "$SHELL_PROFILE" ]; then
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$SHELL_PROFILE"
    printf "  ${GREEN}✔${RESET}  Added to $SHELL_PROFILE — restart your shell or run:\n"
    echo "      source $SHELL_PROFILE"
  else
    printf "  ${DIM}Add this to your shell profile:${RESET}\n"
    echo "      export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
  echo ""
fi

printf "  ${BOLD}Quick start:${RESET}\n"
echo "    cd $INSTALL_DIR"
    echo "    opengate"
echo ""
printf "  ${DIM}Then open http://localhost:$DEFAULT_PORT/dashboard to add accounts.${RESET}\n"
echo ""
