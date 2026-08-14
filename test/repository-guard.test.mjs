import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatFinding, scanRepository } from "../scripts/repository-guard.mjs";

test("finds credentials without printing their values", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nurix-adapter-guard-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = ["Real", "Credential", "Value", "7890"].join("");
  await writeFile(
    path.join(directory, "fixture.json"),
    JSON.stringify({ dataApiKey: candidate }),
  );

  const findings = await scanRepository(directory, ["fixture.json"]);
  assert.ok(findings.some((finding) => finding.id === "literal-json-secret"));
  assert.ok(
    findings.every((finding) => !formatFinding(finding).includes(candidate)),
  );
});

test("rejects ignored deployment artifacts when they are tracked", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nurix-adapter-guard-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "test-results"));
  await writeFile(
    path.join(directory, "test-results", "trace.zip"),
    "synthetic trace",
  );

  const findings = await scanRepository(directory, ["test-results/trace.zip"]);
  assert.ok(findings.some((finding) => finding.id === "banned-file"));
});
