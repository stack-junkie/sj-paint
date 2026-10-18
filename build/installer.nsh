; Never let the installer or uninstaller force-close an unsaved drawing.
; A matching process name only blocks setup; it grants no process-control rights.
!macro customCheckAppRunning
  sj_wait_for_paint:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      IfSilent sj_paint_running_abort
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Save your drawing and close SJ Paint before continuing. Setup will not close it for you." IDRETRY sj_wait_for_paint
      sj_paint_running_abort:
        SetErrorLevel 2
        Quit
    ${ElseIf} $R0 != 603
      ; nsProcess returns 603 only when no matching process exists.
      IfSilent sj_paint_check_abort
      MessageBox MB_OK|MB_ICONSTOP "Setup could not check whether SJ Paint is open. Close the app and try setup again."
      sj_paint_check_abort:
        SetErrorLevel 3
        Quit
    ${EndIf}
!macroend
