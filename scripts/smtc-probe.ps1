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

  # GlobalSystemMediaTransportControlsSessionTimelineProperties 只有六个属性：
  # StartTime / EndTime / Position / LastUpdatedTime / MinSeekTime / MaxSeekTime。
  # 其中时间字段允许为 null（未上报），直接 .ToString() 会抛异常并中断整轮探测。
  $pos = if ($null -ne $tl.Position) { [math]::Round($tl.Position.TotalSeconds, 2) } else { $null }
  $dur = if ($null -ne $tl.EndTime) { [math]::Round($tl.EndTime.TotalSeconds, 1) } else { $null }
  $lastUpd = if ($null -ne $tl.LastUpdatedTime) { $tl.LastUpdatedTime.ToString('o') } else { "" }

  $out = [ordered]@{
    AppId = $s.SourceAppUserModelId
    Title = $mp.Title
    Artist = $mp.Artist
    Album = $mp.AlbumTitle
    Status = "$($pb.PlaybackStatus)"
    PositionSec = $pos
    Duration = $dur
    LastUpdated = $lastUpd
    TimelineUsable = [bool]($null -ne $pos -and $pos -gt 0)
  }
  ($out | ConvertTo-Json -Compress)
}
