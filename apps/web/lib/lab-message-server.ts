import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import {
  configureLabRuntime,
  type LabMessageToolInput,
  type LabOrchestrateToolInput,
  type LabScienceDatabaseAuthorizationInput,
} from "@medpi/lab/runtime";
import {
  type GroupMeeting,
  type GroupMeetingMember,
  type GroupMeetingRole,
} from "./group-meeting";
import { getRpcSession, startRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";

const SENIOR_ROLES = new Set<GroupMeetingRole>(["pi", "phd-1", "phd-2", "master-1", "master-2"]);

export interface LabMessage {
  messageId: string;
  meetingId: string;
  fromRole: Exclude<GroupMeetingRole, "undergraduate">;
  toRoles: Array<Exclude<GroupMeetingRole, "undergraduate">>;
  body: string;
  replyTo?: string;
  createdAt: string;
}

interface LabMessageDelivery {
  role: Exclude<GroupMeetingRole, "undergraduate">;
  sessionId: string;
  status: "pending" | "delivered" | "failed";
  mode?: "prompt" | "follow_up";
  error?: string;
}

interface LabMessageRecord extends LabMessage {
  deliveries: LabMessageDelivery[];
}

interface LabMessageAudit {
  meetingId: string;
  cwd: string;
  messages: LabMessageRecord[];
}

export class LabMessageError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "LabMessageError";
  }
}

export interface SendLabMessageDependencies {
  agentDir?: string;
  readMeeting?: (cwd: string, meetingId: string, agentDir?: string) => Promise<GroupMeeting | null>;
  deliver?: (recipient: GroupMeetingMember, message: LabMessage) => Promise<"prompt" | "follow_up">;
}

function isSeniorRole(role: GroupMeetingRole): role is Exclude<GroupMeetingRole, "undergraduate"> {
  return SENIOR_ROLES.has(role);
}

async function defaultReadMeeting(cwd: string, meetingId: string, agentDir: string): Promise<GroupMeeting | null> {
  // Keep the extension runtime binding free of a static group-server cycle.
  const { readGroupMeeting } = await import("./group-meeting-server");
  return readGroupMeeting(cwd, meetingId, agentDir);
}

function messageDirectory(cwd: string, agentDir: string): string {
  return join(agentDir, "meetings", createHash("sha256").update(resolve(cwd)).digest("hex"), "lab-messages");
}

function auditPath(cwd: string, meetingId: string, agentDir: string): string {
  return join(messageDirectory(cwd, agentDir), `${meetingId}.json`);
}

