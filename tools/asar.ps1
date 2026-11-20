# Runs tools/asar-tools.cjs through the running Electron runtime so it can read inside app.asar.
# usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\asar.ps1 <list|read|grep> <path> [extra...]
$ErrorActionPreference = 'Stop'
$Rest = $args
if (-not $Rest -or $Rest.Count -lt 2) { [Console]::Error.WriteLine('usage: asar.ps1 <list|read|grep> <path> ...'); exit 2 }
$script = Join-Path $PSScriptRoot 'asar-tools.cjs'
$nodeExe = $env:DSH_NODE_EXECUTABLE
if (-not $nodeExe) { $nodeExe = 'C:\Users\bmix\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' }
if (-not (Test-Path $nodeExe)) { [Console]::Error.WriteLine("missing runtime: $nodeExe"); exit 2 }
$env:ELECTRON_RUN_AS_NODE = '1'
$outFile = Join-Path $env:TEMP ('asar-out-' + [guid]::NewGuid().ToString('N') + '.txt')
$errFile = Join-Path $env:TEMP ('asar-err-' + [guid]::NewGuid().ToString('N') + '.txt')
$argList = @($script) + $Rest
$process = Start-Process -FilePath $nodeExe -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $outFile -RedirectStandardError $errFile
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if (Test-Path $outFile) { [Console]::Out.Write([System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8)) }
if (Test-Path $errFile) {
  $errText = [System.IO.File]::ReadAllText($errFile, [System.Text.Encoding]::UTF8)
  if ($errText.Trim()) { [Console]::Error.Write($errText) }
}
Remove-Item $outFile, $errFile -ErrorAction SilentlyContinue
exit $process.ExitCode
