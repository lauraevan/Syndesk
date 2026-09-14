$ErrorActionPreference = "Stop"
$project = Join-Path $PSScriptRoot "..\\input-helper\\Syndesk.InputHost.csproj"
$output = Join-Path $PSScriptRoot "..\\input-helper\\bin\\publish"
dotnet publish $project -c Release -r win-x64 --self-contained true -o $output
