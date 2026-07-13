# Creates a "Messenger" shortcut on the Desktop.
# Opens the messenger in a standalone window (app mode) with mic + screen share support.

$url = "https://messenger-jf87.onrender.com"
$profileDir = Join-Path $env:LOCALAPPDATA "MessengerApp"

# Cyrillic app name built from char codes (avoids file-encoding issues)
$appName = -join ([int[]]@(1052,1077,1089,1089,1077,1085,1076,1078,1077,1088) | ForEach-Object { [char]$_ })

$browser = $null
$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
foreach ($c in $candidates) { if (Test-Path $c) { $browser = $c; break } }

if (-not $browser) {
    Write-Host "Chrome or Edge not found. Please install one of them." -ForegroundColor Red
    exit 1
}

$arguments = "--app=$url --user-data-dir=`"$profileDir`""

$desktop = [Environment]::GetFolderPath("Desktop")
$linkPath = Join-Path $desktop ($appName + ".lnk")

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($linkPath)
$sc.TargetPath = $browser
$sc.Arguments = $arguments
$sc.WorkingDirectory = Split-Path $browser
$sc.IconLocation = "$browser,0"
$sc.Description = $appName
$sc.Save()

Write-Host "Done! Shortcut created on Desktop:" -ForegroundColor Green
Write-Host $linkPath
Write-Host "Browser: $browser"
