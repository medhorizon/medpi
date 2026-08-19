import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderMessage(message, toolResults) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, toolResults }),
    ),
  );
}

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

function renderKernelResult(details) {
  return renderMessage(
    { role: "assistant", model: "test", provider: "test", content: [{ type: "toolCall", toolCallId: "kernel-call", toolName: "science_kernel", input: { code: details.code } }] },
    new Map([["kernel-call", { role: "toolResult", toolCallId: "kernel-call", content: [], details }]]),
  );
}

test("renders a successful Python notebook cell result", () => {
  const html = renderKernelResult({
    kind: "medpi.notebook-cell.v1",
    language: "python",
    kernelId: "python-1",
    cellId: "cell-7",
    executionCount: 7,
    status: "completed",
    code: "print(2 + 2)",
    stdout: "4\n",
    stderr: "",
    value: "4",
    startedAt: "2026-08-17T00:00:00.000Z",
    endedAt: "2026-08-17T00:00:01.250Z",
  });

  assert.match(html, /data-testid="notebook-cell-result"/);
  assert.match(html, /python/);
  assert.match(html, /#7/);
  assert.match(html, /completed/);
  assert.match(html, /1.3s/);
  assert.match(html, /print\(2 \+ 2\)/);
  assert.match(html, /stdout/);
  assert.match(html, /value/);
});

test("renders an R notebook cell error with stderr", () => {
  const html = renderKernelResult({
    kind: "medpi.notebook-cell.v1",
    language: "r",
    kernelId: "r-1",
    cellId: "cell-2",
    executionCount: 2,
    status: "error",
    code: "stop('bad input')",
    stdout: "",
    stderr: "Error: bad input",
    value: null,
    startedAt: 1_000,
    endedAt: 1_250,
  });

  assert.match(html, /r/);
  assert.match(html, /error/);
  assert.match(html, /250ms/);
  assert.match(html, /Error: bad input/);
});

test("escapes notebook cell content", () => {
  const html = renderKernelResult({
    kind: "medpi.notebook-cell.v1",
    language: "python",
    kernelId: "python-1",
    cellId: "cell-1",
    executionCount: 1,
    status: "completed",
    code: "<script>alert('code')</script>",
    stdout: "<img src=x onerror=alert(1)>",
    stderr: "<b>not html</b>",
    value: "<value>",
    startedAt: 1,
    endedAt: 2,
  });

  assert.doesNotMatch(html, /<script>|<img |<b>/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /&lt;img src=x onerror=alert/);
  assert.match(html, /&lt;b&gt;not html&lt;\/b&gt;/);
  assert.match(html, /&lt;value&gt;/);
});

test("falls back to the generic tool result for malformed notebook details", () => {
  const html = renderKernelResult({
    kind: "medpi.notebook-cell.v1",
    language: "python",
    kernelId: "python-1",
    cellId: "cell-1",
    executionCount: "1",
    status: "completed",
    code: "print(1)",
    stdout: "1",
    stderr: "",
    value: "1",
    startedAt: 1,
    endedAt: 2,
  });

  assert.match(html, /science_kernel/);
  assert.doesNotMatch(html, /data-testid="notebook-cell-result"/);
});

test("renders persisted historical notebook details", () => {
  const historicalDetails = JSON.parse(JSON.stringify({
    kind: "medpi.notebook-cell.v1",
    language: "python",
    kernelId: "python-history",
    cellId: "cell-history",
    executionCount: 12,
    status: "completed",
    code: "answer = 42",
    stdout: "",
    stderr: "",
    value: 42,
    startedAt: "2026-08-17T00:00:00.000Z",
    endedAt: "2026-08-17T00:00:00.010Z",
  }));

  const html = renderKernelResult(historicalDetails);
  assert.match(html, /#12/);
  assert.match(html, /answer = 42/);
  assert.match(html, /10ms/);
  assert.match(html, />42<\/pre>/);
});
