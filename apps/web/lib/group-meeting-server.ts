import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { createNewAgentSession } from "./agent-session-create";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import {
  GROUP_MEETING_ROSTER,
  GROUP_MEETING_TOOL_POLICY_VERSION,
  getGroupMeetingRoleSystemPrompt,
  getGroupMeetingToolNames,
  type GroupMeeting,
  type GroupMeetingMember,
  type GroupMeetingRole,
  type GroupMeetingThinkingLevel,
} from "./group-meeting";
import { resolveVisibleModels } from "./model-scope";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { bindLabWorkflowRuntime, resolveLabWorkflowChildSessionPolicy } from "./lab-workflow";
import { resolveProject } from "./worktree";

bindLabWorkflowRuntime();

interface ResolvedMeetingMember {
  role: GroupMeetingRole;
  label: string;
  provider: string;
  modelId: string;
  thinkingLevel: GroupMeetingThinkingLevel;
}

interface MeetingCreationDependencies {
  agentDir?: string;
  projectRoot?: string;
  createSession?: typeof createNewAgentSession;
}

export interface GroupMeetingSessionPolicy {
  role: GroupMeetingRole;
  toolNames: string[];
  systemPrompt: string;
}

export function getGroupMeetingSessionPolicy(
  meeting: GroupMeeting,
  sessionId: string,
): GroupMeetingSessionPolicy | null {
  if ((meeting.toolPolicyVersion ?? GROUP_MEETING_TOOL_POLICY_VERSION) !== GROUP_MEETING_TOOL_POLICY_VERSION) {
    throw new GroupMeetingError("Unsupported group meeting tool policy", "invalid_metadata");
  }
  const member = meeting.members.find((candidate) => candidate.sessionId === sessionId);
  return member ? {
    role: member.role,
    toolNames: getGroupMeetingToolNames(member.role),
    systemPrompt: getGroupMeetingRoleSystemPrompt(member.role),
  } : null;
}

export class GroupMeetingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly role?: GroupMeetingRole,
    readonly meeting?: GroupMeeting,
  ) {
    super(message);
    this.name = "GroupMeetingError";
  }
}

function roleError(
  role: GroupMeetingRole,
  label: string,
  code: string,
  message: string,
): GroupMeetingError {
  return new GroupMeetingError(`${label}: ${message}`, code, role);
}

export function resolveGroupMeetingRoster(
  visibleModels: readonly Model<Api>[],
): ResolvedMeetingMember[] {
  return GROUP_MEETING_ROSTER.map((member) => {
    const matches = visibleModels.filter((model) => model.id === member.modelId);
    if (matches.length === 0) {
      throw roleError(member.role, member.label, "model_unavailable", `模型 ${member.modelId} 不可见或未认证`);
    }
    if (matches.length > 1) {
      const providers = matches.map((model) => model.provider).sort().join(", ");
      throw roleError(
        member.role,
        member.label,
        "model_ambiguous",
        `模型 ${member.modelId} 同时来自多个 provider (${providers})，请在 ModelsConfig 中保留唯一选择`,
      );
    }

    const model = matches[0];
    if (!getSupportedThinkingLevels(model).includes(member.thinkingLevel)) {
      throw roleError(
        member.role,
        member.label,
        "thinking_unsupported",
        `模型 ${model.provider}/${model.id} 不支持 thinking level ${member.thinkingLevel}`,
      );
    }
    return {
      role: member.role,
      label: member.label,
      provider: model.provider,
      modelId: model.id,
      thinkingLevel: member.thinkingLevel,
    };
  });
}

async function normalizeMeetingCwd(requestedCwd: string): Promise<string> {
  const absolute = resolve(requestedCwd);
  let cwdStat;
  try {
    cwdStat = await stat(absolute);
  } catch {
    throw new GroupMeetingError(`Directory does not exist: ${requestedCwd}`, "invalid_cwd");
  }
  if (!cwdStat.isDirectory()) throw new GroupMeetingError(`Not a directory: ${requestedCwd}`, "invalid_cwd");
  return absolute;
}

