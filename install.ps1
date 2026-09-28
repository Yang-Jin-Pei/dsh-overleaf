<#
.SYNOPSIS
    Wire dsh-plugin-overleaf into a DSH profile on this machine.

.DESCRIPTION
    Installing this plugin is four things, and a `git clone` delivers only the
    first:

      1. the source                       -> this directory (the clone)
      2. the profile's dependency entry   -> profiles\<profile>\package.json
      3. the profile's bundle selection   -> package.json, dsh.profile.bundles
      4. two node_modules links:
           a. profiles\<profile>\node_modules\dsh-plugin-overleaf -> this directory
           b. this directory's node_modules\@deepseek-ai\* -> the DSH packages

    (b) is the one everybody forgets. The profile installs this package as a
    link, so Node resolves the *real* path here and walks up from here for
    node_modules; it never looks at profiles\<profile>\node_modules, where
    @deepseek-ai lives. Without (b) the plugin dies at import with
    ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery. See README.md,
    "The node_modules junction".

    This script does 2-4 and then runs test-register.mjs to prove the package
    actually loads. It never touches the Overleaf session cookie: that is a
    secret in the harness credential store, and it is re-established on the new
    machine with ovl_login.

.PARAMETER DshHome
    DSH home directory. Defaults to $env:DSH_HOME, else %USERPROFILE%\.dsh.

.PARAMETER Profile
    Profile name. Defaults to $env:DSH_PROFILE, else 'desktop' when that profile
    exists, else the single profile that has a package.json.

.PARAMETER PluginDir
    This package's directory. Defaults to the directory holding this script.

.PARAMETER LinkOnly
    Only fix this package's own node_modules\@deepseek-ai\* junctions. Do not
    touch the profile manifest or the profile's link. Use this when the profile
    will be wired through the Web sidebar's Plugins page instead, which is the
    supported path for the desktop profile (the `dsh plugin` CLI refuses it:
    'profile "desktop" is managed exclusively by the Electron application').

.PARAMETER Sync
    Also run pnpm install in the profile, to refresh pnpm-lock.yaml. Off by
    default: the link this script creates is enough to load the plugin, and
    pnpm is only needed to keep the lockfile tidy.

.PARAMETER SkipVerify
    Do not run test-register.mjs at the end.

.EXAMPLE
    pwsh -File install.ps1

.EXAMPLE
    # Plugins-page route: fix resolution here, install the bundle from the UI.
    pwsh -File install.ps1 -LinkOnly
#>
[CmdletBinding()]
param(
    [string] $DshHome,
    [string] $Profile,
    [string] $PluginDir = $PSScriptRoot,
    [switch] $LinkOnly,
    [switch] $Sync,
    [switch] $SkipVerify
)

$ErrorActionPreference = 'Stop'

$PACKAGE_NAME = 'dsh-plugin-overleaf'

# What this package imports from @deepseek-ai, plus the two packages its JSDoc
# names. Anything already absent from the machine is skipped with a warning.
$PEER_PACKAGES = @('schemastery', 'dsh-tools', 'dsh-credentials', 'dsh-agent', 'dsh-session')

function Step { param([string] $Text) Write-Host "`n== $Text" -ForegroundColor White }
function Ok   { param([string] $Text) Write-Host "   ok    $Text" -ForegroundColor Green }
function Did  { param([string] $Text) Write-Host "   done  $Text" -ForegroundColor Cyan }
function Note { param([string] $Text) Write-Host "   note  $Text" -ForegroundColor DarkGray }
function Warn { param([string] $Text) Write-Host "   warn  $Text" -ForegroundColor Yellow }
function Fail {
    param([string] $Text)
    Write-Host "`n   FAIL  $Text" -ForegroundColor Red
    exit 1
}

function Read-Json {
    param([string] $Path)
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Write-Json {
    param([string] $Path, $Value)
    $json = ($Value | ConvertTo-Json -Depth 32) + "`n"
    # UTF-8 without BOM, whichever PowerShell is running this.
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# A link is "already correct" when the package it resolves to has the expected
# name. This works for a junction and for a plain copy, and needs no PowerShell
# 6+ link APIs.
function Test-ResolvesToPackage {
    param([string] $Path, [string] $ExpectedName)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $manifest = Read-Json (Join-Path $Path 'package.json')
        return ($manifest.name -eq $ExpectedName)
    } catch {
        return $false
    }
}

function Remove-Link {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    # cmd's rmdir unlinks the reparse point itself; Remove-Item -Recurse would
    # walk into the target's contents on Windows PowerShell.
    & cmd.exe /c rmdir "$Path" 2>&1 | Out-Null
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

function New-Junction {
    param([string] $Path, [string] $Target)
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    if (Test-Path -LiteralPath $Path) { Remove-Link -Path $Path }
    New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
}

function Get-LinkTarget {
    param([string] $Path)
    try { return @((Get-Item -LiteralPath $Path -Force).Target)[0] } catch { return $null }
}

function Find-DshRuntime {
    $candidates = @()
    if ($env:DSH_DESKTOP_NODE_EXECUTABLE) {
        $dir = Split-Path -Parent $env:DSH_DESKTOP_NODE_EXECUTABLE
        for ($i = 0; $i -lt 7 -and $dir; $i++) {
            $candidates += (Join-Path $dir 'resources\runtime')
            $candidates += $dir
            $dir = Split-Path -Parent $dir
        }
    }
    foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $base) { continue }
        $candidates += (Join-Path $base 'Programs\DeepSeek Harness\resources\runtime')
        $candidates += (Join-Path $base 'DeepSeek Harness\resources\runtime')
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'pnpm\bin\pnpm.cjs'))) { return $candidate }
    }
    return $null
}

