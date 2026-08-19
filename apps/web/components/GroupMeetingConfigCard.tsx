"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  GROUP_MEETING_ROSTER,
  type GroupMeeting,
  type GroupMeetingMemberSettings,
  type GroupMeetingRole,
  type GroupMeetingThinkingLevel,
} from "@/lib/group-meeting";
import type { ModelsData } from "@/lib/models-cache";

type Draft = Record<GroupMeetingRole, Omit<GroupMeetingMemberSettings, "role"> & { thinkingLevel: GroupMeetingThinkingLevel | "" }>;

function meetingDraft(meeting: GroupMeeting): Draft {
  return Object.fromEntries(meeting.members.map((member) => [member.role, {
    provider: member.provider ?? "",
    modelId: member.modelId ?? "",
    thinkingLevel: member.thinkingLevel ?? "",
  }])) as Draft;
}

function modelValue(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId]);
}

export function GroupMeetingConfigCard({
  meeting,
  modelsRefreshKey = 0,
  configuring = false,
  onSave,
}: {
  meeting: GroupMeeting;
  modelsRefreshKey?: number;
  configuring?: boolean;
  onSave: (members: GroupMeetingMemberSettings[]) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [models, setModels] = useState<ModelsData | null>(null);
  const [draft, setDraft] = useState<Draft>(() => meetingDraft(meeting));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(meetingDraft(meeting));
  }, [meeting]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch(`/api/models?cwd=${encodeURIComponent(meeting.cwd)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as ModelsData & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        setModels(payload);
        if (payload.modelError) setError(payload.modelError);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [meeting.cwd, modelsRefreshKey]);

  const modelOptions = useMemo(() => [...(models?.modelList ?? [])].sort((left, right) => (
    left.name.localeCompare(right.name)
    || left.provider.localeCompare(right.provider)
    || left.id.localeCompare(right.id)
  )), [models]);
  const complete = GROUP_MEETING_ROSTER.every(({ role }) => {
    const value = draft[role];
    return Boolean(value.provider && value.modelId && value.thinkingLevel);
  });
  const dirty = GROUP_MEETING_ROSTER.some(({ role }) => {
    const member = meeting.members.find((candidate) => candidate.role === role);
    const value = draft[role];
    return member?.provider !== value.provider
      || member?.modelId !== value.modelId
      || member?.thinkingLevel !== value.thinkingLevel;
  });

  const submit = async () => {
    if (!complete || !dirty || configuring) return;
    setError(null);
    setSaved(false);
    try {
      await onSave(GROUP_MEETING_ROSTER.map(({ role }) => ({
        role,
        provider: draft[role].provider,
        modelId: draft[role].modelId,
        thinkingLevel: draft[role].thinkingLevel as GroupMeetingThinkingLevel,
      })));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section
      aria-label={t("meeting.configTitle")}
      className="mx-2 mb-1 flex max-h-[46vh] shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-bg"
    >
      <div className="shrink-0 border-b border-border px-3 py-2">
        <strong className="text-xs text-text">{t("meeting.configTitle")}</strong>
        <p className="mt-0.5 text-[10px] leading-4 text-text-muted">{t("meeting.configDetail")}</p>
      </div>
      <div className="min-h-0 overflow-y-auto px-2 py-2">
        <div className="flex flex-col gap-2">
          {GROUP_MEETING_ROSTER.map(({ role, label }) => {
            const value = draft[role];
            const levels = (models?.thinkingLevels[`${value.provider}:${value.modelId}`] ?? [])
              .filter((level): level is GroupMeetingThinkingLevel => (
                level === "off" || level === "minimal" || level === "low" || level === "medium"
                || level === "high" || level === "xhigh" || level === "max"
              ));
            return (
              <div key={role} className="grid grid-cols-[58px_minmax(0,1fr)] gap-x-2 gap-y-1">
                <span className="self-center truncate text-[11px] font-medium text-text" title={label}>{label}</span>
                <select
                  aria-label={t("meeting.configModelFor", { role: label })}
                  value={modelValue(value.provider, value.modelId)}
                  disabled={loading || configuring}
                  onChange={(event) => {
                    const [provider, modelId] = JSON.parse(event.target.value) as [string, string];
                    const supported = models?.thinkingLevels[`${provider}:${modelId}`] ?? [];
                    setDraft((current) => ({
                      ...current,
                      [role]: {
                        provider,
                        modelId,
                        thinkingLevel: supported.includes(current[role].thinkingLevel)
                          ? current[role].thinkingLevel
                          : "",
                      },
                    }));
                    setSaved(false);
                  }}
                  className="min-w-0 rounded border border-border bg-bg-panel px-1.5 py-1 text-[10px] text-text outline-none focus:border-accent disabled:opacity-50"
                >
                  {!modelOptions.some((model) => model.provider === value.provider && model.id === value.modelId) && (
                    <option value={modelValue(value.provider, value.modelId)}>{value.provider}/{value.modelId}</option>
                  )}
                  {modelOptions.map((model) => (
                    <option key={modelValue(model.provider, model.id)} value={modelValue(model.provider, model.id)}>
                      {model.name} · {model.provider}/{model.id}
                    </option>
                  ))}
                </select>
                <span />
                <select
                  aria-label={t("meeting.configThinkingFor", { role: label })}
                  value={value.thinkingLevel}
                  disabled={loading || configuring || !value.modelId}
                  onChange={(event) => {
                    setDraft((current) => ({
                      ...current,
                      [role]: { ...current[role], thinkingLevel: event.target.value as GroupMeetingThinkingLevel },
                    }));
                    setSaved(false);
                  }}
                  className="min-w-0 rounded border border-border bg-bg-panel px-1.5 py-1 text-[10px] text-text outline-none focus:border-accent disabled:opacity-50"
                >
                  {!value.thinkingLevel && <option value="">{t("meeting.configSelectThinking")}</option>}
                  {levels.map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      </div>
      <div className="shrink-0 border-t border-border px-2 py-2">
        {error && <div role="alert" className="mb-2 text-[10px] leading-4 text-red-400">{error}</div>}
        {saved && <div role="status" className="mb-2 text-[10px] text-emerald-500">{t("meeting.configSaved")}</div>}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={loading || configuring || !complete || !dirty}
          className="w-full rounded-md bg-accent px-2 py-1.5 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {configuring ? t("meeting.configApplying") : t("meeting.configApply")}
        </button>
      </div>
    </section>
  );
}
