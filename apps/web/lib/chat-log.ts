import {
  agentControllerMessageText,
  type KnownAgentControllerEvent,
  type MastraDBMessage,
} from "@mastra/client-js";

/** One line of the chat as the page shows it. */
export type ChatLine = { id: string; role: "user" | "assistant"; text: string };

type MessageUpdate = Extract<KnownAgentControllerEvent, { type: "message_update" }>["event"];

/** A streamed message with one update applied, as Mastra's agent-controller docs rebuild it. */
export function applyUpdate(message: MastraDBMessage, update: MessageUpdate): MastraDBMessage {
  const parts = [...message.content.parts];
  if (update.type === "text-delta") {
    const index = parts.findLastIndex((part) => part.type === "text");
    const part = parts[index];
    if (part?.type === "text") parts[index] = { ...part, text: part.text + update.delta };
    else parts.push({ type: "text", text: update.delta });
  } else if (update.type === "reasoning-delta") {
    const part = parts[update.index];
    const reasoning = part?.type === "reasoning" ? part.reasoning + update.delta : update.delta;
    parts[update.index] = {
      ...(part?.type === "reasoning" ? part : { type: "reasoning" as const }),
      reasoning,
      details: [{ type: "text", text: reasoning }],
    };
  } else {
    parts[update.index] = update.part;
  }
  return { ...message, content: { ...message.content, parts } };
}

/** The line a stored or streamed message shows as, or null when it has nothing to read. */
export function lineOf(message: MastraDBMessage): ChatLine | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const text = agentControllerMessageText(message).trim();
  return text ? { id: message.id, role: message.role, text } : null;
}

/** A thread's stored messages as chat lines, oldest first. */
export function linesOf(messages: MastraDBMessage[]): ChatLine[] {
  return messages.flatMap((message) => lineOf(message) ?? []);
}
