"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GROUP_MEETING_ROSTER,
  type GroupMeeting,
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

export function useGroupMeeting(cwd: string | null, meetingId: string | null = null) {
  const [meeting, setMeeting] = useState<GroupMeeting | null>(null);
  const [loading, setLoading] = useState(Boolean(cwd && meetingId));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const creatingRef = useRef(false);

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
    setMeeting(null);
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

  const createMeeting = useCallback(async () => {
    if (!cwd || creatingRef.current) return null;
    creatingRef.current = true;
    const generation = ++generationRef.current;
    setLoading(false);
    setCreating(true);
    setError(null);
    try {
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
      creatingRef.current = false;
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

  return { meeting, loading, creating, error, loadMeeting, refresh, createMeeting, leaveMeeting };
}