function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    if ($env:DSH_DESKTOP_NODE_EXECUTABLE -and (Test-Path -LiteralPath $env:DSH_DESKTOP_NODE_EXECUTABLE)) {
        return $env:DSH_DESKTOP_NODE_EXECUTABLE
    }
    $runtime = Find-DshRuntime
    if ($runtime) {
        $bundled = Join-Path $runtime 'primary-runtime\dependencies\node\bin\node.exe'
        if (Test-Path -LiteralPath $bundled) { return $bundled }
    }
    return $null
}

# ---------------------------------------------------------------- 1. locate DSH

Step 'Locating DSH'

if (-not $DshHome) {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $USERPROFILE '.dsh' }
}
if (-not (Test-Path -LiteralPath $DshHome)) {
    Fail "DSH home not found: $DshHome. Start the DSH app once, then run this again (or pass -DshHome)."
}
$DshHome = (Resolve-Path -LiteralPath $DshHome).Path
Ok "DSH home : $DshHome"

$profilesDir = Join-Path $DshHome 'profiles'
if (-not (Test-Path -LiteralPath $profilesDir)) { Fail "No profiles directory under $DshHome. Is DSH installed for this user?" }

if (-not $Profile) {
    if ($env:DSH_PROFILE) {
        $Profile = $env:DSH_PROFILE
    } elseif (Test-Path -LiteralPath (Join-Path $profilesDir 'desktop\package.json')) {
        $Profile = 'desktop'
    } else {
        $withManifest = @(Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') })
        if ($withManifest.Count -eq 1) { $Profile = $withManifest[0].Name }
        elseif ($withManifest.Count -eq 0) { Fail "No profile has a package.json under $profilesDir." }
        else { Fail "Several profiles have a package.json ($($withManifest.Name -join ', ')); pass -Profile." }
    }
}

$profileDir = Join-Path $profilesDir $Profile
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    Fail "Profile '$Profile' has no package.json ($manifestPath). Launch DSH once so the profile is created, or pass -Profile."
}
Ok "profile  : $Profile"

if (-not $PluginDir) { $PluginDir = (Get-Location).Path }
$PluginDir = (Resolve-Path -LiteralPath $PluginDir).Path
if (-not (Test-ResolvesToPackage -Path $PluginDir -ExpectedName $PACKAGE_NAME)) {
    Fail "$PluginDir is not the $PACKAGE_NAME package (its package.json is missing or names something else)."
}
Ok "package  : $PluginDir"

# ------------------------------------------- 2. the resolution fix that is missed

Step 'Fixing module resolution for this package'

$sourceRoots = @(
    @(
        (Join-Path $profilesDir 'node_modules\@deepseek-ai'),
        (Join-Path $profileDir 'node_modules\@deepseek-ai')
    ) | Where-Object { Test-Path -LiteralPath $_ }
)

if ($sourceRoots.Count -eq 0) {
    Fail "No @deepseek-ai packages under $profilesDir\node_modules or $profileDir\node_modules. The DSH profile looks incomplete - let DSH finish its first start, then retry."
}
$sourceRoot = $sourceRoots[0]
Note "DSH packages from: $sourceRoot"

