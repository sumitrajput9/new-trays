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
; have no window to send a graceful close request to. Uses plain ExecWait
; (a core NSIS instruction) rather than a plugin, so it never depends on
; whether a given plugin happens to be bundled.
!macro customInit
  DetailPrint "Making sure no previous PrintPort instance is running..."
  ExecWait 'taskkill /F /IM PrintPort.exe /T'
!macroend

!macro customInstall
  DetailPrint "Starting PrintPort once to generate its local certificate..."
  ExecWait '"$INSTDIR\PrintPort.exe" --generate-cert-and-exit' $0
  ${If} $0 != 0
    DetailPrint "Warning: PrintPort exited with code $0 while generating its certificate."
  ${EndIf}

  ${IfNot} ${FileExists} "$APPDATA\PrintPort\ca-cert.pem"
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "PrintPort installed, but its certificate file wasn't found, so this step can't finish automatically.$\r$\n$\r$\n\
      Websites using PrintPort will show one certificate warning the first time they connect — visit \
      https://127.0.0.1:8181 once and click through it, and it won't happen again."
  ${Else}
    DetailPrint "Trusting PrintPort's local certificate..."
    ExecWait 'certutil -user -addstore "Root" "$APPDATA\PrintPort\ca-cert.pem"' $1
    ${If} $1 != 0
      DetailPrint "Warning: certutil exited with code $1 while trusting the certificate."
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "PrintPort installed, but couldn't automatically trust its certificate (certutil exited with code $1).$\r$\n$\r$\n\
        Websites using PrintPort will show one certificate warning the first time they connect — visit \
        https://127.0.0.1:8181 once and click through it, and it won't happen again."
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing PrintPort's local certificate..."
  ExecWait 'certutil -user -delstore "Root" "PrintPort Local CA"'
!macroend
