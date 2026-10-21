import type { FlowNode } from "../components/FlowDiagram";
import type { CoordinatorLeadership, ElectionEvent, Payment, PaymentEvent } from "../types";
import type { CaseId } from "./types";

export type IdempotencyOutcome = "created" | "replayed" | "conflict";

export type CaseRequestRecord = {
  label: string;
  idempotencyKey: string;
  amount: string;
  description: string;
  payment: Payment;
  events: PaymentEvent[];
  dispatchEventCount: number;
  flowPath?: FlowNode[];
  idempotencyOutcome?: IdempotencyOutcome;
};

export type CaseConflictRecord = {
  idempotencyKey: string;
  firstAmount: string;
  secondAmount: string;
  description: string;
  firstPayment: Payment;
  firstEvents: PaymentEvent[];
  httpStatus: number;
  httpMessage: string;
  firstFlowPath?: FlowNode[];
  secondFlowPath?: FlowNode[];
};

export type CaseLeadershipRecord = {
  before: CoordinatorLeadership;
  afterCrash: CoordinatorLeadership;
  final: CoordinatorLeadership;
  crashedLeaderId: number;
  electionEvents: ElectionEvent[];
  payment: Payment;
  paymentEvents: PaymentEvent[];
};

export type CaseUnknownRecord = {
  uncertainPayment: Payment;
  uncertainEvents: PaymentEvent[];
  reconciledPayment: Payment;
  reconciledEvents: PaymentEvent[];
  workerDelaySeconds: number;
  rpcTimeoutSeconds: number;
};

export type CaseFailedRecord = {
  workerMode: string;
  payment: Payment;
  events: PaymentEvent[];
};

export type CaseDemonstration = {
  caseId: CaseId;
  requests?: CaseRequestRecord[];
  conflict?: CaseConflictRecord;
  leadership?: CaseLeadershipRecord;
  unknown?: CaseUnknownRecord;
  failed?: CaseFailedRecord;
  normal?: { payment: Payment; events: PaymentEvent[] };
  narrative: string[];
};

export function dispatchEventCount(events: PaymentEvent[]): number {
  return events.filter((event) => event.event_type === "ATTEMPT_STARTED" || event.event_type === "WORKER_SELECTED").length;
}

export function hasIdempotencyReplay(events: PaymentEvent[]): boolean {
  return events.some((event) => event.event_type === "IDEMPOTENCY_REPLAYED");
}

export function hasIdempotencyConflict(events: PaymentEvent[]): boolean {
  return events.some((event) => event.event_type === "IDEMPOTENCY_PAYLOAD_CONFLICT");
}

export function formatFlowPath(path: FlowNode[] | undefined): string {
  if (!path?.length) {
    return "";
  }
  const labels: Record<FlowNode, string> = {
    you: "You",
    api: "API",
    leader: "Leader",
    worker: "Worker",
    db: "Database",
  };
  return path.map((node) => labels[node]).join(" → ");
}

export function shortenKey(key: string): string {
  if (key.length <= 20) {
    return key;
  }
  return `${key.slice(0, 10)}…${key.slice(-6)}`;
}
