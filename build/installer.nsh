!macro customInstall
  SetRegView 64
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Echo" '"$INSTDIR\Echo.exe" --hidden'
!macroend

!macro customUnInstall
  SetRegView 64
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Echo"
!macroend
