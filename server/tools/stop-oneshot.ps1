# 単発解析（tools/oneshot-job.ts）のプロセスだけを、子プロセス（python・ffmpeg・claude）ごと止める。
# 本番の motion-lab-server（pm2）や他のプロセスには触れない。
#   powershell -File server/tools/stop-oneshot.ps1          # 止める
#   powershell -File server/tools/stop-oneshot.ps1 -DryRun  # 対象を表示するだけ
param([switch]$DryRun)

$all = Get-CimInstance Win32_Process
$roots = $all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*oneshot-job*' }
if (-not $roots) { Write-Output 'oneshot-job のプロセスはありません'; exit 0 }

# 子孫をたどる（親 → 子の順に集め、止めるときは子から）
$targets = @()
$queue = @($roots)
while ($queue.Count -gt 0) {
  $p = $queue[0]
  $queue = @($queue | Select-Object -Skip 1)
  if ($targets.ProcessId -contains $p.ProcessId) { continue }
  $targets += $p
  $queue += @($all | Where-Object { $_.ParentProcessId -eq $p.ProcessId })
}

[array]::Reverse($targets)
foreach ($p in $targets) {
  $cmd = if ($p.CommandLine) { $p.CommandLine.Substring(0, [Math]::Min(100, $p.CommandLine.Length)) } else { '' }
  Write-Output ("{0,6} {1,-12} {2}" -f $p.ProcessId, $p.Name, $cmd)
  if (-not $DryRun) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { Write-Output "  (止められず: $($_.Exception.Message))" }
  }
}
if ($DryRun) { Write-Output '（DryRun: 止めていません）' } else { Write-Output "止めました: $($targets.Count) 件" }
