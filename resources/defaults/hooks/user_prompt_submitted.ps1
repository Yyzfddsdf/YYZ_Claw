[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$raw = [Console]::In.ReadToEnd()
$payload = if ([string]::IsNullOrWhiteSpace($raw)) { @{} } else { $raw | ConvertFrom-Json }
$prompt = [string]$payload.prompt
$additionalContext = ""
$promptLower = $prompt.ToLowerInvariant()
$isReviewPrompt = $false
if (
  $promptLower.Contains("review this") -or
  $promptLower.Contains("code review") -or
  $promptLower.Contains(" review ")
) {
  $isReviewPrompt = $true
}

if ($promptLower -match "(exception|traceback|stack trace|failed|failure|enoent|not found|permission denied|access is denied|cannot find|error)") {
  $additionalContext = "The user likely supplied an error report. Prioritize locating the exact failing file, line, command, or stack trace before changing code."
} elseif ($isReviewPrompt) {
  $additionalContext = "Treat this as a review-style request. Prioritize bugs, regressions, risky behavior changes, and missing tests before summaries."
}

@{
  continue = $true
  stopReason = $null
  systemMessage = $null
  suppressOutput = $false
  hookSpecificOutput = @{
    hookEventName = "UserPromptSubmitted"
    additionalContext = $additionalContext
  }
} | ConvertTo-Json -Depth 8 -Compress
