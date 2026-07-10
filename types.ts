export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export type ClientMessage =
  | { type: "register"; protocol: string; version: number; session: Omit<SessionInfo, "id">; sessionId?: string }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message }
  | { type: "message_received"; deliveryId: string }
  | { type: "cancel_ask"; requestId: string; messageId: string }
  | { type: "presence"; name?: string; status?: string; model?: string };

export type BrokerMessage =
  | { type: "registered"; sessionId: string; protocol?: string; version?: number }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; deliveryId?: string; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; code?: string; error: string }
  | { type: "delivery_accepted"; messageId: string; deliveryId: string }
  | { type: "delivered"; messageId: string; deliveryId?: string }
  | { type: "delivery_failed"; messageId: string; accepted?: boolean; code?: string; reason: string }
  | { type: "ask_deferred"; messageId: string; fromSessionId: string }
  | { type: "ask_cancelled"; messageId: string; fromSessionId: string; reason: string }
  | { type: "ask_control_result"; requestId: string; action: "cancel"; messageId: string; applied: boolean };
