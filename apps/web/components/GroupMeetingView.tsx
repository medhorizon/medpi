"use client";

import { useCallback, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { GroupMeeting, GroupMeetingMember } from "@/lib/group-meeting";
import type { LabOrchestrateAction, LabWorkflow } from "@/lib/lab-workflow";
import type { SessionInfo } from "@/lib/types";
import { ChatWindow, type ChatRuntimeState } from "./ChatWindow";
import { LabWorkflowPane, LabWorkflowSummary } from "./LabWorkflowPanel";

export interface GroupMeetingViewProps {
  meeting: GroupMeeting | null;
  loading?: boolean;
  error?: string | null;
  modelsRefreshKey?: number;
  onAgentEnd?: (sessionId: string) => void;
  onOpenFile?: (filePath: string, sessionId: string) => void;
  workflow?: LabWorkflow | null;
  workflowLoading?: boolean;
  workflowError?: string | null;
  onWorkflowAction?: (action: LabOrchestrateAction) => Promise<unknown>;
}

type PaneStatus = ChatRuntimeState["status"] | "creating" | "failed";

function sessionForMember(member: GroupMeetingMember, meeting: GroupMeeting): SessionInfo | null {
  if (!member.sessionId) return null;
  return {
    id: member.sessionId,
    path: "",
    cwd: meeting.cwd,
    projectRoot: meeting.projectRoot,
    name: member.label,
    created: meeting.createdAt,
    modified: meeting.createdAt,
    messageCount: 0,
    firstMessage: "",
  };
}

function statusKey(status: PaneStatus): string {
  return `meeting.status.${status}`;
}

export function MeetingAgentPane({
  meeting,
  member,
  modelsRefreshKey,
  onAgentEnd,
  onOpenFile,
  workflow,
  onWorkflowAction,
}: {
  meeting: GroupMeeting;
  member: GroupMeetingMember;
  modelsRefreshKey?: number;
  onAgentEnd?: (sessionId: string) => void;
  onOpenFile?: (filePath: string, sessionId: string) => void;
  workflow?: LabWorkflow | null;
  onWorkflowAction?: (action: LabOrchestrateAction) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const session = useMemo(() => sessionForMember(member, meeting), [meeting, member]);
  const [runtime, setRuntime] = useState<ChatRuntimeState>({
    status: member.status === "failed" ? "error" : "loading",
    model: member.provider && member.modelId
      ? { provider: member.provider, modelId: member.modelId }
      : null,
    ...(member.error ? { error: member.error } : {}),
  });
  const handleRuntimeStateChange = useCallback((next: ChatRuntimeState) => {
    setRuntime((current) => (
      current.status === next.status
      && current.model?.provider === next.model?.provider
      && current.model?.modelId === next.model?.modelId
      && current.error === next.error
        ? current
        : next
    ));
  }, []);
  const handleAgentEnd = useCallback(() => {
    if (member.sessionId) onAgentEnd?.(member.sessionId);
  }, [member.sessionId, onAgentEnd]);
  const handleOpenFile = useCallback((filePath: string) => {
    if (member.sessionId) onOpenFile?.(filePath, member.sessionId);
  }, [member.sessionId, onOpenFile]);

  const paneStatus: PaneStatus = member.status === "failed"
    ? "failed"
    : member.status === "creating"
      ? "creating"
      : runtime.status;
  const model = runtime.model ?? (
    member.provider && member.modelId
      ? { provider: member.provider, modelId: member.modelId }
      : null
  );
  const modelLabel = model ? `${model.provider}/${model.modelId}` : t("meeting.modelUnavailable");
  const canPrompt = meeting.status === "ready" && member.status === "ready" && member.role === "pi";
  const paneError = member.error ?? runtime.error;

  return (
    <section
      role="region"
      aria-label={`${member.label} · ${modelLabel}`}
      data-meeting-role={member.role}
      data-session-id={member.sessionId ?? ""}
      data-read-only={!canPrompt}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-bg"
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
        <strong className="shrink-0 text-sm text-text">{member.label}</strong>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-muted" title={modelLabel}>
          {modelLabel}
          {member.thinkingLevel ? ` · ${member.thinkingLevel}` : ""}
        </span>
        <span
          role="status"
          aria-label={t(statusKey(paneStatus))}
          className="shrink-0 text-[11px] text-text-muted"
        >
          <span aria-hidden="true">● </span>{t(statusKey(paneStatus))}
        </span>
      </header>
      <LabWorkflowPane
        member={member}
        workflow={workflow ?? null}
        onAction={onWorkflowAction}
      />

      <div className="min-h-0 flex-1">
        {session ? (
          <ChatWindow
            key={session.id}
            session={session}
            newSessionCwd={null}
            readOnly={!canPrompt}
            compact
            modelsRefreshKey={modelsRefreshKey}
            onAgentEnd={handleAgentEnd}
            onOpenFile={handleOpenFile}
            onRuntimeStateChange={handleRuntimeStateChange}
          />
        ) : member.status === "creating" ? (
          <div role="status" className="flex h-full items-center justify-center px-4 text-center text-sm text-text-muted">
            {t("meeting.memberCreating")}
          </div>
        ) : (
          <div role="alert" className="flex h-full items-center justify-center px-4 text-center text-sm text-red-400">
            {paneError ?? t("meeting.sessionUnavailable")}
          </div>
        )}
      </div>
    </section>
  );
}

export function GroupMeetingViewContent({
  meeting,
  loading = false,
  error,
  modelsRefreshKey,
  onAgentEnd,
  onOpenFile,
  workflow,
  workflowLoading,
  workflowError,
  onWorkflowAction,
  isMobile,
}: GroupMeetingViewProps & { isMobile: boolean }) {
  const { t } = useI18n();

  if (loading) {
    return <div role="status" className="flex h-full items-center justify-center text-text-muted">{t("meeting.loading")}</div>;
  }

  if (!meeting) {
    return (
      <div role={error ? "alert" : "status"} className="flex h-full items-center justify-center px-6 text-center text-text-muted">
        {error ?? t("meeting.notStarted")}
      </div>
    );
  }

  if (isMobile) {
    return (
      <div role="status" className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <strong className="text-text">{t("meeting.desktopOnly")}</strong>
        <span className="text-sm text-text-muted">{t("meeting.desktopOnlyDetail")}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2 p-2">
      {(error || meeting.error) && (
        <div role="alert" className="shrink-0 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error ?? meeting.error}
        </div>
      )}
      <LabWorkflowSummary
        workflow={workflow ?? null}
        loading={workflowLoading}
        error={workflowError}
      />
      <div
        role="group"
        aria-label={t("meeting.sixAgentGrid")}
        className="grid min-h-0 min-w-[840px] flex-1 grid-cols-3 grid-rows-2 gap-2 overflow-auto"
      >
        {meeting.members.map((member) => (
          <MeetingAgentPane
            key={member.sessionId ?? member.role}
            meeting={meeting}
            member={member}
            modelsRefreshKey={modelsRefreshKey}
            onAgentEnd={onAgentEnd}
            onOpenFile={onOpenFile}
            workflow={workflow}
            onWorkflowAction={onWorkflowAction}
          />
        ))}
      </div>
    </div>
  );
}

export function GroupMeetingView(props: GroupMeetingViewProps) {
  const isMobile = useIsMobile();
  return <GroupMeetingViewContent {...props} isMobile={isMobile} />;
}
