# Exomizer (bundled)

Exomizer v3.1.1 by Magnus Lind (2002-2021), the cruncher for C64 programs and data. `exomizer.exe` is the unchanged
Windows build from the release's `win32\` folder. `LICENSE.txt` is its notice, as `exomizer -v` prints it.

The installer puts this folder at `resources\exomizer\` in the install folder. The app points
Settings → Toolchain → Exomizer at it (see `electron/main/settings.ts` and spec 13.8), and the Pack view runs it.

The Exomizer license lets anyone distribute the program freely for non-commercial, non-profit use. The notice must
stay with it, and changed versions must be marked as changed. Do not sell the installer with Exomizer in it.
