import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const allowedEnvironmentFiles = new Set([".env.example"]);
const bannedExtensions = new Set([
  ".har",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
  ".sqlite",
  ".tfplan",
  ".tfstate",
  ".webm",
  ".zip",
]);
const bannedDirectoryPrefixes = [
  "blob-report/",
  "playwright-report/",
  "test-results/",
];
const secretNames =
  "NURIX_DATA_API_KEY|NURIX_GATEWAY_API_KEY|GATEWAY_SHARED_SECRET|DIGITALOCEAN_ACCESS_TOKEN|data-api-key|data-gateway-api-key|dataApiKey|gatewayApiKey|apiKey|accessToken|clientSecret|password";
const assignmentPattern = new RegExp(
  String.raw`^\s*["']?(?:${secretNames})["']?\s*(?:=|:)\s*(.*?)\s*[,;]?\s*$`,
  "i",
);
const yamlSecretKeyPattern = new RegExp(
  String.raw`^\s*-?\s*key:\s*(?:${secretNames})\s*$`,
  "i",
);
const inlineJsonSecretPattern = new RegExp(
  String.raw`["'](?:${secretNames})["']\s*:\s*["'](?!__|<|\$\{)(?![^"']*(?:sentinel|placeholder|test-|fake))[A-Za-z0-9._-]{8,}["']`,
  "i",
);
const contentRules = [
  { id: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    id: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  { id: "digitalocean-token", pattern: /\bdop_v1_[A-Za-z0-9]{40,}\b/ },
  {
    id: "literal-bearer",
    pattern:
      /Authorization\s*[:=]\s*[`"']?Bearer\s+(?!\$\{|<|__|test-|fake|[^\s"']*sentinel)[A-Za-z0-9._-]{8,}/i,
  },
  {
    id: "credential-query",
    pattern:
      /[?&](?:api_key|token|secret)=(?!\$\{|<|__|test-|fake)[A-Za-z0-9._-]{8,}/i,
  },
  {
    id: "vendor-credential-attribute",
    pattern:
      /(?:data-api-key|data-gateway-api-key|widgetApiKey|gatewayApiKey)\s*[:=]\s*["'](?!__|<|\$\{)(?![^"']*(?:sentinel|placeholder|test-|fake))[A-Za-z0-9._-]{8,}["']/i,
  },
  { id: "literal-json-secret", pattern: inlineJsonSecretPattern },
  { id: "nurix-shaped-hex", pattern: /\b[0-9a-f]{32}\b/i },
];

export const listRepositoryFiles = (repositoryRoot) => {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, encoding: "buffer" },
  );
  return output.toString("utf8").split("\0").filter(Boolean);
};

export const scanRepository = async (repositoryRoot, filePaths) => {
  const findings = [];

  for (const suppliedPath of filePaths) {
    const relativePath = suppliedPath.replaceAll("\\", "/");
    const filePath = path.resolve(repositoryRoot, suppliedPath);
    const basename = path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();

    if (isBannedPath(relativePath, basename, extension)) {
      findings.push({ id: "banned-file", path: relativePath, line: 1 });
      continue;
    }

    const fileStats = await stat(filePath);
    if (fileStats.size > 2_000_000) {
      findings.push({ id: "oversized-file", path: relativePath, line: 1 });
      continue;
    }

    const buffer = await readFile(filePath);
    if (buffer.includes(0)) {
      findings.push({ id: "binary-file", path: relativePath, line: 1 });
      continue;
    }

    const lines = buffer.toString("utf8").split(/\r?\n/);
    let awaitingYamlSecretValue = false;
    lines.forEach((line, index) => {
      if (yamlSecretKeyPattern.test(line)) {
        awaitingYamlSecretValue = true;
      } else if (awaitingYamlSecretValue) {
        const yamlValue = line.match(/^\s*value:\s*(.*?)\s*$/i);
        if (yamlValue) {
          if (!isSafeAssignmentValue(yamlValue[1] ?? "", extension))
            findings.push({
              id: "literal-secret-assignment",
              path: relativePath,
              line: index + 1,
            });
          awaitingYamlSecretValue = false;
        } else if (/^\s*-?\s*key:/i.test(line)) {
          awaitingYamlSecretValue = false;
        }
      }

      const assignment = line.match(assignmentPattern);
      if (assignment && !isSafeAssignmentValue(assignment[1] ?? "", extension))
        findings.push({
          id: "literal-secret-assignment",
          path: relativePath,
          line: index + 1,
        });

      for (const rule of contentRules) {
        if (rule.pattern.test(line))
          findings.push({ id: rule.id, path: relativePath, line: index + 1 });
      }
    });
  }

  return findings;
};

export const formatFinding = (finding) =>
  `${finding.id}: ${finding.path}:${finding.line}`;

const isBannedPath = (relativePath, basename, extension) =>
  basename === ".env" ||
  (basename.startsWith(".env.") && !allowedEnvironmentFiles.has(basename)) ||
  bannedExtensions.has(extension) ||
  bannedDirectoryPrefixes.some((prefix) => relativePath.startsWith(prefix)) ||
  basename.startsWith("terraform.tfstate") ||
  basename.endsWith(".tfstate.backup") ||
  basename === "run-manifest.json";

const isSafeAssignmentValue = (rawValue, extension) => {
  const trimmedValue = rawValue.trim();
  const firstCharacter = trimmedValue.at(0);
  const wasQuoted =
    firstCharacter === '"' || firstCharacter === "'" || firstCharacter === "`";
  const value =
    wasQuoted && trimmedValue.endsWith(firstCharacter)
      ? trimmedValue.slice(1, -1)
      : trimmedValue;

  const isSourceFile = [".js", ".mjs", ".ts", ".tsx"].includes(extension);
  if (isSourceFile && !wasQuoted) return true;
  if (!value) return true;
  if (/^(?:__[^\s]+__|<[^\s]+>|\$\{.*\}|replace-[^\s]+)$/i.test(value))
    return true;
  if (/(?:sentinel|placeholder|test-|fake)/i.test(value)) return true;
  return false;
};
