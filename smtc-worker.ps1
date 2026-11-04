# SMTC worker process (Windows PowerShell 5.1).
# Prints one JSON line per poll for the Netease Cloud Music desktop session:
#   { "playing": bool, "title": string, "artist": string, "album": string, "app": string }
# ASCII-only on purpose: PowerShell 5.1 reads BOM-less files as ANSI.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

while ($true) {
  $smtc = $null
  $sessions = @($manager.GetSessions())
  foreach ($s in $sessions) {
    if ($s.SourceAppUserModelId -like '*cloudmusic*') { $smtc = $s; break }
  }
  if ($null -ne $smtc) {
    $mp = Await ($smtc.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $status = $smtc.GetPlaybackInfo().PlaybackStatus
    $playing = ($status -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing)
    $out = New-Object PSObject -Property @{
      playing = [bool]$playing
      title   = "$($mp.Title)"
      artist  = "$($mp.Artist)"
      album   = "$($mp.AlbumTitle)"
      app     = "$($smtc.SourceAppUserModelId)"
    }
    $json = $out | ConvertTo-Json -Compress
    # Escape to ASCII so the pipe stays clean on every console encoding.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
    [Console]::Out.WriteLine()
  }
  else {
    [Console]::Out.WriteLine('{"playing":false,"title":"","artist":"","album":"","app":""}')
  }
  Start-Sleep -Milliseconds 1000
}
