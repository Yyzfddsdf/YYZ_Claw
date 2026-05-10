[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$raw = [Console]::In.ReadToEnd()
$payload = if ([string]::IsNullOrWhiteSpace($raw)) { @{} } else { $raw | ConvertFrom-Json }
$response = [string]$payload.tool_response
$additionalContext = ""

if ($response -match "(not recognized as an internal or external command|command not found|ENOENT|Cannot find path|No such file or directory|Permission denied|Access is denied)") {
  $additionalContext = "The previous shell command failed because the executable, path, or permission setup was invalid. Inspect the environment or path first instead of retrying the same command unchanged."
}

@{
  continue = $true
  stopReason = $null
  systemMessage = $null
  suppressOutput = $false
  hookSpecificOutput = @{
    hookEventName = "PostToolUse"
    decision = $null
    reason = ""
    additionalContext = $additionalContext
  }
} | ConvertTo-Json -Depth 8 -Compress
