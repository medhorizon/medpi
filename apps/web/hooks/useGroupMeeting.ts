"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GROUP_MEETING_ROSTER,
  type GroupMeeting,
  type GroupMeetingMemberSettings,
  type GroupMeetingThinkingLevel,
} from "@/lib/group-meeting";

const THINKING_LEVELS = new Set<GroupMeetingThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(payload: unknown, status: number): string {
  return isRecord(payload) && typeof payload.error === "string"
    ? payload.error
    : `Meeting request failed (HTTP ${status})`;
}

/** Reject malformed or cross-project data instead of guessing a repair. */
export function validateGroupMeeting(value: unknown, expectedCwd: string): GroupMeeting {
  if (!isRecord(value)
    || typeof value.meetingId !== "string"
    || typeof value.createdAt !== "string"
    || value.cwd !== expectedCwd
    || typeof value.projectRoot !== "string"
    || (value.status !== "creating" && value.status !== "ready" && value.status !== "failed")
    || !Array.isArray(value.members)
    || value.members.length !== GROUP_MEETING_ROSTER.length
    || (value.error !== undefined && typeof value.error !== "string")) {
    throw new Error("Invalid group meeting response");
  }

  const sessionIds = new Set<string>();
  for (let index = 0; index < GROUP_MEETING_ROSTER.length; index += 1) {
    const member = value.members[index];
    const expected = GROUP_MEETING_ROSTER[index];
    if (!isRecord(member)
      || member.role !== expected.role
      || typeof member.label !== "string"
      || (member.status !== "creating" && member.status !== "ready" && member.status !== "failed")
      || (member.sessionId !== null && typeof member.sessionId !== "string")
      || (member.provider !== null && typeof member.provider !== "string")
      || (member.modelId !== null && typeof member.modelId !== "string")
      || (member.thinkingLevel !== null && (typeof member.thinkingLevel !== "string" || !THINKING_LEVELS.has(member.thinkingLevel as GroupMeetingThinkingLevel)))
      || (member.error !== undefined && typeof member.error !== "string")) {
      throw new Error("Invalid group meeting member response");
    }
    if (member.sessionId) {
      if (sessionIds.has(member.sessionId)) throw new Error("Duplicate group meeting session");
      sessionIds.add(member.sessionId);
    }
    if (value.status === "ready" && (
      member.status !== "ready"
      || !member.sessionId
      || !member.provider
      || !member.modelId
      || !member.thinkingLevel
    )) {
      throw new Error("Ready group meeting has an incomplete member");
    }
  }

  return value as unknown as GroupMeeting;
}

export function validateGroupMeetingList(value: unknown, expectedCwd: string): GroupMeeting[] {
  if (!isRecord(value) || !Array.isArray(value.meetings)) {
    throw new Error("Invalid group meeting list response");
  }
  return value.meetings.map((meeting) => validateGroupMeeting(meeting, expectedCwd));
}

