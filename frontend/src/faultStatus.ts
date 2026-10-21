import type { WorkerFault } from "./types";

export function faultModeLabel(fault: WorkerFault): string {
  if (fault.mode === "fail") {
    return "decline";
  }
  if (fault.mode === "delay") {
    return `slow (${fault.delay_seconds}s)`;
  }
  return fault.mode;
}

export function hasAbnormalWorkerFaults(faults: WorkerFault[]): boolean {
  return faults.some((fault) => fault.mode !== "normal");
}

export function summarizeAbnormalFaults(faults: WorkerFault[]): string | null {
  const abnormal = faults.filter((fault) => fault.mode !== "normal");
  if (abnormal.length === 0) {
    return null;
  }
  return abnormal.map((fault) => `${fault.worker_id}: ${faultModeLabel(fault)}`).join("; ");
}

export function shortFaultSummary(faults: WorkerFault[]): string | null {
  const abnormal = faults.filter((fault) => fault.mode !== "normal");
  if (abnormal.length === 0) {
    return null;
  }
  const modes = new Set(abnormal.map((fault) => (fault.mode === "fail" ? "decline" : fault.mode === "delay" ? "slow" : fault.mode)));
  return [...modes].join(", ");
}
