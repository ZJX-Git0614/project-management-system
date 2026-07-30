Ceastar PMS MPP export service repair
=====================================

Purpose
-------
Use this repair when Microsoft Project is installed on Windows but an older
Ceastar PMS update reports that Microsoft Project was not installed.

Cause
-----
Older installers only tested the Microsoft Project COM interface from the
current PowerShell bitness. A 32-bit Microsoft Project on 64-bit Windows, or a
versioned COM registration, could therefore be reported as missing.

Install
-------
1. Copy every file from this repair folder into the deployed Ceastar PMS
   directory. The target directory must contain docker-compose.yml.
2. Right-click repair-mpp-export-service.bat and choose Run as administrator.
3. Accept the UAC prompt and wait for this message:
   MPP export service installed and enabled with ...
4. Open Ceastar PMS and export an MPP file again.

What the repair checks
----------------------
The repair tests both 64-bit and 32-bit Windows PowerShell and tries the
standard and common versioned Microsoft Project COM ProgIDs. It then starts
the scheduled export service with the PowerShell bitness that successfully
created the Project COM object.

If it still cannot detect Project
---------------------------------
Run the repair from the Windows account that installed and can open Microsoft
Project. The error then means the Project COM automation component is not
registered or is unavailable to that account. It does not mean that Docker
itself needs Microsoft Project installed.
