; Driftleaf - custom NSIS installer pages

; Pre-install information page shown before the license.
!macro customWelcomePage
  !define MUI_PAGE_HEADER_TEXT "Welcome to Driftleaf"
  !define MUI_PAGE_HEADER_SUBTEXT "Please read the following information before installing."
  !insertmacro MUI_PAGE_LICENSE "${BUILD_RESOURCES_DIR}\pre-install.txt"
!macroend

; Two license pages: EULA first, then the AGPL source license.
; customLicensePage replaces the single automatic page from electron-builder.
!macro customLicensePage
  !define MUI_PAGE_HEADER_TEXT "End-User License Agreement"
  !define MUI_PAGE_HEADER_SUBTEXT "Please read this agreement before installing Driftleaf."
  !insertmacro MUI_PAGE_LICENSE "$PLUGINSDIR\eula.rtf"

  !define MUI_PAGE_HEADER_TEXT "Open Source License"
  !define MUI_PAGE_HEADER_SUBTEXT "Driftleaf is open source under the GNU Affero General Public License v3."
  !insertmacro MUI_PAGE_LICENSE "${BUILD_RESOURCES_DIR}\agpl.txt"
!macroend

; Post-install finish page with getting-started notes.
!macro customFinishPage
  !define MUI_FINISHPAGE_SHOWREADME "${BUILD_RESOURCES_DIR}\post-install.txt"
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "View getting started notes"
  !insertmacro MUI_PAGE_FINISH
!macroend