async function authorizeMeetingCwd(requestedCwd: string): Promise<string> {
  const cwd = await normalizeMeetingCwd(requestedCwd);
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    throw new GroupMeetingError("Access denied", "access_denied");
  }
  const trust = getProjectTrustStatus(cwd, getAgentDir());
  if (!trust.trusted) {
    throw new GroupMeetingError(`Project is not trusted: ${cwd}`, "project_untrusted");
  }
  return cwd;
}

async function preflightGroupMeeting(requestedCwd: string): Promise<{
  cwd: string;
  projectRoot: string;
  roster: ResolvedMeetingMember[];
}> {
  const cwd = await authorizeMeetingCwd(requestedCwd);
  const agentDir = getAgentDir();
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const scope = await resolveVisibleModels(
    services.modelRuntime,
    services.settingsManager.getEnabledModels(),
  );
  const { projectRoot } = await resolveProject(cwd);
  return { cwd, projectRoot, roster: resolveGroupMeetingRoster(scope.visible) };
}

function meetingDirectory(cwd: string, agentDir: string): string {
  const projectKey = createHash("sha256").update(cwd).digest("hex");
  return join(agentDir, "meetings", projectKey);
}

function meetingPath(cwd: string, meetingId: string, agentDir: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meetingId)) {
    throw new GroupMeetingError("Invalid meeting id", "invalid_meeting_id");
  }
  return join(meetingDirectory(cwd, agentDir), `${meetingId}.json`);
}

