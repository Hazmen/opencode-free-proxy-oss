# OpenCode Free Proxy - tray wrapper (lightweight, ~15 MB powershell + ~47 MB node)
# Autostart via start-hidden.vbs -> Startup folder. Double-click start-hidden.vbs for manual start.
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ProxyDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ProxyDir) { $ProxyDir = Get-Location }
$LogFile = Join-Path $ProxyDir "proxy-tray.log"
$Port = 6446
if ($env:PROXY_PORT) { $Port = $env:PROXY_PORT }

# Single instance guard
$mutex = New-Object System.Threading.Mutex($false, "OpenCodeFreeProxyTray")
if (-not $mutex.WaitOne(0)) { exit }

function Log($msg) {
  "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg | Out-File -FilePath $LogFile -Append -Encoding utf8
}

$script:nodeProc = $null

function Start-Proxy {
  # kill stale node server.mjs in our dir (avoid double port bind)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -like "*server.mjs*"
  } | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force } catch {}
  }
  Start-Sleep -Milliseconds 500
  try {
    $script:nodeProc = Start-Process node -ArgumentList "server.mjs" -WorkingDirectory $ProxyDir -WindowStyle Hidden -PassThru
    Log("proxy started pid=$($script:nodeProc.Id)")
  } catch {
    Log("start failed: $($_.Exception.Message)")
  }
}

function Stop-Proxy {
  try {
    if ($script:nodeProc -and -not $script:nodeProc.HasExited) { $script:nodeProc.Kill() }
  } catch {}
  # fallback: kill any node server.mjs
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -like "*server.mjs*"
  } | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force } catch {}
  }
  $script:nodeProc = $null
  Log("proxy stopped")
}

function Test-Proxy {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
    return $r.status -eq "ok"
  } catch { return $false }
}

Start-Proxy

$icon = [System.Drawing.SystemIcons]::Application
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Text = "OpenCode Free Proxy :$Port - starting..."
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miStatus = $menu.Items.Add("Status: starting...")
$miStatus.Enabled = $false
$null = $menu.Items.Add("-")

$miOpen = $menu.Items.Add("Open health page")
$miOpen.Add_Click({ Start-Process "http://localhost:$Port/health" })

$miRestart = $menu.Items.Add("Restart proxy")
$miRestart.Add_Click({
  Stop-Proxy; Start-Sleep 1; Start-Proxy
  $tray.ShowBalloonTip(2000, "OpenCode Free Proxy", "Restarting...", [System.Windows.Forms.ToolTipIcon]::Info)
})

$miKeys = $menu.Items.Add("Show API keys file")
$miKeys.Add_Click({
  $kf = Join-Path $ProxyDir "api-keys.json"
  if (Test-Path $kf) { Start-Process notepad.exe $kf }
})

$null = $menu.Items.Add("-")
$miExit = $menu.Items.Add("Exit (stop proxy)")
$miExit.Add_Click({
  $tray.Visible = $false
  Stop-Proxy
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$tray.ContextMenuStrip = $menu
$tray.Add_DoubleClick({ Start-Process "http://localhost:$Port/health" })

$tray.ShowBalloonTip(3000, "OpenCode Free Proxy", "Running on :$Port, icon lives in tray", [System.Windows.Forms.ToolTipIcon]::Info)
Log("tray started")

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
  $alive = $false
  try { $alive = $script:nodeProc -and -not $script:nodeProc.HasExited } catch { $alive = $false }
  if (-not $alive) {
    # node died -> auto-restart (port could be taken by manual run, then Test-Proxy still ok)
    if (-not (Test-Proxy)) {
      Log("node dead, restarting")
      Start-Proxy
    }
  }
  $ok = Test-Proxy
  if ($ok) {
    $tray.Text = "OpenCode Free Proxy :$Port - running"
    $miStatus.Text = "Status: running :$Port"
  } else {
    $tray.Text = "OpenCode Free Proxy :$Port - NOT responding"
    $miStatus.Text = "Status: not responding"
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
# cleanup on loop exit
$timer.Stop()
Stop-Proxy
$tray.Dispose()
