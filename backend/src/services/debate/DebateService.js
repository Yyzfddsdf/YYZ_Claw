import { randomUUID } from "node:crypto";

import { configSchema } from "../../schemas/configSchema.js";
import {
  applyModelProfileToRuntimeConfig,
  resolveModelProfile
} from "../config/modelProfileConfig.js";
import { createOpenAIClient } from "../openai/createOpenAIClient.js";
import { applyThinkingOptions } from "../openai/thinkingOptions.js";

const AGREE_TOOL_NAME = "agree";
const DEFAULT_MAX_ROUNDS = 4;
const MAX_ROUNDS = 20;
const MIN_ROUNDS_BEFORE_AGREE = 1;
const MAX_MATERIAL_CHARS = 600000;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function clipText(value, maxChars) {
  const text = String(value ?? "").trim();
  if (!text || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n...[truncated]`;
}

function createDebateId() {
  return `debate_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function getSideLabel(side) {
  return side === "A" ? "AI A" : "AI B";
}

function getOpponentSide(side) {
  return side === "A" ? "B" : "A";
}

function normalizeMaterials(materials = []) {
  return (Array.isArray(materials) ? materials : [])
    .map((item, index) => ({
      name: normalizeText(item?.name) || `材料 ${index + 1}`,
      content: clipText(
        normalizeText(item?.content ?? item?.extractedText),
        MAX_MATERIAL_CHARS
      )
    }))
    .filter((item) => item.content);
}

function buildMaterialsText({ materialsText, materials }) {
  const directText = clipText(materialsText, MAX_MATERIAL_CHARS);
  if (directText) {
    return directText;
  }

  const normalizedMaterials = normalizeMaterials(materials);
  if (normalizedMaterials.length === 0) {
    return "";
  }

  return clipText(
    normalizedMaterials
      .map((item, index) => [`[Material ${index + 1}: ${item.name}]`, item.content].join("\n"))
      .join("\n\n"),
    MAX_MATERIAL_CHARS
  );
}

function createAgreeToolDefinition() {
  return {
    type: "function",
    function: {
      name: AGREE_TOOL_NAME,
      description:
        "Call this only when you accept the opponent's latest position as strong enough to become the shared final answer.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Brief reason why you accept the opponent's latest position."
          }
        },
        required: ["reason"],
        additionalProperties: false
      }
    }
  };
}

function extractAgreeCall(completion) {
  const message = completion?.choices?.[0]?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  for (const toolCall of toolCalls) {
    if (normalizeText(toolCall?.function?.name) !== AGREE_TOOL_NAME) {
      continue;
    }

    let reason = "";
    try {
      const parsed = JSON.parse(String(toolCall?.function?.arguments ?? "{}"));
      reason = normalizeText(parsed?.reason);
    } catch {
      reason = "";
    }

    return {
      agreed: true,
      reason
    };
  }

  return {
    agreed: false,
    reason: ""
  };
}

function createSystemMessage({ side, topic, description, materialsText }) {
  const opponentSide = getOpponentSide(side);
  return {
    role: "system",
    content: [
      "你正在参与一个双 AI 独立会话互辩流程。",
      `你的身份是 ${getSideLabel(side)}，对方是 ${getSideLabel(opponentSide)}。`,
      "你只和后端转发给你的 user 消息互动，不要假装同时看到另一方的完整隐藏会话。",
      "最终目标是形成共识，得到一个更强、更可靠、可直接给用户使用的最终答案，不是赢得辩论。",
      "你必须认真寻找对方观点中的真实漏洞、遗漏条件、逻辑跳跃或执行风险；如果确实没有关键问题，应承认有效部分并推进共识。",
      "不要一味反驳，不要为了反驳而编造问题，不要攻击稻草人，不要歪曲对方观点。",
      "不调用 agree 时，你的输出应包含：核心分歧/质疑、理由、以及你修正后的更强版本。",
      "调用 agree 表示你认为对方最新观点已经足以作为共同最终答案。",
      "",
      "主题：",
      topic,
      "",
      "描述/要求：",
      description || "通过互相质疑、修正和收敛，形成一个可靠的最终方案或论点。",
      "",
      "解析后的文件/材料文本：",
      materialsText || "(none)"
    ].join("\n")
  };
}

function createOpeningUserMessage() {
  return {
    role: "user",
    content:
      "请先给出你的观点、方案或论证。要求具体、可执行，并尽量给出可被检验的理由。"
  };
}

