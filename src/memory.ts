import OpenAI from "openai";

type MessageContent =
  | string
  | Array<{ type: string; [key: string]: unknown }>;

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: MessageContent;
};

const SUMMARIZE_THRESHOLD = 50; // trigger when history hits this
const KEEP_RECENT = 20; // keep this many recent messages after compression

export class MemoryManager {
  private history = new Map<string, ChatMessage[]>();
  private summaries = new Map<string, string>();

  constructor(private ai: OpenAI, private model: string) {}

  getMessages(channelId: string): ChatMessage[] {
    if (!this.history.has(channelId)) this.history.set(channelId, []);
    return this.history.get(channelId)!;
  }

  getSummary(channelId: string): string | null {
    return this.summaries.get(channelId) ?? null;
  }

  clearHistory(channelId: string): void {
    this.history.delete(channelId);
    this.summaries.delete(channelId);
  }

  async maybeCompress(channelId: string): Promise<void> {
    const messages = this.getMessages(channelId);
    if (messages.length < SUMMARIZE_THRESHOLD) return;

    // Take the older half, keep only KEEP_RECENT most recent
    const cutoff = messages.length - KEEP_RECENT;
    const toSummarize = messages.splice(0, cutoff);

    // Extract text-only content for summarization
    const lines = toSummarize
      .map((m) => {
        const text =
          typeof m.content === "string"
            ? m.content
            : (m.content as Array<{ type: string; text?: string }>)
                .filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join(" ");
        return `${m.role}: ${text}`;
      })
      .join("\n");

    const prevSummary = this.summaries.get(channelId);
    const prompt = prevSummary
      ? `Previous summary:\n${prevSummary}\n\nNew conversation:\n${lines}\n\nUpdate the summary to include the new messages. Be concise. Use the same language as the conversation (Thai or English).`
      : `Summarize this conversation concisely. Keep important context, names, and topics. Use the same language as the conversation (Thai or English):\n\n${lines}`;

    try {
      const response = await this.ai.chat.completions.create({
        model: this.model,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content:
              "You create concise conversation summaries to help an AI assistant remember context.",
          },
          { role: "user", content: prompt },
        ],
      });

      const newSummary = response.choices[0]?.message?.content;
      if (newSummary) {
        this.summaries.set(channelId, newSummary);
      }
    } catch (err) {
      console.error("Summarization failed, restoring messages:", err);
      // Put messages back to avoid data loss
      const current = this.history.get(channelId) ?? [];
      this.history.set(channelId, [...toSummarize, ...current]);
    }
  }
}
