import { useCallback, useRef, useState } from "react";
import { fetchPayment, reconcile } from "../api";
import { hasAbnormalWorkerFaults, summarizeAbnormalFaults } from "../faultStatus";
import {
  CASE_DEFINITIONS,
  conflictAlternateAmount,
  getCaseDefinition,
  runCase,
  setAllWorkers,
  DOUBLE_RETRY_PAUSE_MS,
  type CaseId,
} from "../scenarios";
import type { CaseDemonstration } from "../scenarios/demonstration";
import type { CaseRunMode } from "../scenarios/types";
import type { CoordinatorLeadership, Payment, WorkerFault, WorkersHealthResponse } from "../types";
import { CaseDemonstrationPanel } from "./CaseDemonstrationPanel";
import { FlowDiagram, type FlowNode, type WorkerMode } from "./FlowDiagram";
import { Button, Card } from "./ui";

type ProgressStep = { label: string; detail?: string; state: "running" | "done" | "error" };

const BUILD_STAMP = import.meta.env.VITE_BUILD_TIME ?? "dev";

const GUIDED_LABELS: Record<string, string> = {
  "double-first": "Send first payment",
  "double-second": "Send duplicate request (same key & payload)",
  "conflict-first": "Send first payment",
  "conflict-second": "Send conflicting request (same key, different amount)",
};