function createOpponentUserMessage({ opponentSide, content }) {
  return {
    role: "user",
    content: [
      `${getSideLabel(opponentSide)} 的最新观点如下。`,
      "请判断它是否已经足够强，可以作为共同最终答案。",
      "如果可以，请调用 agree；如果不可以，请指出真实问题，不要为反驳而反驳或编造漏洞，并给出你修正后的更强版本。",
      "",
      content
    ].join("\n")
  };
}

function createFinalUserMessage({ agreedBy, acceptedSide, agreementReason }) {
  return {
    role: "user",
    content: [
      `${getSideLabel(agreedBy)} 已经认同了你的最新观点。`,
      agreementReason ? `对方认同理由：${agreementReason}` : "",
      "请作为被认同的一方，给出共同最终总结。最终总结要直接面向用户、完整、可执行；如果这是论点，请给出清晰结论和关键论证。"
    ]
      .filter(Boolean)
      .join("\n")
  };
}

function createMaxRoundsFinalUserMessage() {
  return {
    role: "user",
    content:
      "互辩已达到最大轮数，尚未正式达成同意。请基于你的当前会话给出最佳折中最终总结，并简短指出仍未解决的关键分歧。"
  };
}

function createAssistantMessage(content) {
  return {
    role: "assistant",
    content: normalizeText(content)
  };
}

function getMessagesForSide({ side, messagesA, messagesB }) {
  return side === "A" ? messagesA : messagesB;
}

function setMessagesForSide({ side, messagesA, messagesB, messages }) {
  if (side === "A") {
    return {
      messagesA: messages,
      messagesB
    };
  }

  return {
    messagesA,
    messagesB: messages
  };
}

export class DebateService {
  constructor(options = {}) {
    this.store = options.store ?? null;
    this.configStore = options.configStore ?? null;
    this.runningDebates = new Set();
  }

  ensureReady() {
    if (!this.store || !this.configStore) {
      throw new Error("debate service requires store and configStore");
    }
  }

  async resolveRuntimeConfig() {
    const validation = configSchema.safeParse(await this.configStore.read());
    if (!validation.success) {
      throw new Error("config/config.json is invalid. Save model/baseURL/apiKey first.");
    }

    return applyModelProfileToRuntimeConfig(
      validation.data,
      resolveModelProfile(validation.data, "", "main")
    );
  }

  async runConversationTurn({ client, runtimeConfig, messages, allowAgree }) {
    const completion = await client.chat.completions.create(applyThinkingOptions({
      model: runtimeConfig.model,
      temperature: 0.3,
      tools: allowAgree ? [createAgreeToolDefinition()] : undefined,
      messages
    }, runtimeConfig));

    const content = normalizeText(completion?.choices?.[0]?.message?.content);
    const agree = allowAgree ? extractAgreeCall(completion) : { agreed: false, reason: "" };

    return {
      content,
      ...agree
    };
  }

  async runFinalTurn({ client, runtimeConfig, messages }) {
    const completion = await client.chat.completions.create(applyThinkingOptions({
      model: runtimeConfig.model,
      temperature: 0.2,
      messages
    }, runtimeConfig));

    return normalizeText(completion?.choices?.[0]?.message?.content);
  }

  async createAndRunDebate(input = {}) {
    this.ensureReady();
    await this.resolveRuntimeConfig();

    const now = Date.now();
    const id = createDebateId();
    const topic = normalizeText(input.topic);
    const description = normalizeText(input.description ?? input.objective);
    const materials = normalizeMaterials(input.materials);
    const materialsText = buildMaterialsText({
      materialsText: input.materialsText,
      materials
    });
    const maxRounds = Math.max(1, Math.min(Number(input.maxRounds ?? DEFAULT_MAX_ROUNDS), MAX_ROUNDS));
    const title = normalizeText(input.title) || clipText(topic, 80);
    const messagesA = [
      createSystemMessage({ side: "A", topic, description, materialsText }),
      createOpeningUserMessage()
    ];
    const messagesB = [
      createSystemMessage({ side: "B", topic, description, materialsText })
    ];

    const debate = this.store.createDebate({
      id,
      title,
      topic,
      objective: description,
      materials,
      materialsText,
      messagesA,
      messagesB,
      maxRounds,
      status: "running",
      createdAt: now
    });

    this.startBackgroundDebate(id);
    return debate;
  }

  startBackgroundDebate(id) {
    const debateId = normalizeText(id);
    if (!debateId || this.runningDebates.has(debateId)) {
      return;
    }

    this.runningDebates.add(debateId);
    void this.runDebateById(debateId)
      .catch((error) => {
        this.store.updateDebate(debateId, {
          status: "error",
          error: error?.message || "debate failed"
        });
      })
      .finally(() => {
        this.runningDebates.delete(debateId);
      });
  }

