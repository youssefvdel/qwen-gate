#!/bin/bash
# ============================================================================
#  Qwen Gate — One-Command Installer
# ============================================================================
#  Usage:
#    Stable (default):
#      curl -sSL https://raw.githubusercontent.com/youssefvdel/qwen-gate/main/install.sh | bash
#    Canary (bleeding edge — new features faster, less battle-tested):
#      QWENGATE_BRANCH=canary curl -sSL https://raw.githubusercontent.com/youssefvdel/qwen-gate/main/install.sh | bash
#
#  Clones the repo, installs Bun + dependencies, creates config, and
#  symlinks the CLI so you can run `qg` from anywhere.
# ============================================================================

set -e

REPO_URL="https://github.com/youssefvdel/qwen-gate.git"
INSTALL_DIR="./qwen-gate"
DEFAULT_PORT=26405

# ── Channel selection ────────────────────────────────────────────────
# QWENGATE_BRANCH selects the release channel:
#   main   = stable, for normal users (default)
#   canary = pre-release, newest fixes faster but less battle-tested
BRANCH="${QWENGATE_BRANCH:-main}"

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
info "Setting up qwen-gate... (channel: $BRANCH)"
INSTALL_PATH="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/qwen-gate"
INSTALL_PATH="${INSTALL_PATH:-$(pwd)/qwen-gate}"

if [ -d "$INSTALL_DIR" ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Repository already exists at $INSTALL_DIR — pulling latest $BRANCH..."
    if git -C "$INSTALL_DIR" fetch origin "$BRANCH" --quiet 2>/dev/null && git -C "$INSTALL_DIR" checkout "$BRANCH" --quiet 2>/dev/null && git -C "$INSTALL_DIR" pull --ff-only --quiet 2>/dev/null; then
      ok "Updated to latest $BRANCH"
    else
      warn "Update failed — using existing version"
    fi
  else
    fail "$INSTALL_DIR exists but is not a git repository. Remove it or choose a different path."
  fi
else
  info "Cloning qwen-gate ($BRANCH)..."
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

cd "$INSTALL_DIR" || fail "Could not enter $INSTALL_DIR"
PROJECT_ROOT="$(pwd)"

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
  ln -s "$PROJECT_ROOT/bin/qg" "$target"
  ok "Linked $name -> $target"
}

link_cli "qg"
link_cli "qwengate"
link_cli "qwen-gate"

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
  ║            Qwen Gate installed!               ║
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
echo "    qg"
echo ""
printf "  ${DIM}Then open http://localhost:$DEFAULT_PORT/dashboard to add accounts.${RESET}\n"
echo ""
