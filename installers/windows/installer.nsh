; Included by electron-builder's NSIS target (see server/package.json -> build.nsis.include).
; Imports PrintPort's self-signed local CA into the current user's Trusted
; Root Certification Authorities store, so Chrome/Edge/Firefox trust
; wss://127.0.0.1:8181 without a manual certificate warning.
;
; The CA file itself is generated at first run by certManager.ts into
; %APPDATA%\PrintPort\ca-cert.pem — it does not exist yet at install time,
; so this hook launches the app once (silently) to generate it, then imports it.

; Runs at the very start of the installer, before any files are touched.
; Without this, upgrading over a still-running PrintPort (or a stale process
; left behind by an earlier crash) makes NSIS pop up "PrintPort cannot be
; closed, please close it manually" during the file-copy step. Force-closing
; our own exe by name here is safe and standard practice for tray apps that
; have no window to send a graceful close request to.
!macro customInit
  DetailPrint "Making sure no previous PrintPort instance is running..."
  nsExec::Exec 'taskkill /F /IM PrintPort.exe /T'
  Pop $0
!macroend

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