$linkRoot = Join-Path $PluginDir 'node_modules\@deepseek-ai'
foreach ($peer in $PEER_PACKAGES) {
    $target = Join-Path $sourceRoot $peer
    if (-not (Test-Path -LiteralPath $target)) {
        Warn "@deepseek-ai/$peer is not installed on this machine - skipped"
        continue
    }
    $link = Join-Path $linkRoot $peer
    if ((Test-ResolvesToPackage -Path $link -ExpectedName "@deepseek-ai/$peer") -and
        ((Get-LinkTarget -Path $link) -eq $null -or ((Get-LinkTarget -Path $link).TrimEnd('\') -eq $target.TrimEnd('\')))) {
        Ok "@deepseek-ai/$peer already resolves"
        continue
    }
    New-Junction -Path $link -Target $target
    Did "@deepseek-ai/$peer -> $target"
}

# ------------------------------------------------------- 3. wire up the profile

if ($LinkOnly) {
    Step 'Skipping the profile manifest (-LinkOnly)'
    Note 'Install the bundle from the Web sidebar Plugins page with this spec:'
    Note ('link:' + ($PluginDir -replace '\\', '/'))
} else {
    Step 'Registering the bundle in the profile'

    $pkg = Read-Json $manifestPath
    $spec = 'link:' + ($PluginDir -replace '\\', '/')
    $changed = $false

    if (-not $pkg.PSObject.Properties['dependencies']) {
        $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
        $changed = $true
    }
    $current = $pkg.dependencies.PSObject.Properties[$PACKAGE_NAME]
    if (-not $current) {
        $pkg.dependencies | Add-Member -NotePropertyName $PACKAGE_NAME -NotePropertyValue $spec
        $changed = $true
        Did "dependencies.$PACKAGE_NAME = $spec"
    } elseif ($current.Value -ne $spec) {
        $pkg.dependencies.PSObject.Properties.Remove($PACKAGE_NAME)
        $pkg.dependencies | Add-Member -NotePropertyName $PACKAGE_NAME -NotePropertyValue $spec
        $changed = $true
        Did "dependencies.$PACKAGE_NAME = $spec  (was $($current.Value))"
    } else {
        Ok "dependencies.$PACKAGE_NAME already set"
    }

    if (-not $pkg.PSObject.Properties['dsh']) {
        $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } })
        $changed = $true
    }
    if (-not $pkg.dsh.PSObject.Properties['profile']) {
        $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{ bundles = @() })
        $changed = $true
    }
    $bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ })
    if ($bundles -notcontains $PACKAGE_NAME) {
        $bundles += $PACKAGE_NAME
        $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
        $changed = $true
        Did "dsh.profile.bundles += $PACKAGE_NAME"
    } else {
        Ok "dsh.profile.bundles already selects $PACKAGE_NAME"
    }

    if ($changed) {
        $backup = "$manifestPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item -LiteralPath $manifestPath -Destination $backup -Force
        Write-Json -Path $manifestPath -Value $pkg
        Did "wrote $manifestPath"
        Note "backup kept at $backup"
    }

    $profileModules = Join-Path $profileDir 'node_modules'
    if (Test-Path -LiteralPath $profileModules) {
        $profileLink = Join-Path $profileModules $PACKAGE_NAME
        $linkTarget = Get-LinkTarget -Path $profileLink
        $wrongTarget = $linkTarget -and ($linkTarget.TrimEnd('\') -ne $PluginDir.TrimEnd('\'))
        if ((Test-ResolvesToPackage -Path $profileLink -ExpectedName $PACKAGE_NAME) -and -not $wrongTarget) {
            Ok "profile link already resolves"
        } else {
            if ($wrongTarget) { Note "replacing link that pointed at $linkTarget" }
            New-Junction -Path $profileLink -Target $PluginDir
            Did "$profileLink -> $PluginDir"
        }
    } else {
        Warn "profile node_modules is missing - not creating the link by hand."
        Note "Use the Web sidebar Plugins page with spec: $spec"
    }
}

# ------------------------------------------------------------- 4. optional pnpm

if ($Sync) {
    Step 'Refreshing the profile lockfile (pnpm install)'
    $node = Find-Node
    $runtime = Find-DshRuntime
    $pnpmCjs = if ($runtime) { Join-Path $runtime 'pnpm\bin\pnpm.cjs' } else { $null }
    $command = $null
    $prefix = @()
    if ($pnpmCjs -and (Test-Path -LiteralPath $pnpmCjs) -and $node) {
        $command = $node
        $prefix = @($pnpmCjs)
        Note "using the pnpm bundled with DSH ($pnpmCjs)"
    } elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
        $command = (Get-Command pnpm).Source
        Note "using pnpm from PATH: $command"
    } else {
        Warn 'no pnpm found (neither bundled nor on PATH) - skipped'
    }
    if ($command) {
        Push-Location $profileDir
        try { & $command @prefix install }
        finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) {
            Warn "pnpm install exited with $LASTEXITCODE - the link this script created still loads the plugin, but check the output above."
        } else {
            Ok 'pnpm install finished'
        }
    }
}

# ---------------------------------------------------------------- 5. verify it

if (-not $SkipVerify) {
    Step 'Verifying the package loads'
    $node = Find-Node
    if (-not $node) {
        Warn 'node was not found - skipped the smoke test'
    } else {
        Note "node: $node"
        Push-Location $PluginDir
        try { & $node 'test-register.mjs' }
        finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) {
            Fail "test-register.mjs failed (exit $LASTEXITCODE). The package cannot register; fix the error above before restarting DSH."
        }
        Ok 'test-register.mjs passed - apply() registers cleanly'
    }
}

# ------------------------------------------------------------------- 6. handoff

Step 'Next steps'
Write-Host @"
   1. Restart DSH. A newly added bundle is only picked up at startup; a live
      patch reload does not cover it.
   2. The Overleaf cookie is NOT part of this install. Log in to
      https://latex.cstcloud.cn/ in a browser, open DevTools -> Network, click
      any request to the instance and copy the whole Cookie request header
      (it must contain overleaf.sid - latex-session alone returns 401).
   3. Give that value to the agent: ovl_login. Then ovl_status should answer
      "Overleaf session is live", and the Overleaf entry appears in the sidebar.
"@ -ForegroundColor Gray
