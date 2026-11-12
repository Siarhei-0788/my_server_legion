param(
    [string]$Out = "legion-server.tar.gz"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path (Get-Location) $Out

if (Test-Path $target) { Remove-Item $target -Force }
tar -czf $target --exclude=node_modules --exclude=data --exclude=.git --exclude=.github -C $root .
if (-not (Test-Path $target)) { throw "Archive was not created" }

$size = [math]::Round((Get-Item $target).Length / 1KB, 1)
Write-Host "Archive: $target ($size KB)"
Write-Host ""
Write-Host "Next steps (replace SERVER_IP):"
Write-Host "  scp <archive> root@SERVER_IP:/root/"
Write-Host "  ssh root@SERVER_IP (extract to /root/legion and run deploy/install.sh)"
