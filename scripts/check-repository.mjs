import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatFinding,
  listRepositoryFiles,
  scanRepository,
} from "./repository-guard.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const findings = await scanRepository(
  repositoryRoot,
  listRepositoryFiles(repositoryRoot),
);

if (findings.length > 0) {
  for (const finding of findings) console.error(formatFinding(finding));
  process.exitCode = 1;
} else {
  console.log("Repository secret guard passed");
}
