import type { Theme } from "@earendil-works/pi-coding-agent";

interface ActivityCounts {
  running: number;
  done: number;
  cancelled: number;
  failed: number;
}

export function formatActivityStatus(theme: Theme, counts: ActivityCounts) {
  const parts: string[] = [];
  if (counts.running > 0) {
    parts.push(theme.fg("warning", `■ ${counts.running} answering`));
  }
  if (counts.done > 0) {
    parts.push(theme.fg("success", `■ ${counts.done} answered`));
  }
  if (counts.cancelled > 0) {
    parts.push(theme.fg("muted", `■ ${counts.cancelled} cancelled`));
  }
  if (counts.failed > 0) {
    parts.push(theme.fg("error", `■ ${counts.failed} failed`));
  }
  parts.push(theme.fg("accent", "/btws") + theme.fg("dim", " to view"));
  return `${theme.fg("muted", "btw:")} ${parts.join(theme.fg("dim", " · "))}`;
}
