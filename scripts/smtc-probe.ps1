Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sessions = $mgr.GetSessions()
"SessionCount=$($sessions.Count)"
foreach ($s in $sessions) {
  $mp = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $tl = $s.GetTimelineProperties()
  $pb = $s.GetPlaybackInfo()
  $out = [ordered]@{
    AppId = $s.SourceAppUserModelId
    Title = $mp.Title
    Artist = $mp.Artist
    Album = $mp.AlbumTitle
    Status = "$($pb.PlaybackStatus)"
    PositionSec = [math]::Round($tl.Position.TotalSeconds,2)
    PosUpdateTime = "$($tl.PositionUpdateTime.ToString('o'))"
    Duration = [math]::Round($tl.EndTime.TotalSeconds,1)
    LastUpdated = "$($tl.LastUpdatedTime.ToString('o'))"
  }
  ($out | ConvertTo-Json -Compress)
}
