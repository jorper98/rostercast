# package-for-deploy.ps1
# Orchestrates a new release by tagging the repository.
# Pushing the tag triggers a GitHub Action to build and publish the Docker image.

param (
    [string]$NewVersion,
    [switch]$Force
)

$SourcePath = Get-Location
$PackageJsonPath = Join-Path $SourcePath "package.json"

# 1. Ensure working directory is clean
$GitStatus = git status --porcelain
if ($GitStatus) {
    Write-Host "ERROR: Working directory is not clean. Please commit or stash changes first." -ForegroundColor Red
    exit 1
}

# 2. Determine version
if (-not $NewVersion) {
    $PackageJson = Get-Content -Path $PackageJsonPath -Raw | ConvertFrom-Json
    $NewVersion = $PackageJson.version
    Write-Host "No version specified. Using current version from package.json: v$NewVersion" -ForegroundColor Yellow
} else {
    # Update package.json with the new version
    $PackageJson = Get-Content -Path $PackageJsonPath -Raw | ConvertFrom-Json
    $PackageJson.version = $NewVersion
    $PackageJson | ConvertTo-Json -Depth 100 | Set-Content -Path $PackageJsonPath
    Write-Host "Updated package.json to version v$NewVersion" -ForegroundColor Cyan
    
    # Commit the version bump
    git add $PackageJsonPath
    git commit -m "v${NewVersion}: bump version to v$NewVersion"
}

$ReleaseTag = "v$NewVersion"

# 3. Check if tag already exists
$ExistingTag = git tag -l $ReleaseTag
if ($ExistingTag -and -not $Force) {
    Write-Host "ERROR: Tag '$ReleaseTag' already exists. Use -Force to overwrite." -ForegroundColor Red
    exit 1
}

if ($ExistingTag -and $Force) {
    Write-Host "Tag '$ReleaseTag' exists. Force-overwriting..." -ForegroundColor Yellow
    git tag -d $ReleaseTag
    git push origin :refs/tags/$ReleaseTag 2>$null
}

# 4. Create and push the tag
Write-Host "Creating release tag: $ReleaseTag" -ForegroundColor Cyan
git tag -a $ReleaseTag -m "Release $ReleaseTag"

Write-Host "Pushing commit and tag to GitHub..." -ForegroundColor Cyan
git push origin HEAD
git push origin $ReleaseTag

Write-Host "==================================================" -ForegroundColor Green
Write-Host "  ROSTERCAST RELEASE TRIGGERED!" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host "The GitHub Actions workflow is now building and"
Write-Host "publishing the Docker image for $ReleaseTag."
Write-Host ""
Write-Host "Image: ghcr.io/jorper98/rostercast:$NewVersion"
Write-Host "Check progress at: https://github.com/jorper98/rostercast/actions"
Write-Host "==================================================" -ForegroundColor Green