export async function persistGroupMeeting(
  meeting: GroupMeeting,
  agentDir = getAgentDir(),
): Promise<void> {
  const directory = meetingDirectory(meeting.cwd, agentDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = meetingPath(meeting.cwd, meeting.meetingId, agentDir);
  const temporary = join(directory, `.${meeting.meetingId}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(meeting, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function parseMeeting(contents: string): GroupMeeting {
  const meeting = JSON.parse(contents) as Partial<GroupMeeting>;
  const expectedRoles = GROUP_MEETING_ROSTER.map((member) => member.role);
  if (
    typeof meeting.meetingId !== "string"
    || typeof meeting.cwd !== "string"
    || typeof meeting.projectRoot !== "string"
    || typeof meeting.createdAt !== "string"
    || (meeting.toolPolicyVersion !== undefined && meeting.toolPolicyVersion !== GROUP_MEETING_TOOL_POLICY_VERSION)
    || (meeting.status !== "creating" && meeting.status !== "ready" && meeting.status !== "failed")
    || !Array.isArray(meeting.members)
    || meeting.members.length !== expectedRoles.length
    || meeting.members.some((member, index) => member?.role !== expectedRoles[index])
  ) {
    throw new GroupMeetingError("Invalid meeting metadata", "invalid_metadata");
  }
  return meeting as GroupMeeting;
}

export async function readGroupMeeting(
  requestedCwd: string,
  meetingId: string,
  agentDir = getAgentDir(),
): Promise<GroupMeeting | null> {
  const cwd = await authorizeMeetingCwd(requestedCwd);
  try {
    const meeting = parseMeeting(await readFile(meetingPath(cwd, meetingId, agentDir), "utf8"));
    if (meeting.cwd !== cwd || meeting.meetingId !== meetingId) {
      throw new GroupMeetingError("Meeting metadata does not match its project or id", "invalid_metadata");
    }
    return meeting;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function resolveGroupMeetingSessionPolicy(
  sessionId: string,
  agentDir = getAgentDir(),
): Promise<GroupMeetingSessionPolicy | null> {
  let projectDirectories;
  try {
    projectDirectories = await readdir(join(agentDir, "meetings"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  for (const projectDirectory of projectDirectories) {
    if (!projectDirectory.isDirectory()) continue;
    const directory = join(agentDir, "meetings", projectDirectory.name);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".workflow.json")) continue;
      const policy = getGroupMeetingSessionPolicy(
        parseMeeting(await readFile(join(directory, entry.name), "utf8")),
        sessionId,
      );
      if (policy) return policy;
    }
  }
  return resolveLabWorkflowChildSessionPolicy(sessionId, agentDir);
}

export async function listGroupMeetings(
  requestedCwd: string,
  agentDir = getAgentDir(),
): Promise<GroupMeeting[]> {
  const cwd = await authorizeMeetingCwd(requestedCwd);
  const directory = meetingDirectory(cwd, agentDir);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const meetings = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => parseMeeting(await readFile(join(directory, entry.name), "utf8"))));
  if (meetings.some((meeting) => meeting.cwd !== cwd)) {
    throw new GroupMeetingError("Meeting metadata does not match its project", "invalid_metadata");
  }
  return meetings.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function createGroupMeetingFromRoster(
  cwd: string,
  roster: ResolvedMeetingMember[],
  dependencies: MeetingCreationDependencies = {},
): Promise<GroupMeeting> {
  const createSession = dependencies.createSession ?? createNewAgentSession;
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const projectRoot = dependencies.projectRoot ?? cwd;
  const meetingId = randomUUID();
  const createdAt = new Date().toISOString();
  const members: GroupMeetingMember[] = roster.map((member) => ({
    role: member.role,
    label: member.label,
    sessionId: null,
    provider: member.provider,
    modelId: member.modelId,
    thinkingLevel: member.thinkingLevel,
    status: "creating",
  }));
  const meeting: GroupMeeting = {
    meetingId,
    cwd,
    projectRoot,
    createdAt,
    toolPolicyVersion: GROUP_MEETING_TOOL_POLICY_VERSION,
    status: "creating",
    members,
  };
  await persistGroupMeeting(meeting, agentDir);

  for (let index = 0; index < roster.length; index += 1) {
    const requested = roster[index];
    let createdSession: Awaited<ReturnType<typeof createNewAgentSession>> | undefined;
    try {
      const toolNames = getGroupMeetingToolNames(requested.role);
      const result = await createSession(
        cwd,
        {
          type: "ensure_session",
          provider: requested.provider,
          modelId: requested.modelId,
          thinkingLevel: requested.thinkingLevel as ThinkingLevel,
          toolNames,
        },
        {
          persistStartupPreferences: false,
          persistSession: true,
          fixedToolNames: toolNames,
          fixedSystemPrompt: getGroupMeetingRoleSystemPrompt(requested.role),
        },
      );
      createdSession = result;
      const actual = result.model;
      if (
        !actual
        || actual.provider !== requested.provider
        || actual.modelId !== requested.modelId
        || result.thinkingLevel !== requested.thinkingLevel
      ) {
        throw new Error(
          `实际启动状态不匹配（期望 ${requested.provider}/${requested.modelId}:${requested.thinkingLevel}，`
          + `实际 ${actual ? `${actual.provider}/${actual.modelId}` : "无模型"}:${result.thinkingLevel ?? "无"}）`,
        );
      }
      members[index] = {
        role: requested.role,
        label: requested.label,
        sessionId: result.sessionId,
        provider: actual.provider,
        modelId: actual.modelId,
        thinkingLevel: requested.thinkingLevel,
        status: "ready",
      };
      await persistGroupMeeting(meeting, agentDir);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      members[index] = {
        role: requested.role,
        label: requested.label,
        sessionId: createdSession?.sessionId ?? null,
        provider: createdSession?.model?.provider ?? requested.provider,
        modelId: createdSession?.model?.modelId ?? requested.modelId,
        thinkingLevel: (createdSession?.thinkingLevel as GroupMeetingThinkingLevel | undefined) ?? requested.thinkingLevel,
        status: "failed",
        error: reason,
      };
      for (let skippedIndex = index + 1; skippedIndex < roster.length; skippedIndex += 1) {
        const skipped = roster[skippedIndex];
        members[skippedIndex] = {
          role: skipped.role,
          label: skipped.label,
          sessionId: null,
          provider: skipped.provider,
          modelId: skipped.modelId,
          thinkingLevel: skipped.thinkingLevel,
          status: "failed",
          error: "未启动：前序成员创建失败",
        };
      }
      const errorMessage = `${requested.label}: ${reason}`;
      meeting.status = "failed";
      meeting.error = errorMessage;
      await persistGroupMeeting(meeting, agentDir);
      throw new GroupMeetingError(errorMessage, "session_create_failed", requested.role, meeting);
    }
  }

  meeting.status = "ready";
  await persistGroupMeeting(meeting, agentDir);
  return meeting;
}

export async function createGroupMeeting(requestedCwd: string): Promise<GroupMeeting> {
  const { cwd, projectRoot, roster } = await preflightGroupMeeting(requestedCwd);
  return createGroupMeetingFromRoster(cwd, roster, { projectRoot });
}
