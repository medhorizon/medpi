import assert from "node:assert/strict";
import test from "node:test";

const {
  applyModelSystemRoleToConfig,
  modelWouldEmitDeveloperRole,
} = await import("./meeting-model-role.ts");

function completionsModel(overrides = {}) {
  return {
    api: "openai-completions",
    reasoning: true,
    provider: "new-provider",
    id: "deepseek-v4-flash",
    cached: true,
    ...overrides,
  };
}

test("modelWouldEmitDeveloperRole: reasoning openai-completions with unknown Base URL emits developer", () => {
  assert.equal(modelWouldEmitDeveloperRole(completionsModel({ compat: undefined })), true);
  assert.equal(modelWouldEmitDeveloperRole(completionsModel({ compat: { supportsDeveloperRole: true } })), true);
});

test("modelWouldEmitDeveloperRole: explicit supportsDeveloperRole:false stays system", () => {
  assert.equal(
    modelWouldEmitDeveloperRole(completionsModel({ compat: { supportsDeveloperRole: false } })),
    false,
  );
});

test("modelWouldEmitDeveloperRole: non-reasoning or non-openai-completions models are left alone", () => {
  assert.equal(modelWouldEmitDeveloperRole(completionsModel({ reasoning: false })), false);
  assert.equal(modelWouldEmitDeveloperRole(completionsModel({ api: "openai-responses" })), false);
  assert.equal(modelWouldEmitDeveloperRole(completionsModel({ api: "anthropic-messages" })), false);
});

test("applyModelSystemRoleToConfig adds the flag and preserves other compat keys", () => {
  const config = {
    providers: {
      "new-provider": {
        models: [{ id: "deepseek-v4-flash", reasoning: true, compat: { thinkingFormat: "deepseek" } }],
      },
    },
  };
  const { config: next, action } = applyModelSystemRoleToConfig(config, "new-provider", "deepseek-v4-flash");
  assert.equal(action, "added");
  assert.deepEqual(next.providers["new-provider"].models[0].compat, {
    thinkingFormat: "deepseek",
    supportsDeveloperRole: false,
  });
});

test("applyModelSystemRoleToConfig is idempotent", () => {
  const config = {
    providers: {
      p: { models: [{ id: "m", compat: { supportsDeveloperRole: false } }] },
    },
  };
  const { action } = applyModelSystemRoleToConfig(config, "p", "m");
  assert.equal(action, "already_safe");
});

test("applyModelSystemRoleToConfig updates modelOverrides too", () => {
  const config = {
    providers: {
      p: {
        models: [{ id: "m", compat: { supportsDeveloperRole: true } }],
        modelOverrides: { m: { compat: {} } },
      },
    },
  };
  const { config: next, action } = applyModelSystemRoleToConfig(config, "p", "m");
  assert.equal(action, "added");
  assert.equal(next.providers.p.models[0].compat.supportsDeveloperRole, false);
  assert.equal(next.providers.p.modelOverrides.m.compat.supportsDeveloperRole, false);
});

test("applyModelSystemRoleToConfig reports not_found for unknown model", () => {
  const config = { providers: { p: { models: [{ id: "m" }] } } };
  const { action } = applyModelSystemRoleToConfig(config, "p", "missing");
  assert.equal(action, "not_found");
});
