# sync.ps1
# 将本地测试工作目录上传到远程 Linux 编译服务器，执行编译与测试。
# 用法: .\sync.ps1 -LocalPath "D:\work\tests"
# 配置: 同目录 sync_config.yaml（可选），优先级: 命令行参数 > 配置文件 > 默认值
# 日志: $LocalPath\logs\upload.log / compiler.log / run_tests.log

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$LocalPath,

    [Parameter(Mandatory = $false)]
    [string]$RemotePath,

    [Parameter(Mandatory = $false)]
    [string]$RemoteHost,

    [Parameter(Mandatory = $false)]
    [string]$RemoteUser,

    [Parameter(Mandatory = $false)]
    [string]$BuildEnvPath,

    [Parameter(Mandatory = $false)]
    [switch]$PrintConfig
)

$ErrorActionPreference = 'Continue'
$script:AnyFailed = $false
$script:utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ---------- 工具函数 ----------

function Write-Log {
    param([string]$File, [string]$Text)
    if ($null -eq $Text) { $Text = '' }
    [System.IO.File]::AppendAllText($File, $Text + [Environment]::NewLine, $script:utf8NoBom)
}

# 逐行解析 YAML 键值对（不使用 ConvertFrom-Yaml，兼容 PowerShell 5.1）
# 支持 -Path 指定配置文件；不指定时使用 $script:ConfigPath
function Read-YamlValue {
    param([string]$Key, [string]$Path)
    $val = ''
    $targetPath = $script:ConfigPath
    if ($Path) { $targetPath = $Path }
    if ($targetPath -and (Test-Path -LiteralPath $targetPath)) {
        Get-Content -LiteralPath $targetPath -Encoding UTF8 | ForEach-Object {
            if ($_ -match '^\s*' + [regex]::Escape($Key) + '\s*:') {
                $idx = $_.IndexOf(':')
                $v = $_.Substring($idx + 1)
                $hashIdx = $v.IndexOf('#')
                if ($hashIdx -ge 0) { $v = $v.Substring(0, $hashIdx) }
                $v = $v.Trim()
                if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
                    $v = $v.Substring(1, $v.Length - 2)
                }
                $val = $v
            }
        }
    }
    return $val
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$LogFile,
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(Mandatory = $true)][string[]]$NativeArgs
    )
    $disp = @($NativeArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
    $cmdline = $Exe + '  ' + ($disp -join ' ')
    Write-Log $LogFile '=============================================='
    Write-Log $LogFile "阶段: $Title"
    Write-Log $LogFile "命令: $cmdline"
    Write-Log $LogFile ('开始时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    $output = & $Exe @NativeArgs 2>&1
    $rc = $LASTEXITCODE
    $lines = @($output | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() }
        else { [string]$_ }
    })
    Write-Log $LogFile '---- 输出 ----'
    Write-Log $LogFile ($lines -join [Environment]::NewLine)
    Write-Log $LogFile "Exit Code: $rc"
    if ($rc -eq 0) { Write-Log $LogFile 'Status: Completed' }
    else { Write-Log $LogFile "Status: Failed (exit code $rc)"; $script:AnyFailed = $true }
    Write-Log $LogFile '----------------------------------------------'
    return $rc
}

function Invoke-Ssh {
    param([string]$LogFile, [string]$Title, [string]$RemoteCmd)
    $argsList = @($script:sshBaseArgs) + @($script:dest) + @($RemoteCmd)
    return Invoke-Native -LogFile $LogFile -Title $Title -Exe 'ssh' -NativeArgs $argsList
}

function Invoke-Scp {
    param([string]$LogFile, [string]$Title, [string[]]$NativeArgs)
    $argsList = @($script:scpBaseArgs) + $NativeArgs
    return Invoke-Native -LogFile $LogFile -Title $Title -Exe 'scp' -NativeArgs $argsList
}

# ---------- 读取配置（命令行参数 > build-env.yaml > sync_config.yaml > 默认值） ----------

$script:ConfigPath = Join-Path $PSScriptRoot 'sync_config.yaml'

# 解析 build-env.yaml 路径（优先级：-BuildEnvPath 参数 > sync_config.yaml 的 build_env_path 键）
$buildEnvPath = $BuildEnvPath
if (-not $buildEnvPath) { $buildEnvPath = Read-YamlValue 'build_env_path' }
if ($buildEnvPath -and -not [System.IO.Path]::IsPathRooted($buildEnvPath)) {
    $buildEnvPath = Join-Path $PSScriptRoot $buildEnvPath
}

# sync_config.yaml（最低优先级）
$cfgHost = Read-YamlValue 'remote_host'
$cfgUser = Read-YamlValue 'remote_user'
$cfgPort = Read-YamlValue 'remote_port'
$cfgBase = Read-YamlValue 'remote_base_path'
$cfgKey  = Read-YamlValue 'ssh_key'

# build-env.yaml（第二优先级）
$beHost = Read-YamlValue 'remote_host' -Path $buildEnvPath
$beUser = Read-YamlValue 'remote_user' -Path $buildEnvPath
$bePort = Read-YamlValue 'remote_port' -Path $buildEnvPath
$bePath = Read-YamlValue 'remote_path' -Path $buildEnvPath

# 命令行参数（最高优先级）
if (-not $RemoteHost) { $RemoteHost = $beHost }
if (-not $RemoteHost) { $RemoteHost = $cfgHost }
if (-not $RemoteUser) { $RemoteUser = $beUser }
if (-not $RemoteUser) { $RemoteUser = $cfgUser }