async function readAudit(cwd: string, meetingId: string, agentDir: string): Promise<LabMessageAudit> {
  try {
    const parsed = JSON.parse(await readFile(auditPath(cwd, meetingId, agentDir), "utf8")) as LabMessageAudit;
    if (parsed.meetingId !== meetingId || parsed.cwd !== cwd || !Array.isArray(parsed.messages)) {
      throw new LabMessageError("Invalid lab message audit", "invalid_audit");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { meetingId, cwd, messages: [] };
    throw error;
  }
}

async function persistAudit(audit: LabMessageAudit, agentDir: string): Promise<void> {
  const directory = messageDirectory(audit.cwd, agentDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = auditPath(audit.cwd, audit.meetingId, agentDir);
  const temporary = join(directory, `.${audit.meetingId}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function withMessageLock<T>(cwd: string, meetingId: string, agentDir: string, operation: () => Promise<T>): Promise<T> {
  const directory = messageDirectory(cwd, agentDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    realpath: false,
    lockfilePath: join(directory, `.${meetingId}.lock`),
    stale: 30_000,
    update: 10_000,
    retries: { retries: 50, minTimeout: 10, maxTimeout: 200, factor: 1.2 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

function messageId(input: LabMessageToolInput): string {
  if (!input.idempotencyKey) return randomUUID();
  return `message-${createHash("sha256")
    .update(`${input.meetingId}:${input.senderSessionId}:${input.idempotencyKey}`)
    .digest("hex")}`;
}

function inboundPrompt(message: LabMessage): string {
  return [
    "You received a natural-language message from another senior lab member.",
    `meetingId: ${message.meetingId}`,
    `messageId: ${message.messageId}`,
    `from: ${message.fromRole}`,
    ...(message.replyTo ? [`replyTo: ${message.replyTo}`] : []),
    "body:",
    message.body,
  ].join("\n");
}

async function deliverToSession(recipient: GroupMeetingMember, message: LabMessage): Promise<"prompt" | "follow_up"> {
  if (!recipient.sessionId) throw new LabMessageError("Recipient session is unavailable", "recipient_unavailable");
  let session = getRpcSession(recipient.sessionId);
  if (!session?.isAlive()) {
    const sessionFile = await resolveSessionPath(recipient.sessionId);
    if (!sessionFile) throw new LabMessageError("Recipient session is unavailable", "recipient_unavailable");
    ({ session } = await startRpcSession(recipient.sessionId, sessionFile, undefined));
  }
  const state = await session.send({ type: "get_state" }) as {
    isStreaming?: boolean;
    isPromptRunning?: boolean;
    isBashRunning?: boolean;
    isCompacting?: boolean;
  };
  const mode = state.isStreaming || state.isPromptRunning || state.isBashRunning || state.isCompacting
    ? "follow_up"
    : "prompt";
  await session.send({ type: mode, message: inboundPrompt(message) });
  return mode;
}

function receipt(record: LabMessageRecord) {
  return {
    message: {
      messageId: record.messageId,
      meetingId: record.meetingId,
      fromRole: record.fromRole,
      toRoles: record.toRoles,
      body: record.body,
      ...(record.replyTo ? { replyTo: record.replyTo } : {}),
      createdAt: record.createdAt,
    },
    deliveries: record.deliveries.map((delivery) => ({
      role: delivery.role,
      sessionId: delivery.sessionId,
      status: delivery.status,
      ...(delivery.mode ? { mode: delivery.mode } : {}),
      ...(delivery.error ? { error: delivery.error } : {}),
    })),
  };
}

function assertInput(input: LabMessageToolInput): void {
  if (!input.meetingId || input.meetingId.length > 100) throw new LabMessageError("Invalid meeting id", "invalid_meeting_id");
  if (!input.senderSessionId) throw new LabMessageError("Missing sender session", "invalid_sender");
  if (typeof input.body !== "string" || !input.body || input.body.length > 30_000) {
    throw new LabMessageError("Invalid message body", "invalid_body");
  }
  if (!Array.isArray(input.toRoles) || input.toRoles.length === 0 || input.toRoles.length > 4) {
    throw new LabMessageError("Invalid recipients", "invalid_recipients");
  }
  if (input.replyTo !== undefined && (typeof input.replyTo !== "string" || !input.replyTo || input.replyTo.length > 128)) {
    throw new LabMessageError("Invalid reply target", "invalid_reply_to");
  }
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || !input.idempotencyKey || input.idempotencyKey.length > 256)) {
    throw new LabMessageError("Invalid idempotency key", "invalid_idempotency_key");
  }
}

export async function sendLabMessage(
  input: LabMessageToolInput,
  dependencies: SendLabMessageDependencies = {},
) {
  assertInput(input);
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const readMeeting = dependencies.readMeeting ?? defaultReadMeeting;
  const deliver = dependencies.deliver ?? deliverToSession;
  return withMessageLock(input.cwd, input.meetingId, agentDir, async () => {
    const meeting = await readMeeting(input.cwd, input.meetingId, agentDir);
    if (!meeting) throw new LabMessageError("Meeting not found", "meeting_not_found");
    if (meeting.status !== "ready") throw new LabMessageError("Meeting is not ready", "meeting_not_ready");
    const sender = meeting.members.find((member) => member.sessionId === input.senderSessionId);
    if (!sender || !isSeniorRole(sender.role) || sender.status !== "ready") {
      throw new LabMessageError("Only ready senior meeting members may send messages", "sender_not_allowed");
    }
    const roles = [...new Set(input.toRoles)];
    if (roles.some((role) => !isSeniorRole(role as GroupMeetingRole)) || roles.includes(sender.role)) {
      throw new LabMessageError("Recipients must be different senior meeting members", "recipient_not_allowed");
    }
    const recipients = roles.map((role) => meeting.members.find((member) => member.role === role));
    if (recipients.some((member) => !member || member.status !== "ready" || !member.sessionId)) {
      throw new LabMessageError("Recipient is not a ready meeting member", "recipient_unavailable");
    }

    const audit = await readAudit(meeting.cwd, meeting.meetingId, agentDir);
    const id = messageId(input);
    const existing = audit.messages.find((record) => record.messageId === id);
    if (existing) return receipt(existing);

    const message: LabMessage = {
      messageId: id,
      meetingId: meeting.meetingId,
      fromRole: sender.role,
      toRoles: roles as Array<Exclude<GroupMeetingRole, "undergraduate">>,
      body: input.body,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      createdAt: new Date().toISOString(),
    };
    const record: LabMessageRecord = {
      ...message,
      deliveries: recipients.map((recipient) => ({
        role: recipient!.role as Exclude<GroupMeetingRole, "undergraduate">,
        sessionId: recipient!.sessionId!,
        status: "pending",
      })),
    };
    audit.messages.push(record);
    await persistAudit(audit, agentDir);

    for (const delivery of record.deliveries) {
      const recipient = recipients.find((member) => member?.role === delivery.role)!;
      try {
        delivery.mode = await deliver(recipient!, message);
        delivery.status = "delivered";
      } catch (error) {
        delivery.status = "failed";
        delivery.error = error instanceof Error ? error.message : String(error);
      }
      await persistAudit(audit, agentDir);
    }
    return receipt(record);
  });
}

export function configureLabMessageRuntime(
  orchestrate: (input: LabOrchestrateToolInput) => Promise<unknown>,
  authorizeScienceDatabase?: (input: LabScienceDatabaseAuthorizationInput) => Promise<void>,
): void {
  configureLabRuntime({ sendMessage: sendLabMessage, orchestrate, ...(authorizeScienceDatabase ? { authorizeScienceDatabase } : {}) });
}
