import { NextResponse } from "next/server";
import { LabMessageError, sendLabMessage } from "@/lib/lab-message-server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function statusFor(error: LabMessageError): number {
  if (error.code === "meeting_not_found") return 404;
  if (error.code === "sender_not_allowed" || error.code === "recipient_not_allowed") return 403;
  return 400;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    if (!isApiRequestAllowed(req)) {
      return NextResponse.json({ error: "Untrusted API request", code: "untrusted_request" }, { status: 403 });
    }
    if (!hasJsonContentType(req)) {
      return NextResponse.json({ error: "Content-Type must be application/json", code: "invalid_content_type" }, { status: 415 });
    }
    let body: {
      cwd?: unknown;
      fromSessionId?: unknown;
      toRoles?: unknown;
      body?: unknown;
      replyTo?: unknown;
    };
    try {
      body = await req.json() as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body", code: "invalid_json" }, { status: 400 });
    }
    const { id: meetingId } = await context.params;
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const senderSessionId = typeof body.fromSessionId === "string" ? body.fromSessionId.trim() : "";
    const idempotencyKey = req.headers.get("idempotency-key")?.trim();
    if (!cwd || !senderSessionId) {
      return NextResponse.json({ error: "cwd and fromSessionId are required", code: "invalid_request" }, { status: 400 });
    }
    return NextResponse.json(await sendLabMessage({
      cwd,
      meetingId,
      senderSessionId,
      toRoles: Array.isArray(body.toRoles) ? body.toRoles as string[] : [],
      body: typeof body.body === "string" ? body.body : "",
      ...(typeof body.replyTo === "string" ? { replyTo: body.replyTo } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }), { status: 201 });
  } catch (error) {
    if (error instanceof LabMessageError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: statusFor(error) });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
