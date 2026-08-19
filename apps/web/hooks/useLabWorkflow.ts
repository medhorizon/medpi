"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupMeeting } from "@/lib/group-meeting";
import type { LabOrchestrateAction, LabWorkflow } from "@/lib/lab-workflow";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(payload: unknown, status: number): string {
  return isRecord(payload) && typeof payload.error === "string"
    ? payload.error
    : `Lab workflow request failed (HTTP ${status})`;
}

/** The UI only accepts workflow data scoped to the current meeting and project. */
export function validateLabWorkflow(value: unknown, meeting: GroupMeeting): LabWorkflow {
  if (!isRecord(value)
    || value.meetingId !== meeting.meetingId
    || value.cwd !== meeting.cwd
    || typeof value.status !== "string"
    || !Array.isArray(value.clarificationCards)
    || !Array.isArray(value.clarificationResponses)
    || !Array.isArray(value.workPackages)
    || !Array.isArray(value.undergradTasks)
    || !Array.isArray(value.undergradThreads)
    || !Array.isArray(value.masterReservations)) {
    throw new Error("Invalid lab workflow response");
  }
  return value as unknown as LabWorkflow;
}

function piSessionId(meeting: GroupMeeting | null): string | null {
  return meeting?.members.find((member) => member.role === "pi")?.sessionId ?? null;
}

export function useLabWorkflow(meeting: GroupMeeting | null) {
  const [workflow, setWorkflow] = useState<LabWorkflow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const activeRef = useRef<{ cwd: string; meetingId: string; sessionId: string } | null>(null);

  const load = useCallback(async (currentMeeting: GroupMeeting, sessionId: string) => {
    const generation = ++generationRef.current;
    const request = { cwd: currentMeeting.cwd, meetingId: currentMeeting.meetingId, sessionId };
    activeRef.current = request;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/meetings/${encodeURIComponent(request.meetingId)}/workflow?cwd=${encodeURIComponent(request.cwd)}&sessionId=${encodeURIComponent(request.sessionId)}`,
        { cache: "no-store" },
      );
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(payload, response.status));
      const next = validateLabWorkflow(payload, currentMeeting);
      if (generation === generationRef.current) setWorkflow(next);
      return next;
    } catch (cause) {
      if (generation === generationRef.current) {
        setWorkflow(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return null;
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    const active = activeRef.current;
    return active && meeting && active.meetingId === meeting.meetingId && active.cwd === meeting.cwd
      ? load(meeting, active.sessionId)
      : Promise.resolve(null);
  }, [load, meeting]);

  useEffect(() => {
    const sessionId = piSessionId(meeting);
    if (!meeting || !sessionId) {
      generationRef.current += 1;
      activeRef.current = null;
      setWorkflow(null);
      setLoading(false);
      setError(null);
      return;
    }
    void load(meeting, sessionId);
    return () => { generationRef.current += 1; };
  }, [load, meeting]);

  const action = useCallback(async (nextAction: LabOrchestrateAction) => {
    const active = activeRef.current;
    if (!active || !meeting || active.meetingId !== meeting.meetingId || active.cwd !== meeting.cwd) {
      throw new Error("Lab workflow is unavailable");
    }
    setError(null);
    const response = await fetch(`/api/meetings/${encodeURIComponent(active.meetingId)}/workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: active.cwd, sessionId: active.sessionId, action: nextAction }),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const message = responseError(payload, response.status);
      setError(message);
      throw new Error(message);
    }
    const next = validateLabWorkflow(payload, meeting);
    setWorkflow(next);
    return await load(meeting, active.sessionId) ?? next;
  }, [load, meeting]);

  return { workflow, loading, error, refresh, action };
}