$port = $bePort
if (-not $port) { $port = $cfgPort }
if (-not $port) { $port = '22' }

# 远程上传根目录：命令行 -RemotePath > build-env remote_path + /test 专用测试目录 > sync_config remote_base_path > 默认
$remoteDir = $RemotePath
if (-not $remoteDir) {
    if ($bePath) { $remoteDir = ($bePath.TrimEnd('/') + '/test') }
}
if (-not $remoteDir) { $remoteDir = $cfgBase }
if (-not $remoteDir) { $remoteDir = '~/sync_work' }

$sshKey = $cfgKey

# ---------- 配置打印（调试用） ----------
if ($PrintConfig) {
    Write-Host "remote_host: $RemoteHost"
    Write-Host "remote_user: $RemoteUser"
    Write-Host "remote_port: $port"
    Write-Host "remote_dir: $remoteDir"
    Write-Host "ssh_key: $sshKey"
    exit 0
}

# ---------- 前置校验 ----------

if (-not (Test-Path -LiteralPath $LocalPath)) {
    Write-Host "[ERROR] 本地目录不存在: $LocalPath"
    exit 1
}
if (-not $RemoteHost) {
    Write-Host '[ERROR] 未指定远程主机 (上传参数 -RemoteHost 或配置文件 remote_host)'
    exit 1
}

$script:dest = "$RemoteUser@$RemoteHost"
if (-not $RemoteUser) { $script:dest = $RemoteHost }

# ---------- 日志目录与参数 ----------

$logDir = Join-Path $LocalPath 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$uploadLog  = Join-Path $logDir 'upload.log'
$compileLog = Join-Path $logDir 'compiler.log'
$testLog    = Join-Path $logDir 'run_tests.log'

# 非交互模式+连接超时：避免 ssh 因密码/主机指纹提示而挂起，保证日志及时落盘
$script:sshBaseArgs = @('-oBatchMode=yes', '-oConnectTimeout=10', '-p', $port)
if ($sshKey) { $script:sshBaseArgs += '-i'; $script:sshBaseArgs += $sshKey }

$script:scpBaseArgs = @('-r', '-oBatchMode=yes', '-oConnectTimeout=10')
if ($sshKey) { $script:scpBaseArgs += '-i'; $script:scpBaseArgs += $sshKey }
$script:scpBaseArgs += '-P'; $script:scpBaseArgs += $port

# ============ 阶段 1: 上传 ============

Write-Log $uploadLog '=============================================='
Write-Log $uploadLog "SYNC UPLOAD: $LocalPath -> $($script:dest):$remoteDir"
Write-Log $uploadLog ('开始时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Log $uploadLog '=============================================='

$rcClean = Invoke-Ssh -LogFile $uploadLog -Title '清理远程目录' -RemoteCmd "rm -rf $remoteDir"
$rcMkdir = Invoke-Ssh -LogFile $uploadLog -Title '创建远程目录' -RemoteCmd "mkdir -p $remoteDir"

# 使用相对通配路径，避免 Windows 盘符冒号被 scp 误判为远程主机
$prev = Get-Location
Set-Location -LiteralPath $LocalPath
$rcScp = Invoke-Scp -LogFile $uploadLog -Title 'scp 上传文件' -NativeArgs @('./*', ($script:dest + ':' + $remoteDir))
Set-Location -LiteralPath $prev

$rcList  = Invoke-Ssh -LogFile $uploadLog -Title '验证远程文件列表' -RemoteCmd "ls -la $remoteDir"
$rcChmod = Invoke-Ssh -LogFile $uploadLog -Title '设置脚本执行权限' -RemoteCmd "chmod +x $remoteDir/run_tests.sh"

if (($rcClean + $rcMkdir + $rcScp + $rcList + $rcChmod) -eq 0) {
    Write-Log $uploadLog 'UPLOAD 阶段 Status: Completed'
}
else {
    Write-Log $uploadLog 'UPLOAD 阶段 Status: Failed'
    $script:AnyFailed = $true
}

# ============ 阶段 2: 编译 ============

Write-Log $compileLog '=============================================='
Write-Log $compileLog "COMPILER: $($script:dest):$remoteDir"
Write-Log $compileLog ('开始时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Log $compileLog '=============================================='

$rcMake = Invoke-Ssh -LogFile $compileLog -Title '编译 (make clean && make)' -RemoteCmd "cd $remoteDir && make clean && make"

if ($rcMake -eq 0) { Write-Log $compileLog 'COMPILER 阶段 Status: Completed' }
else { Write-Log $compileLog 'COMPILER 阶段 Status: Failed'; $script:AnyFailed = $true }

# ============ 阶段 3: 运行测试 ============

Write-Log $testLog '=============================================='
Write-Log $testLog "RUN TESTS: $($script:dest):$remoteDir"
Write-Log $testLog ('开始时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Log $testLog '=============================================='

$rcTest = Invoke-Ssh -LogFile $testLog -Title '运行测试 (./run_tests.sh)' -RemoteCmd "cd $remoteDir && ./run_tests.sh"

if ($rcTest -eq 0) { Write-Log $testLog 'RUN_TESTS 阶段 Status: Completed' }
else { Write-Log $testLog 'RUN_TESTS 阶段 Status: Failed'; $script:AnyFailed = $true }

# ============ 汇总 ============

Write-Host ''
if ($script:AnyFailed) {
    Write-Host "[FAIL] 同步/编译/测试存在失败，日志目录: $logDir"
    exit 1
}
else {
    Write-Host "[OK] 同步、编译、测试全部完成，日志目录: $logDir"
    exit 0
}