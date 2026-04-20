import {
  clipText,
  ensureDirectory,
  normalizePositiveInteger,
  resolveContextWorkingDirectory,
  runShellCommand
} from "../../tools/privateToolShared.js";

function normalizeCommands(value) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
    : [];
}

export default {
  name: "builder_run_verification_pack",
  description:
    "Run a batch of verification commands with structured pass/fail summary for implementation validation.",
  parameters: {
    type: "object",
    properties: {
      commands: {
        type: "array",
        items: {
          type: "string"
        },
        description: "Verification command list to execute sequentially."
      },
      cwd: {
        type: "string",
        description: "Optional absolute workspace path."
      },
      timeoutMsPerCommand: {
        type: "integer",
        description: "Timeout per command (1000-300000).",
        default: 60000
      },
      continueOnFailure: {
        type: "boolean",
        description: "Continue running remaining commands even if one fails.",
        default: false
      },
      maxOutputChars: {
        type: "integer",
        description: "Max stdout/stderr chars captured per command.",
        default: 3000
      }
    },
    required: ["commands"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const commands = normalizeCommands(args.commands);
    if (commands.length === 0) {
      throw new Error("commands must include at least one non-empty command");
    }

    const cwd = resolveContextWorkingDirectory(executionContext, args.cwd);
    await ensureDirectory(cwd);

    const timeoutMsPerCommand = normalizePositiveInteger(args.timeoutMsPerCommand, 60000, 1000, 300000);
    const continueOnFailure = Boolean(args.continueOnFailure);
    const maxOutputChars = normalizePositiveInteger(args.maxOutputChars, 3000, 500, 12000);

    const commandResults = [];
    let stoppedEarly = false;

    for (const command of commands) {
      const result = await runShellCommand({
        command,
        cwd,
        timeoutMs: timeoutMsPerCommand,
        maxOutputChars: Math.max(maxOutputChars, 1500)
      });

      commandResults.push({
        command,
        ok: result.ok,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdout: clipText(result.stdout, maxOutputChars),
        stderr: clipText(result.stderr, maxOutputChars)
      });

      if (!result.ok && !continueOnFailure) {
        stoppedEarly = true;
        break;
      }
    }

    const passedCount = commandResults.filter((item) => item.ok).length;
    const failedCount = commandResults.length - passedCount;
    const timedOutCount = commandResults.filter((item) => item.timedOut).length;

    return {
      cwd,
      summary: {
        totalPlanned: commands.length,
        executed: commandResults.length,
        passedCount,
        failedCount,
        timedOutCount,
        allPassed: failedCount === 0 && commandResults.length === commands.length,
        stoppedEarly
      },
      commandResults
    };
  }
};
