[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$raw = [Console]::In.ReadToEnd()
$payload = if ([string]::IsNullOrWhiteSpace($raw)) { @{} } else { $raw | ConvertFrom-Json }
$toolName = [string]$payload.tool_name
$command = [string]$payload.tool_input.command
$deny = $false
$reason = ""

if (($toolName -eq "Bash" -or $toolName -eq "PowerShell") -and -not [string]::IsNullOrWhiteSpace($command)) {
  $patterns = @(
    "(^|\s)rm\s+-rf(\s|$)",
    "Remove-Item\b.*-Recurse\b.*-Force\b",
    "(^|\s)del(\.exe)?\b.*(/f|/s|/q)",
    "git\s+reset\s+--hard",
    "git\s+clean\s+-f",
    "(^|\s)format\s+[a-zA-Z]:",
    "(^|\s)shutdown\b",
    "(^|\s)reboot\b",
    "(^|\s)mkfs\b",
    "(^|\s)diskpart\b"
  )

  foreach ($pattern in $patterns) {
    if ($command -match $pattern) {
      $deny = $true
      break
    }
  }

  if ($deny) {
    $reason = "Blocked a high-risk destructive shell command. Inspect the request and choose a safer alternative."
  }
}

@{
  continue = $true
  stopReason = $null
  systemMessage = if ($deny) { "Global safety hook blocked a destructive command." } else { $null }
  suppressOutput = $false
  hookSpecificOutput = @{
    hookEventName = "PreToolUse"
    permissionDecision = if ($deny) { "deny" } else { $null }
    permissionDecisionReason = $reason
  }
} | ConvertTo-Json -Depth 8 -Compress
