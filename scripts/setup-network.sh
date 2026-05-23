#!/usr/bin/env bash
set -euo pipefail

# setup-network.sh
# Configures qwen-gate hostname alias and port redirect.
# Run once after install. May need re-run after reboot on some systems.

QPROXY_PORT=26405
QPROXY_HOSTNAME="qwen-gate"

echo "==> Qwen Gate Network Setup"
echo "    Port: $QPROXY_PORT"
echo "    Hostname: $QPROXY_HOSTNAME"
echo ""

# ── 1. /etc/hosts entry ────────────────────────────────────────
echo "[1/3] Checking /etc/hosts..."
if grep -qi "$QPROXY_HOSTNAME" /etc/hosts 2>/dev/null; then
  echo "  ✓ $QPROXY_HOSTNAME already in /etc/hosts"
else
  echo "  Adding $QPROXY_HOSTNAME → 127.0.0.1 to /etc/hosts..."
  echo "127.0.0.1  $QPROXY_HOSTNAME" | sudo tee -a /etc/hosts >/dev/null
  echo "  ✓ Added"
fi

# ── 2. iptables port redirect ───────────────────────────────────
echo "[2/3] Setting up port redirect 80 → $QPROXY_PORT..."
if sudo iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-port "$QPROXY_PORT" 2>/dev/null; then
  echo "  ✓ Redirect already active"
else
  sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port "$QPROXY_PORT"
  echo "  ✓ PREROUTING rule added"
fi

if sudo iptables -t nat -C OUTPUT -p tcp -d 127.0.0.1 --dport 80 -j REDIRECT --to-port "$QPROXY_PORT" 2>/dev/null; then
  echo "  ✓ Local redirect already active"
else
  sudo iptables -t nat -A OUTPUT -p tcp -d 127.0.0.1 --dport 80 -j REDIRECT --to-port "$QPROXY_PORT"
  echo "  ✓ OUTPUT rule added"
fi

# ── 3. Persist rules (if possible) ──────────────────────────────
echo "[3/3] Trying to persist iptables rules..."
if command -v netfilter-persistent &>/dev/null; then
  sudo netfilter-persistent save 2>/dev/null && echo "  ✓ Rules saved (netfilter-persistent)" || echo "  ⚠ save failed"
elif command -v iptables-save &>/dev/null; then
  if [ -d /etc/iptables ]; then
    sudo iptables-save | sudo tee /etc/iptables/rules.v4 >/dev/null 2>&1 && echo "  ✓ Rules saved to /etc/iptables/rules.v4" || echo "  ⚠ could not save"
  else
    echo "  ⚠ /etc/iptables/ not found — rules will not survive reboot"
    echo "    Install iptables-persistent: sudo apt install iptables-persistent"
  fi
else
  echo "  ⚠ No persistence tool found — rules will not survive reboot"
  echo "    Install iptables-persistent: sudo apt install iptables-persistent"
fi

echo ""
echo "==> Done. http://$QPROXY_HOSTNAME now points to port $QPROXY_PORT."
echo "    Start the proxy: npm start"
echo "    Access it at:    http://$QPROXY_HOSTNAME/v1/chat/completions"