export function InteractivePaymentCases({
  amount,
  description,
  faultInjectionEnabled,
  workerFaults,
  faultsError,
  leadership,
  health,
  onFaultsChange,
  disabled,
  onPayment,
  onChanged,
  onRunningChange,
  onCaseDemonstration,
  onTeachingActive,
  onActiveCaseChange,
}: {
  amount: string;
  description: string;
  faultInjectionEnabled: boolean;
  workerFaults: WorkerFault[];
  faultsError: string;
  leadership: CoordinatorLeadership | null;
  health: WorkersHealthResponse | null;
  onFaultsChange: () => void;
  disabled: boolean;
  onPayment: (payment: Payment | null, message?: string, tone?: "ok" | "error" | "warning") => void;
  onChanged: () => void;
  onRunningChange: (running: boolean) => void;
  onCaseDemonstration: (demonstration: CaseDemonstration | null, transactionId: string | null) => void;
  onTeachingActive: (active: boolean) => void;
  onActiveCaseChange: (caseId: CaseId) => void;
}) {
  const [activeId, setActiveId] = useState<CaseId>("normal");
  const [runMode, setRunMode] = useState<CaseRunMode>("auto");
  const [demonstration, setDemonstration] = useState<CaseDemonstration | null>(null);
  const [running, setRunning] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [steps, setSteps] = useState<ProgressStep[]>([]);
  const [finished, setFinished] = useState<"ok" | "error" | "stopped" | null>(null);
  const [lastPayment, setLastPayment] = useState<Payment | null>(null);
  const [activeNodes, setActiveNodes] = useState<FlowNode[]>([]);
  const [flowLabel, setFlowLabel] = useState<string | null>(null);
  const [workerDiagramMode, setWorkerDiagramMode] = useState<WorkerMode>("ok");
  const [crashedLeader, setCrashedLeader] = useState<number | null>(null);
  const [guidedWaiting, setGuidedWaiting] = useState<string | null>(null);
  const [interruption, setInterruption] = useState<{ message: string; resolve: () => void } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const guidedContinueRef = useRef<(() => void) | null>(null);
  const interruptionTimerRef = useRef<number | null>(null);

  const definition = getCaseDefinition(activeId);
  const caseBlocked = definition.requiresFaultInjection && !faultInjectionEnabled;
  const alternateAmount = conflictAlternateAmount(amount.trim() || "25.00");
  const abnormalSummary = summarizeAbnormalFaults(workerFaults);
  const workersNotNormal = faultInjectionEnabled && hasAbnormalWorkerFaults(workerFaults);
  const steppedCase = activeId === "double" || activeId === "conflict";

  function resetProgress() {
    setSteps([]);
    setFinished(null);
    setDemonstration(null);
    setActiveNodes([]);
    setFlowLabel(null);
    setGuidedWaiting(null);
    setInterruption(null);
    setCrashedLeader(null);
    setWorkerDiagramMode("ok");
    onCaseDemonstration(null, null);
    onTeachingActive(false);
  }

  function primaryTransactionId(demo: CaseDemonstration | undefined, payment: Payment | null): string | null {
    if (!demo) {
      return payment?.transaction_id ?? null;
    }
    if (demo.conflict) {
      return demo.conflict.firstPayment.transaction_id;
    }
    if (demo.unknown) {
      return demo.unknown.reconciledPayment.transaction_id;
    }
    if (demo.leadership) {
      return demo.leadership.payment.transaction_id;
    }
    if (demo.failed) {
      return demo.failed.payment.transaction_id;
    }
    if (demo.normal) {
      return demo.normal.payment.transaction_id;
    }
    if (demo.requests?.length) {
      return demo.requests[0].payment.transaction_id;
    }
    return payment?.transaction_id ?? null;
  }

  const continueGuided = useCallback(() => {
    guidedContinueRef.current?.();
    guidedContinueRef.current = null;
    setGuidedWaiting(null);
  }, []);

  const continueInterruption = useCallback(() => {
    if (interruptionTimerRef.current != null) {
      window.clearTimeout(interruptionTimerRef.current);
      interruptionTimerRef.current = null;
    }
    interruption?.resolve();
    setInterruption(null);
  }, [interruption]);

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    continueInterruption();
    continueGuided();
  }

  async function handleResetWorkers() {
    setResetting(true);
    try {
      await setAllWorkers("normal");
      onFaultsChange();
      setWorkerDiagramMode("ok");
      onPayment(null, "Workers reset to normal.", "ok");
    } catch (error) {
      onPayment(null, error instanceof Error ? error.message : "Could not reset workers.", "error");
    } finally {
      setResetting(false);
    }
  }

  async function handleRunCase() {
    if (!amount.trim() || !description.trim()) {
      onPayment(null, "Enter an amount and description before running a case.", "error");
      return;
    }
    if (caseBlocked) {
      return;
    }

    resetProgress();
    setDemonstration(null);
    setRunning(true);
    onRunningChange(true);
    onTeachingActive(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let stepIndex = -1;

    const updateStep = (index: number, patch: Partial<ProgressStep>) => {
      setSteps((list) => list.map((item, i) => (i === index ? { ...item, ...patch } : item)));
    };

    const result = await runCase(
      activeId,
      { amount: amount.trim(), description: description.trim() },
      {
        signal: controller.signal,
        runMode,
        onProgress: (label, detail) => {
          if (controller.signal.aborted) {
            return;
          }
          setSteps((list) => {
            const runningIndex = list.findIndex((item) => item.state === "running");
            if (runningIndex >= 0) {
              return list.map((item, i) => (i === runningIndex ? { ...item, state: "done" as const, detail: item.detail ?? detail } : item));
            }
            return list;
          });
          stepIndex += 1;
          const mine = stepIndex;
          setSteps((list) => [...list, { label, detail, state: "running" }]);
          if (detail) {
            window.setTimeout(() => updateStep(mine, { detail }), 0);
          }
        },
        onPayment: (payment) => {
          setLastPayment(payment);
          onPayment(payment);
        },
        onDemonstration: (live) => {
          setDemonstration(live);
          onCaseDemonstration(live, primaryTransactionId(live, null));
        },
        onFlowStep: (label, nodes) => {
          setFlowLabel(label);
          setActiveNodes(nodes);
        },
        onInterruption:
          runMode === "auto"
            ? (message) =>
                new Promise<void>((resolve) => {
                  setInterruption({ message, resolve });
                  interruptionTimerRef.current = window.setTimeout(() => {
                    interruptionTimerRef.current = null;
                    setInterruption(null);
                    resolve();
                  }, DOUBLE_RETRY_PAUSE_MS);
                })
            : undefined,
        waitForGuidedStep: (stepId) =>
          new Promise<void>((resolve) => {
            setGuidedWaiting(stepId);
            guidedContinueRef.current = resolve;
          }),
        setWorkers: (mode) => setWorkerDiagramMode(mode),
        setCrashed: (id) => setCrashedLeader(id),
      },
    );

    onFaultsChange();
    setGuidedWaiting(null);
    setInterruption(null);
    setActiveNodes([]);

    if (result.demonstration) {
      setDemonstration(result.demonstration);
      onCaseDemonstration(result.demonstration, primaryTransactionId(result.demonstration, result.payment));
    }

    if (controller.signal.aborted) {
      setFinished("stopped");
      onPayment(lastPayment, "Case stopped. Workers were reset to normal.", "warning");
      onTeachingActive(false);
    } else if (result.ok && !result.restoreWarning) {
      setSteps((list) => list.map((item) => (item.state === "running" ? { ...item, state: "done" } : item)));
      if (result.payment) {
        setLastPayment(result.payment);
        onPayment(
          result.payment,
          result.message,
          result.payment.status === "FAILED"
            ? "error"
            : result.payment.status === "UNKNOWN" || result.payment.reconciliation_required
              ? "warning"
              : "ok",
        );
      } else if (result.conflict409) {
        onPayment(lastPayment, result.message, "ok");
      }
      setFinished("ok");
    } else if (result.ok && result.restoreWarning) {
      setFinished("error");
      onPayment(result.payment ?? lastPayment, result.message, "warning");
    } else {
      setSteps((list) =>
        list.map((item, i) =>
          i === list.length - 1 && item.state === "running" ? { ...item, state: "error", detail: result.message } : item,
        ),
      );
      onPayment(result.payment ?? lastPayment, result.message ?? "The case did not complete as expected.", "error");
      setFinished("error");
      onTeachingActive(false);
    }

    abortRef.current = null;
    setRunning(false);
    onRunningChange(false);
    onChanged();
  }

  async function handleReconcile() {
    if (!lastPayment) {
      return;
    }
    setRunning(true);
    onRunningChange(true);
    try {
      await reconcile();
      const latest = await fetchPayment(lastPayment.transaction_id);
      setLastPayment(latest);
      onPayment(
        latest,
        latest.status === "UNKNOWN"
          ? "Reconciliation ran, but this payment is still UNKNOWN."
          : `Reconciliation updated ${latest.transaction_id} to ${latest.status}.`,
        latest.status === "UNKNOWN" ? "warning" : "ok",
      );
      onChanged();
    } catch (error) {
      onPayment(lastPayment, error instanceof Error ? error.message : "Reconciliation failed.", "error");
    } finally {
      setRunning(false);
      onRunningChange(false);
    }
  }

  const showDiagram = running || Boolean(demonstration) || Boolean(interruption) || Boolean(guidedWaiting);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          Use <span className="font-medium text-slate-900">Run case</span> — not manual Pay — to run the teaching scenario against the live API.
        </p>
        <p className="text-xs text-slate-400">UI build: {BUILD_STAMP}</p>
      </div>

      {workersNotNormal && abnormalSummary && (
        <div className="flex flex-col gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950 ring-1 ring-amber-200 sm:flex-row sm:items-center sm:justify-between">
          <p>
            Workers are in test mode ({abnormalSummary}). Payments will fail or behave oddly until you reset them.
          </p>
          <Button variant="primary" disabled={resetting || running} onClick={() => void handleResetWorkers()}>
            {resetting ? "Resetting…" : "Reset workers to Normal"}
          </Button>
        </div>
      )}

      {faultsError && (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200">{faultsError}</p>
      )}

      {caseBlocked && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          This case needs development fault injection. Start the stack with FAULT_INJECTION_ENABLED=true to run it.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
        <nav className="space-y-1.5" aria-label="Payment cases">
          <p className="px-1 pb-1 text-xs font-medium text-slate-500">Teaching cases</p>
          {CASE_DEFINITIONS.map((item, number) => {
            const selected = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                disabled={running}
                onClick={() => {
                  setActiveId(item.id);
                  onActiveCaseChange(item.id);
                  resetProgress();
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  selected ? "bg-indigo-600 text-white shadow-sm disabled:opacity-100" : "bg-white text-slate-700 ring-1 ring-slate-200 hover:ring-indigo-300"
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    selected ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {number + 1}
                </span>
                <span className="text-sm font-medium">{item.title}</span>
              </button>
            );
          })}
        </nav>

        <div className="space-y-4">
          <Card title={definition.title}>
            <p className="text-sm text-slate-600">{definition.summary}</p>
            <div className="mt-3 rounded-xl bg-emerald-50 p-3 ring-1 ring-emerald-100">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Expected outcome</p>
              <p className="mt-1 text-sm text-slate-700">{definition.expect}</p>
            </div>
            {activeId === "conflict" && (
              <p className="mt-3 text-xs text-slate-500">
                The first request uses your amount ({amount.trim() || "…"}). The second reuses the same request ID with amount{" "}
                {alternateAmount} to trigger HTTP 409.
              </p>
            )}
            {activeId === "double" && (
              <p className="mt-3 text-xs text-slate-500">
                Both submissions use your amount and description with one shared request ID.
              </p>
            )}
            {activeId === "unknown" && (
              <p className="mt-3 text-xs text-slate-500">
                UNKNOWN means unconfirmed, not failed. This case runs reconciliation automatically after workers recover.
              </p>
            )}

            {steppedCase && (
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="text-xs font-medium text-slate-600">Run style:</span>
                <button
                  type="button"
                  disabled={running}
                  onClick={() => setRunMode("guided")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${
                    runMode === "guided" ? "bg-indigo-600 text-white ring-indigo-600" : "bg-white text-slate-700 ring-slate-200"
                  }`}
                >
                  Guided steps (buttons)
                </button>
                <button
                  type="button"
                  disabled={running}
                  onClick={() => setRunMode("auto")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${
                    runMode === "auto" ? "bg-indigo-600 text-white ring-indigo-600" : "bg-white text-slate-700 ring-slate-200"
                  }`}
                >
                  Automatic (with pause)
                </button>
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" disabled={disabled || running || caseBlocked || Boolean(guidedWaiting)} onClick={() => void handleRunCase()}>
                {running ? (guidedWaiting ? "Waiting for you…" : "Running case…") : finished ? "Run case again" : "Run case"}
              </Button>
              {running && (
                <Button variant="danger" onClick={stop}>
                  Stop
                </Button>
              )}
              {(definition.showsReconcile || lastPayment?.status === "UNKNOWN" || lastPayment?.reconciliation_required) && (
                <Button disabled={running || !lastPayment} onClick={() => void handleReconcile()}>
                  Reconcile this payment
                </Button>
              )}
            </div>

            {steps.length > 0 && (
              <ol className="mt-4 space-y-2 border-t border-slate-100 pt-4">
                {steps.map((step, index) => (
                  <li key={index} className="text-sm">
                    <span className="font-medium text-slate-900">{step.label}</span>
                    {step.state === "running" && <span className="ml-2 text-xs text-indigo-600">…</span>}
                    {step.detail && (
                      <p className={`mt-0.5 ${step.state === "error" ? "text-rose-700" : "text-slate-600"}`}>{step.detail}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}

            {finished === "ok" && <p className="mt-3 text-sm text-emerald-800">{definition.verdict}</p>}
            {finished === "stopped" && (
              <p className="mt-3 text-sm text-slate-600">Stopped. Fault switches were reset.</p>
            )}
          </Card>

          <Card title="Case demonstration" subtitle="Live API responses and stored events (same style as Live demo)">
            {showDiagram && (
              <div className="mb-4">
                {flowLabel && <p className="mb-2 text-sm font-medium text-slate-800">{flowLabel}</p>}
                <FlowDiagram
                  leadership={leadership}
                  health={health}
                  active={activeNodes}
                  workerMode={workerDiagramMode}
                  crashedId={crashedLeader}
                />
              </div>
            )}

            {interruption && (
              <div className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3">
                <p className="text-sm font-semibold text-indigo-950">Interruption — duplicate click</p>
                <p className="mt-1 text-sm text-indigo-900">{interruption.message}</p>
                <div className="mt-3">
                  <Button variant="primary" onClick={continueInterruption}>
                    Continue (send duplicate now)
                  </Button>
                </div>
                <p className="mt-2 text-xs text-indigo-700">Continues automatically in a few seconds if you do nothing.</p>
              </div>
            )}

            {guidedWaiting && (
              <div className="mb-4 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3">
                <p className="text-sm font-semibold text-violet-950">Next step</p>
                <p className="mt-1 text-sm text-violet-900">{GUIDED_LABELS[guidedWaiting] ?? guidedWaiting}</p>
                <div className="mt-3">
                  <Button variant="primary" onClick={continueGuided}>
                    {GUIDED_LABELS[guidedWaiting] ?? "Continue"}
                  </Button>
                </div>
              </div>
            )}

            {demonstration ? (
              <CaseDemonstrationPanel demonstration={demonstration} embedded />
            ) : !running ? (
              <p className="text-sm text-slate-600">
                Click <span className="font-medium text-slate-900">Run case</span> to execute this scenario. Manual Pay below uses a separate request ID and
                will not show idempotency or fault behavior.
              </p>
            ) : (
              <p className="text-sm text-slate-600">Running against the live API…</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
