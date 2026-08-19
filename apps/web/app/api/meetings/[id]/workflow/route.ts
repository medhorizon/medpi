import { NextResponse } from "next/server";
import { GroupMeetingError } from "@/lib/group-meeting-server";
import {
  bindLabWorkflowRuntime,
  LabWorkflowError,
  orchestrateLabWorkflow,
  readLabWorkflow,
} from "@/lib/lab-workflow";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

bindLabWorkflowRuntime();

function errorResponse(error: unknown): NextResponse {
  if (error instanceof LabWorkflowError || error instanceof GroupMeetingError) {
    const code = error.code;
    const status = code === "access_denied" || code === "project_untrusted" || code === "actor_forbidden" || code === "action_forbidden"
      ? 403
      : code === "meeting_not_found" ? 404
        : code === "invalid_cwd" || code === "invalid_meeting_id" || code === "invalid_action" ? 400
          : 409;
    return NextResponse.json({ error: error.message, code }, { status });
  }
  return NextResponse.json({ error: String(error) }, { status: 500 });
}

function requiredQuery(req: Request): { cwd: string; sessionId: string } | NextResponse {
  const params = new URL(req.url).searchParams;
  const cwd = params.get("cwd")?.trim() ?? "";
  const sessionId = params.get("sessionId")?.trim() ?? "";
  if (!cwd) return NextResponse.json({ error: "cwd is required", code: "invalid_cwd" }, { status: 400 });
  if (!sessionId) return NextResponse.json({ error: "sessionId is required", code: "invalid_session_id" }, { status: 400 });
  return { cwd, sessionId };
}

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request", code: "untrusted_request" }, { status: 403 });
  }
  const query = requiredQuery(req);
  if (query instanceof NextResponse) return query;
  try {
    const { id } = await context.params;
    return NextResponse.json(await readLabWorkflow({
      cwd: query.cwd,
      meetingId: id,
      actorSessionId: query.sessionId,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request", code: "untrusted_request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json", code: "invalid_content_type" }, { status: 415 });
  }
  let body: { cwd?: unknown; sessionId?: unknown; action?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", code: "invalid_json" }, { status: 400 });
  }
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!cwd) return NextResponse.json({ error: "cwd is required", code: "invalid_cwd" }, { status: 400 });
  if (!sessionId) return NextResponse.json({ error: "sessionId is required", code: "invalid_session_id" }, { status: 400 });
  if (body.action === undefined) return NextResponse.json({ error: "action is required", code: "invalid_action" }, { status: 400 });
  try {
    const { id } = await context.params;
    return NextResponse.json(await orchestrateLabWorkflow({
      cwd,
      meetingId: id,
      actorSessionId: sessionId,
      action: body.action,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
