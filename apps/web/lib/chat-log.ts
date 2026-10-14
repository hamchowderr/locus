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

/** A change the assistant is waiting for the member to allow or decline. */
export type Approval = { toolCallId: string; toolName: string; args: unknown };

/** A question the assistant asked (its `ask_user` tool), waiting for the member's answer. */
export type Question = {
  toolCallId: string;
  question: string;
  options: string[];
  multiple: boolean;
};

/** The question a suspended tool is waiting on, from what it suspended with. */
export function questionOf(toolCallId: string, toolName: string, payload: unknown): Question {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const options = Array.isArray(p.options)
    ? p.options.flatMap((o) =>
        o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string"
          ? [(o as { label: string }).label]
          : [],
      )
    : [];
  return {
    toolCallId,
    question:
      typeof p.question === "string" ? p.question : `The assistant (${toolName}) needs an answer.`,
    options,
    multiple: options.length > 0 && p.selectionMode === "multi_select",
  };
}

type Pending = {
  pendingApprovals: Record<string, { toolCallId: string; toolName: string; args: unknown }>;
  pendingSuspensions: Record<
    string,
    { toolCallId: string; toolName: string; suspendPayload: unknown }
  >;
};

/** What the session is waiting on the member for, from a `display_state_changed` snapshot. */
export function pendingOf(display: Pending): { approvals: Approval[]; questions: Question[] } {
  return {
    approvals: Object.values(display.pendingApprovals ?? {}).map(
      ({ toolCallId, toolName, args }) => ({ toolCallId, toolName, args }),
    ),
    questions: Object.values(display.pendingSuspensions ?? {}).map((s) =>
      questionOf(s.toolCallId, s.toolName, s.suspendPayload),
    ),
  };
}