export function useGroupMeeting(cwd: string | null, meetingId: string | null = null) {
  const [meeting, setMeeting] = useState<GroupMeeting | null>(null);
  const [loading, setLoading] = useState(Boolean(cwd && meetingId));
  const [creating, setCreating] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const openingRef = useRef(false);
  const configuringRef = useRef(false);
  const deletingRef = useRef(false);

  const activeMeetingIdRef = useRef<string | null>(meetingId);

  const loadMeeting = useCallback(async (requestedMeetingId: string) => {
    const normalizedId = requestedMeetingId.trim();
    if (!cwd || !normalizedId) {
      setMeeting(null);
      setLoading(false);
      setError(!normalizedId ? "Meeting id is required" : "Project cwd is required to load a meeting");
      return null;
    }
    const generation = ++generationRef.current;
    activeMeetingIdRef.current = normalizedId;
    setMeeting((current) => (current?.meetingId === normalizedId ? current : null));
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/meetings/${encodeURIComponent(normalizedId)}?cwd=${encodeURIComponent(cwd)}`,
        { cache: "no-store" },
      );
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(payload, response.status));
      const restored = validateGroupMeeting(payload, cwd);
      if (restored.meetingId !== normalizedId) throw new Error("Meeting id does not match the requested meeting");
      if (generation === generationRef.current) setMeeting(restored);
      return restored;
    } catch (cause) {
      if (generation === generationRef.current) setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [cwd]);

  const refresh = useCallback(() => {
    const activeMeetingId = activeMeetingIdRef.current;
    return activeMeetingId ? loadMeeting(activeMeetingId) : Promise.resolve(null);
  }, [loadMeeting]);

  useEffect(() => {
    if (cwd && meetingId) {
      void loadMeeting(meetingId);
    } else {
      generationRef.current += 1;
      activeMeetingIdRef.current = null;
      setMeeting(null);
      setLoading(false);
      setError(meetingId && !cwd ? "Project cwd is required to load a meeting" : null);
    }
    return () => { generationRef.current += 1; };
  }, [cwd, meetingId, loadMeeting]);

  const openMeeting = useCallback(async () => {
    if (!cwd || openingRef.current) return null;
    openingRef.current = true;
    const generation = ++generationRef.current;
    setLoading(false);
    setCreating(true);
    setError(null);
    try {
      const listResponse = await fetch(`/api/meetings?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const listPayload: unknown = await listResponse.json();
      if (!listResponse.ok) throw new Error(responseError(listPayload, listResponse.status));
      const existing = validateGroupMeetingList(listPayload, cwd)
        .find((candidate) => candidate.status === "ready");
      if (existing) {
        if (generation === generationRef.current) {
          activeMeetingIdRef.current = existing.meetingId;
          setMeeting(existing);
        }
        return existing;
      }

      const response = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const payload: unknown = await response.json();
      const failedCandidate = isRecord(payload) && "meeting" in payload ? payload.meeting : null;
      if (!response.ok) {
        const failedMeeting = isRecord(failedCandidate)
          ? validateGroupMeeting(failedCandidate, cwd)
          : null;
        if (generation === generationRef.current && failedMeeting) {
          activeMeetingIdRef.current = failedMeeting.meetingId;
          setMeeting(failedMeeting);
        }
        throw new Error(responseError(payload, response.status));
      }
      const nextMeeting = isRecord(payload) ? validateGroupMeeting(payload, cwd) : null;
      if (generation === generationRef.current && nextMeeting) {
        activeMeetingIdRef.current = nextMeeting.meetingId;
        setMeeting(nextMeeting);
      }
      if (!nextMeeting) throw new Error("Invalid group meeting response");
      return nextMeeting;
    } catch (cause) {
      if (generation === generationRef.current) setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      openingRef.current = false;
      if (generation === generationRef.current) setCreating(false);
    }
  }, [cwd]);

  const leaveMeeting = useCallback(() => {
    generationRef.current += 1;
    activeMeetingIdRef.current = null;
    setMeeting(null);
    setError(null);
    setLoading(false);
    setCreating(false);
  }, []);

  const updateMeetingSettings = useCallback(async (members: GroupMeetingMemberSettings[]) => {
    if (!cwd || !meeting || configuringRef.current) return null;
    configuringRef.current = true;
    setConfiguring(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/meetings/${encodeURIComponent(meeting.meetingId)}?cwd=${encodeURIComponent(cwd)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ members }),
        },
      );
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(payload, response.status));
      const updated = validateGroupMeeting(payload, cwd);
      setMeeting(updated);
      return updated;
    } catch (cause) {
      const nextError = cause instanceof Error ? cause.message : String(cause);
      setError(nextError);
      throw new Error(nextError);
    } finally {
      configuringRef.current = false;
      setConfiguring(false);
    }
  }, [cwd, meeting]);

  const deleteMeeting = useCallback(async () => {
    if (!cwd || !meeting || deletingRef.current) return false;
    deletingRef.current = true;
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/meetings/${encodeURIComponent(meeting.meetingId)}?cwd=${encodeURIComponent(cwd)}`,
        { method: "DELETE" },
      );
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(payload, response.status));
      generationRef.current += 1;
      activeMeetingIdRef.current = null;
      setMeeting(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }, [cwd, meeting]);

  return {
    meeting,
    loading,
    creating,
    configuring,
    deleting,
    error,
    loadMeeting,
    refresh,
    openMeeting,
    leaveMeeting,
    deleteMeeting,
    updateMeetingSettings,
  };
}
