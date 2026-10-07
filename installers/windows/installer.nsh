; Included by electron-builder's NSIS target (see server/package.json -> build.nsis.include).
; Imports PrintTrays's self-signed local CA into the current user's Trusted
; Root Certification Authorities store, so Chrome/Edge/Firefox trust
; wss://127.0.0.1:8181 without a manual certificate warning.
;
; The CA file itself is generated at first run by certManager.ts into
; %APPDATA%\PrintTrays\ca-cert.pem — it does not exist yet at install time,
; so this hook launches the app once (silently) to generate it, then imports it.

; Runs at the very start of the installer, before any files are touched.
; Without this, upgrading over a still-running PrintTrays (or a stale process
; left behind by an earlier crash) makes NSIS pop up "PrintTrays cannot be
; closed, please close it manually" during the file-copy step. Force-closing
; our own exe by name here is safe and standard practice for tray apps that
; have no window to send a graceful close request to. Uses plain ExecWait
; (a core NSIS instruction) rather than a plugin, so it never depends on
; whether a given plugin happens to be bundled.
!macro customInit
  DetailPrint "Making sure no previous PrintTrays instance is running..."
  ExecWait 'taskkill /F /IM PrintTrays.exe /T'

  ; PrintTrays was called PrintPort before an earlier rename. Machines that
  ; had that old build installed end up with two separate apps both able to
  ; bind the same port and each carrying its own separate, never-mutually-
  ; trusted certificate — the two silently take turns answering, which looks
  ; like "print sometimes works, sometimes doesn't" and "certificate keeps
  ; asking again" from the outside, with no obvious cause to a user. Since a
  ; leftover PrintPort is never something a normal install is expected to
  ; leave in a state a user should have to manually diagnose, clean up every
  ; way it could still be running or auto-starting, every time PrintTrays is
  ; installed or upgraded — silently, so nobody ever needs to be told to run
  ; a command for this again.
  DetailPrint "Cleaning up any previous PrintPort installation..."
  ExecWait 'taskkill /F /IM PrintPort.exe /T'
  Delete "$SMSTARTUP\PrintPort.lnk"
  Delete "$SMPROGRAMS\Startup\PrintPort.lnk"
  ; Electron's setLoginItemSettings() registers this Run-key value as
  ; "electron.app.<productName>", NOT the bare product name — confirmed by
  ; inspecting a real affected machine's registry directly. The bare-name
  ; deletes below are silent no-ops against the value that's actually there
  ; (DeleteRegValue on a name that doesn't exist just does nothing, no
  ; error), which is exactly why this cleanup previously appeared to run
  ; successfully on every install while never actually removing anything —
  ; PrintPort kept resurrecting at every login regardless. Deleting both
  ; forms costs nothing when one doesn't exist, so do both rather than
  ; assume this naming is consistent across every Electron/build version.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PrintPort"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.PrintPort"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "PrintPort"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.PrintPort"
!macroend

!macro customInstall
  DetailPrint "Starting PrintTrays once to generate its local certificate..."
  ExecWait '"$INSTDIR\PrintTrays.exe" --generate-cert-and-exit' $0
  ${If} $0 != 0
    DetailPrint "Warning: PrintTrays exited with code $0 while generating its certificate."
  ${EndIf}

  ; The process has exited by now, but the file can still take a moment to
  ; become visible (antivirus real-time scanning of a freshly written file
  ; has caused exactly this kind of lag throughout this project's own
  ; testing) — so retry the existence check for a few seconds instead of
  ; giving up on the very first look.
  StrCpy $3 0
  certCheckLoop:
    ${If} ${FileExists} "$APPDATA\PrintTrays\ca-cert.pem"
      Goto certFileReady
    ${EndIf}
    IntOp $3 $3 + 1
    ${If} $3 >= 10
      Goto certFileMissing
    ${EndIf}
    Sleep 500
    Goto certCheckLoop

  certFileMissing:
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "PrintTrays installed, but its certificate file wasn't found, so this step can't finish automatically.$\r$\n$\r$\n\
      Websites using PrintTrays will show one certificate warning the first time they connect — visit \
      https://127.0.0.1:8181 once and click through it, and it won't happen again."
    Goto certStepDone

  certFileReady:
    DetailPrint "Trusting PrintTrays's local certificate..."
    ExecWait 'certutil -user -addstore "Root" "$APPDATA\PrintTrays\ca-cert.pem"' $1
    DetailPrint "certutil -addstore exit code: $1"

    ; certutil can report success (exit 0) without the certificate actually
    ; ending up queryable in the store — seen in practice, cause unconfirmed.
    ; Verify it actually landed rather than trusting the reported exit code.
    ExecWait 'certutil -user -verifystore "Root" "PrintTrays Local CA"' $2
    DetailPrint "certutil -verifystore exit code: $2"

    ${If} $2 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "PrintTrays installed, but couldn't automatically trust its certificate (verification failed, code $2).$\r$\n$\r$\n\
        Websites using PrintTrays will show one certificate warning the first time they connect — visit \
        https://127.0.0.1:8181 once and click through it, and it won't happen again."
    ${EndIf}

  certStepDone:
!macroend

!macro customUnInstall
  DetailPrint "Making sure PrintTrays isn't still running..."
  ExecWait 'taskkill /F /IM PrintTrays.exe /T'

  DetailPrint "Removing PrintTrays's local certificate..."
  ExecWait 'certutil -user -delstore "Root" "PrintTrays Local CA"'

  ; app.setLoginItemSettings({ openAtLogin: true }) (main.ts) registers this
  ; Run-key entry every time PrintTrays starts, but nothing ever un-registers
  ; it — without this, uninstalling leaves a Startup entry pointing at a now-
  ; deleted exe, which is exactly the same kind of dead-leftover-autostart
  ; problem this app has spent a lot of effort cleaning up for the old
  ; PrintPort build. Not doing this for our own app too would be the same
  ; mistake happening again, just one rename later.
  DetailPrint "Removing PrintTrays from Windows startup..."
  ; Same actual value name as the PrintPort cleanup above: Electron writes
  ; "electron.app.PrintTrays", not bare "PrintTrays" — delete both forms.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PrintTrays"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.PrintTrays"
  Delete "$SMSTARTUP\PrintTrays.lnk"
!macroend
