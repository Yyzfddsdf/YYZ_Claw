[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$raw = [Console]::In.ReadToEnd()
$payload = if ([string]::IsNullOrWhiteSpace($raw)) { @{} } else { $raw | ConvertFrom-Json }
$command = ([string]$payload.tool_input.command).Trim()
$behavior = $null
$message = ""

if (-not [string]::IsNullOrWhiteSpace($command)) {
  $safePatterns = @(
    "^git\s+(status|diff|log|show|rev-parse|branch(\s+--show-current)?|remote\s+-v)\b",
    "^(ls|pwd|echo|whoami)\b",
    "^dir\b",
    "^(Get-ChildItem|Get-Location|Get-Content|Select-String|rg|cat|type)\b"
  )

  foreach ($pattern in $safePatterns) {
    if ($command -match $pattern) {
      $behavior = "allow"
      $message = "Auto-approved a read-only shell inspection command."
      break
    }
  }
}

@{
  continue = $true
  stopReason = $null
  systemMessage = if ($behavior -eq "allow") { "Global approval hook auto-approved a read-only command." } else { $null }
  suppressOutput = $false
  hookSpecificOutput = @{
    hookEventName = "PermissionRequest"
    decision = @{
      behavior = $behavior
      message = $message
    }
  }
} | ConvertTo-Json -Depth 8 -Compress
