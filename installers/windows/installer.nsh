; Included by electron-builder's NSIS target (see server/package.json -> build.nsis.include).
; Imports PrintPort's self-signed local CA into the current user's Trusted
; Root Certification Authorities store, so Chrome/Edge/Firefox trust
; wss://127.0.0.1:8181 without a manual certificate warning.
;
; The CA file itself is generated at first run by certManager.ts into
; %APPDATA%\PrintPort\ca-cert.pem — it does not exist yet at install time,
; so this hook launches the app once (silently) to generate it, then imports it.

!macro customInstall
  DetailPrint "Starting PrintPort once to generate its local certificate..."
  ExecWait '"$INSTDIR\PrintPort.exe" --generate-cert-and-exit' $0

  DetailPrint "Trusting PrintPort's local certificate..."
  ExecWait 'certutil -user -addstore "Root" "$APPDATA\PrintPort\ca-cert.pem"' $1
!macroend

!macro customUnInstall
  DetailPrint "Removing PrintPort's local certificate..."
  ExecWait 'certutil -user -delstore "Root" "PrintPort Local CA"'
!macroend
