"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { GroupMeetingMember } from "@/lib/group-meeting";
import type { LabOrchestrateAction, LabWorkflow } from "@/lib/lab-workflow";

export interface LabWorkflowPaneProps {
  member: GroupMeetingMember;
  workflow: LabWorkflow | null;
  loading?: boolean;
  error?: string | null;
  onAction?: (action: LabOrchestrateAction) => Promise<unknown>;
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function activeThreads(workflow: LabWorkflow): number {
  return workflow.undergradThreads.filter((thread) => thread.status === "created" || thread.status === "running").length;
}

function WorkflowLine({ label, value }: { label: string; value: string | number }) {
  return <span className="text-[11px] text-text-muted">{label}: <strong className="font-medium text-text">{value}</strong></span>;
}

function ClarificationCard({
  card,
  answered,
  onAction,
}: {
  card: LabWorkflow["clarificationCards"][number];
  answered: LabWorkflow["clarificationResponses"][number] | undefined;
  onAction?: (action: LabOrchestrateAction) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string[]>(answered?.selectedOptionIds ?? []);
  const [freeText, setFreeText] = useState(answered?.freeText ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const disabled = Boolean(answered) || !onAction || submitting;
  const canSubmit = selected.length > 0 || (card.allowOther && freeText.trim().length > 0);

  const submit = async () => {
    if (!onAction || !canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onAction({
        action: "submit_clarification",
        requestId: requestId(),
        questionId: card.questionId,
        selectedOptionIds: selected,
        ...(freeText.trim() ? { freeText: freeText.trim() } : {}),
      });
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded border border-border bg-bg px-2 py-1.5">
      {card.title && <strong className="block text-xs text-text">{card.title}</strong>}
      {card.description && <p className="mb-1 text-[10px] leading-4 text-text-muted">{card.description}</p>}
      <fieldset disabled={disabled}>
        <legend className="px-1 text-[11px] font-medium text-text">{card.question}{card.required ? " *" : ""}</legend>
        <div className="space-y-1">
          {card.options.map((option) => (
            <label key={option.id} className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text">
              <input
                type={card.selectionMode === "single" ? "radio" : "checkbox"}
                name={card.selectionMode === "single" ? card.questionId : undefined}
                checked={selected.includes(option.id)}
                onChange={() => setSelected((current) => card.selectionMode === "single"
                  ? [option.id]
                  : current.includes(option.id)
                    ? current.filter((id) => id !== option.id)
                    : [...current, option.id])}
              />
              {option.label}
            </label>
          ))}
        </div>
        {card.allowOther && (
          <textarea
            className="mt-1 w-full resize-y rounded border border-border bg-bg px-1.5 py-1 text-[11px] text-text"
            value={freeText}
            onChange={(event) => setFreeText(event.target.value)}
            placeholder={t("meeting.workflowOther")}
            rows={2}
          />
        )}
        {answered ? (
          <p className="mt-1 text-[11px] text-text-muted">{t("meeting.workflowAnswered")}</p>
        ) : (
          <button
            type="button"
            className="mt-1 rounded border border-border px-2 py-1 text-[11px] text-text disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSubmit || submitting}
            onClick={() => { void submit(); }}
          >
            {submitting ? t("meeting.workflowSubmitting") : card.submitLabel ?? t("meeting.workflowSubmit")}
          </button>
        )}
        {submitError && <p role="alert" className="mt-1 text-[11px] text-red-400">{submitError}</p>}
      </fieldset>
    </div>
  );
}

function DoctorWorkflow({ role, workflow }: { role: "phd-1" | "phd-2"; workflow: LabWorkflow }) {
  const { t } = useI18n();
  const workPackage = workflow.workPackages.find((candidate) => candidate.doctorRole === role);
  if (!workPackage) return <p className="text-[11px] text-text-muted">{t("meeting.workflowWaitingPackage")}</p>;
  const reservation = workPackage.masterRequestId
    ? workflow.masterReservations.find((candidate) => candidate.requestId === workPackage.masterRequestId)
    : undefined;
  return (
    <div className="space-y-1" data-workflow-doctor={role}>
      <WorkflowLine label={t("meeting.workflowMode")} value={workPackage.mode} />
      <WorkflowLine label={t("meeting.workflowStage")} value={workPackage.status} />
      <WorkflowLine label={t("meeting.workflowPreJudgment")} value={workPackage.preMasterJudgment ? t("meeting.workflowSubmitted") : t("meeting.workflowPending")} />
      <WorkflowLine label={t("meeting.workflowMasterReservation")} value={reservation ? `${reservation.masterRole} · ${reservation.status}` : t("meeting.workflowNotReserved")} />
      <WorkflowLine label={t("meeting.workflowSynthesis")} value={workPackage.synthesis ? t("meeting.workflowSubmitted") : t("meeting.workflowPending")} />
    </div>
  );
}

function MasterWorkflow({ role, workflow }: { role: "master-1" | "master-2"; workflow: LabWorkflow }) {
  const { t } = useI18n();
  const reservations = workflow.masterReservations.filter((reservation) => reservation.masterRole === role);
  return (
    <div className="space-y-1" data-workflow-master={role}>
      <WorkflowLine label={t("meeting.workflowAnalysis")} value={reservations.length} />
      {reservations.length === 0
        ? <p className="text-[11px] text-text-muted">{t("meeting.workflowNoAnalysisRequest")}</p>
        : reservations.map((reservation) => (
          <p key={reservation.requestId} className="text-[11px] text-text-muted">
            {reservation.doctorRole} · {reservation.status}{reservation.analysis ? ` · ${t("meeting.workflowSubmitted")}` : ""}
          </p>
        ))}
    </div>
  );
}

function UndergradWorkflow({ workflow }: { workflow: LabWorkflow }) {
  const { t } = useI18n();
  const active = activeThreads(workflow);
  return (
    <div className="space-y-1" data-workflow-undergraduate>
      <WorkflowLine label={t("meeting.workflowThreadCapacity")} value={`${active} / 6`} />
      {workflow.undergradTasks.length === 0
        ? <p className="text-[11px] text-text-muted">{t("meeting.workflowNoUndergradTask")}</p>
        : workflow.undergradTasks.map((task) => {
          const taskThreads = workflow.undergradThreads.filter((thread) => thread.parentTaskId === task.taskId);
          const records = task.submission?.records.length ?? 0;
          return (
            <div key={task.taskId} className="rounded border border-border px-1.5 py-1 text-[11px] text-text-muted">
              <p className="truncate text-text" title={task.title}>{task.title}</p>
              <p>{task.requesterRole} · {task.workType} · {task.status} · {t("meeting.workflowAttempt")} {task.attempt}</p>
              <p>{t("meeting.workflowTaskThreads")}: {taskThreads.filter((thread) => thread.status === "created" || thread.status === "running").length} / {task.maxThreads} · {t("meeting.workflowRecordsOnly")}: {records}</p>
              {taskThreads.map((thread) => <p key={thread.threadId} className="truncate">↳ {thread.title} · {thread.status}</p>)}
            </div>
          );
        })}
    </div>
  );
}

export function LabWorkflowSummary({ workflow, loading, error }: Pick<LabWorkflowPaneProps, "workflow" | "loading" | "error">) {
  const { t } = useI18n();
  if (loading) return <div role="status" className="shrink-0 text-[11px] text-text-muted">{t("meeting.workflowLoading")}</div>;
  if (error) return <div role="alert" className="shrink-0 text-[11px] text-red-400">{error}</div>;
  if (!workflow) return null;
  const waitingReview = workflow.undergradTasks.filter((task) => task.status === "submitted").length;
  const blocked = workflow.undergradTasks.filter((task) => task.status === "blocked" || task.status === "failed").length
    + workflow.undergradThreads.filter((thread) => thread.status === "blocked" || thread.status === "failed" || thread.status === "interrupted").length;
  return (
    <div className="shrink-0 rounded-md border border-border bg-bg px-2 py-1 text-[11px] text-text-muted" data-workflow-summary>
      {t("meeting.workflowSummary", {
        status: workflow.status,
        activeThreads: activeThreads(workflow),
        awaitingReview: waitingReview,
        blocked,
      })}
    </div>
  );
}

export function LabWorkflowPane({ member, workflow, loading, error, onAction }: LabWorkflowPaneProps) {
  const { t } = useI18n();
  if (loading) return <div role="status" className="border-b border-border px-2 py-1.5 text-[11px] text-text-muted">{t("meeting.workflowLoading")}</div>;
  if (error) return <div role="alert" className="border-b border-border px-2 py-1.5 text-[11px] text-red-400">{error}</div>;
  if (!workflow) return null;

  return (
    <div className="max-h-48 shrink-0 overflow-y-auto border-b border-border px-2 py-1.5" data-workflow-role={member.role}>
      {member.role === "pi" && (
        <div className="space-y-1.5">
          <WorkflowLine label={t("meeting.workflowStage")} value={workflow.status} />
          {workflow.clarificationCards.length === 0
            ? <p className="text-[11px] text-text-muted">{t("meeting.workflowNoClarifications")}</p>
            : workflow.clarificationCards.map((card) => (
              <ClarificationCard
                key={card.questionId}
                card={card}
                answered={workflow.clarificationResponses.find((response) => response.questionId === card.questionId)}
                onAction={onAction}
              />
            ))}
        </div>
      )}
      {member.role === "phd-1" && <DoctorWorkflow role="phd-1" workflow={workflow} />}
      {member.role === "phd-2" && <DoctorWorkflow role="phd-2" workflow={workflow} />}
      {member.role === "master-1" && <MasterWorkflow role="master-1" workflow={workflow} />}
      {member.role === "master-2" && <MasterWorkflow role="master-2" workflow={workflow} />}
      {member.role === "undergraduate" && <UndergradWorkflow workflow={workflow} />}
    </div>
  );
}
