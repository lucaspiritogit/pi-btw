import { execFileSync } from "node:child_process";

const bump = process.argv[2] ?? "patch";
const notesIndex = process.argv.indexOf("--notes");
const notes = notesIndex >= 0 ? process.argv.slice(notesIndex + 1).join(" ").trim() : "";

if (!["patch", "minor", "major"].includes(bump)) {
  console.error(`Invalid bump "${bump}". Use patch, minor, or major.`);
  process.exit(1);
}

const argumentsList = [
  "workflow",
  "run",
  "release.yml",
  "--ref",
  "main",
  "--field",
  `version_bump=${bump}`,
];
if (notes) argumentsList.push("--field", `release_notes=${notes}`);
execFileSync("gh", argumentsList, { stdio: "inherit" });
console.log("Release workflow queued on main.");