  saveDebateProgress(id, patch) {
    const debate = this.store.updateDebate(id, patch);
    if (!debate) {
      throw new Error("debate no longer exists");
    }
    return debate;
  }

  async runDebateById(id) {
    this.ensureReady();
    const debate = this.store.getDebate(id);
    if (!debate) {
      return null;
    }

    const turns = [];
    let messagesA = Array.isArray(debate.messagesA) ? [...debate.messagesA] : [];
    let messagesB = Array.isArray(debate.messagesB) ? [...debate.messagesB] : [];
    let lastSide = "";
    let lastContent = "";
    let agreedBy = "";
    let acceptedSide = "";
    let agreementReason = "";

    try {
      const runtimeConfig = await this.resolveRuntimeConfig();
      const client = createOpenAIClient(runtimeConfig);
      const maxRounds = Math.max(1, Math.min(Number(debate.maxRounds ?? DEFAULT_MAX_ROUNDS), MAX_ROUNDS));

      for (let turnIndex = 0; turnIndex < maxRounds * 2 && !agreedBy; turnIndex += 1) {
        const side = turnIndex % 2 === 0 ? "A" : "B";
        const opponentSide = getOpponentSide(side);
        const round = Math.floor(turnIndex / 2) + 1;
        let messages = [...getMessagesForSide({ side, messagesA, messagesB })];

        if (side !== "A" || turnIndex > 0) {
          messages = [
            ...messages,
            createOpponentUserMessage({
              opponentSide,
              content: lastContent
            })
          ];
        }

        const result = await this.runConversationTurn({
          client,
          runtimeConfig,
          messages,
          allowAgree: Boolean(lastContent) && round > MIN_ROUNDS_BEFORE_AGREE
        });

        if (result.agreed) {
          agreedBy = side;
          acceptedSide = opponentSide;
          agreementReason = result.reason;
          messages = [
            ...messages,
            createAssistantMessage(result.content || result.reason || `${getSideLabel(side)} accepted.`)
          ];
          ({ messagesA, messagesB } = setMessagesForSide({
            side,
            messagesA,
            messagesB,
            messages
          }));
          turns.push({
            id: `turn_${turns.length + 1}`,
            side,
            type: "agreement",
            round,
            content: result.content || result.reason || `${getSideLabel(side)} accepted.`,
            agreementReason,
            acceptedSide,
            createdAt: Date.now()
          });
          this.saveDebateProgress(id, {
            status: "finalizing",
            agreedBy,
            acceptedSide,
            turns,
            messagesA,
            messagesB
          });
          break;
        }

        const content = result.content || "(empty response)";
        messages = [...messages, createAssistantMessage(content)];
        ({ messagesA, messagesB } = setMessagesForSide({
          side,
          messagesA,
          messagesB,
          messages
        }));
        lastSide = side;
        lastContent = content;
        turns.push({
          id: `turn_${turns.length + 1}`,
          side,
          type: "argument",
          round,
          content,
          createdAt: Date.now()
        });
        this.saveDebateProgress(id, {
          status: "running",
          turns,
          messagesA,
          messagesB
        });
      }

      const finalSide = acceptedSide || lastSide || "A";
      let finalMessages = [...getMessagesForSide({ side: finalSide, messagesA, messagesB })];
      finalMessages = [
        ...finalMessages,
        acceptedSide
          ? createFinalUserMessage({ agreedBy, acceptedSide, agreementReason })
          : createMaxRoundsFinalUserMessage()
      ];
      ({ messagesA, messagesB } = setMessagesForSide({
        side: finalSide,
        messagesA,
        messagesB,
        messages: finalMessages
      }));
      this.saveDebateProgress(id, {
        status: "finalizing",
        agreedBy,
        acceptedSide,
        finalSide,
        turns,
        messagesA,
        messagesB
      });

      const finalSummary = await this.runFinalTurn({
        client,
        runtimeConfig,
        messages: finalMessages
      });
      finalMessages = [...finalMessages, createAssistantMessage(finalSummary)];
      ({ messagesA, messagesB } = setMessagesForSide({
        side: finalSide,
        messagesA,
        messagesB,
        messages: finalMessages
      }));
      turns.push({
        id: `turn_${turns.length + 1}`,
        side: finalSide,
        type: "final",
        round: maxRounds,
        content: finalSummary,
        createdAt: Date.now()
      });

      return this.store.updateDebate(id, {
        status: "completed",
        agreedBy,
        acceptedSide,
        finalSide,
        finalSummary,
        turns,
        messagesA,
        messagesB
      });
    } catch (error) {
      return this.store.updateDebate(id, {
        status: "error",
        error: error?.message || "debate failed",
        turns,
        messagesA,
        messagesB
      });
    }
  }
}
