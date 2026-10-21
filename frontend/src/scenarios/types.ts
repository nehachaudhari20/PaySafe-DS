import type { CaseDemonstration } from "./demonstration";
import type { Payment } from "../types";
import type { FlowNode, WorkerMode } from "../components/FlowDiagram";

export type CaseId = "normal" | "double" | "conflict" | "failed" | "unknown" | "leader";

export type CaseDefinition = {
  id: CaseId;
  title: string;
  summary: string;
  problem: string;
  breakIt: string;
  expect: string;
  verdict: string;
  requiresFaultInjection: boolean;
  showsReconcile?: boolean;
  showsElection?: boolean;
};

export type CaseInput = {
  amount: string;
  description: string;
};

export type CaseRunMode = "auto" | "guided";

export type CaseRunHooks = {
  onProgress?: (label: string, detail?: string) => void;
  onPayment?: (payment: Payment) => void;
  onDemonstration?: (demonstration: CaseDemonstration) => void;
  onFlowStep?: (label: string, activeNodes: FlowNode[], phase?: string) => void;
  /** Pause between duplicate submissions; resolve when the user continues or auto mode times out. */
  onInterruption?: (message: string) => Promise<void>;
  /** Guided mode: wait until the UI enables the next step button. */
  waitForGuidedStep?: (stepId: string) => Promise<void>;
  setWorkers?: (mode: WorkerMode) => void;
  setCrashed?: (id: number | null) => void;
  signal?: AbortSignal;
  runMode?: CaseRunMode;
  /** Live demo uses fixed demo amounts; interactive mode uses user input. */
  useDemoAmounts?: boolean;
};

export type CaseRunResult = {
  ok: boolean;
  payment: Payment | null;
  conflict409?: boolean;
  message?: string;
  restoreWarning?: string;
  demonstration?: CaseDemonstration;
};

export type LiveDemoContext = {
  step: (label: string, at: FlowNode[], action: () => Promise<string | void>) => Promise<void>;
  wait: (seconds: number | (() => number), label: string, at: FlowNode[]) => Promise<void>;
  showPayment: (payment: Payment) => void;
  setCrashed: (id: number | null) => void;
  setWorkers: (mode: WorkerMode) => void;
};

export type LiveDemoScenario = CaseDefinition & {
  run: (ctx: LiveDemoContext) => Promise<void>;
};
