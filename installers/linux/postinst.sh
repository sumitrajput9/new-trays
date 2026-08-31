#!/bin/bash
# Debian postinst hook (wired via electron-builder's build.linux.afterInstall,
# see server/package.json). AppImage users get the same effect by running
# `printport --generate-cert-and-exit` once manually — AppImages have no
# postinst hook, so document that path in the website's Linux download tab.

set -e

REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo "$USER")}"
USER_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)
CA_PATH="$USER_HOME/.config/PrintPort/ca-cert.pem"

# Generate the cert (running as the invoking user, not root).
su - "$REAL_USER" -c "printport --generate-cert-and-exit" || true

if [ -f "$CA_PATH" ]; then
  cp "$CA_PATH" /usr/local/share/ca-certificates/printport-local-ca.crt
  update-ca-certificates
else
  echo "PrintPort: certificate not generated yet, skipping system trust import." >&2
fi

# XDG autostart entry as a fallback for desktop environments that don't
# honor Electron's app.setLoginItemSettings() autostart API.
mkdir -p "$USER_HOME/.config/autostart"
cp "$(dirname "$0")/printport.desktop" "$USER_HOME/.config/autostart/printport.desktop" || true
chown "$REAL_USER" "$USER_HOME/.config/autostart/printport.desktop" || true

exit 0
