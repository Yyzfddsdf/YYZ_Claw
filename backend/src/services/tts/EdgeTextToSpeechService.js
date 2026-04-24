import { Communicate } from "edge-tts-universal";

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export class EdgeTextToSpeechService {
  constructor(options = {}) {
    this.defaultVoice = String(options.defaultVoice ?? "zh-CN-XiaoxiaoNeural").trim();
    this.defaultRate = String(options.defaultRate ?? "+0%").trim();
    this.defaultVolume = String(options.defaultVolume ?? "+0%").trim();
    this.defaultPitch = String(options.defaultPitch ?? "+0Hz").trim();
    this.connectionTimeoutMs = Number(options.connectionTimeoutMs ?? 20000);
  }

  async *streamSynthesize(options = {}) {
    const text = normalizeText(options.text);
    if (!text) {
      throw new Error("text is required");
    }

    const voice = String(options.voice ?? "").trim() || this.defaultVoice;
    const rate = String(options.rate ?? "").trim() || this.defaultRate;
    const volume = String(options.volume ?? "").trim() || this.defaultVolume;
    const pitch = String(options.pitch ?? "").trim() || this.defaultPitch;

    const communicate = new Communicate(text, {
      voice,
      rate,
      volume,
      pitch,
      connectionTimeout: Number.isFinite(this.connectionTimeoutMs) ? this.connectionTimeoutMs : 20000
    });

    for await (const chunk of communicate.stream()) {
      if (chunk?.type !== "audio" || !chunk.data) {
        continue;
      }
      yield chunk.data;
    }
  }
}

