import { useEffect, useState } from "react";
import { crashLeader, fetchElectionEvents, fetchFaults, reconcile, setWorkerFault } from "../api";
import type { CoordinatorLeadership, ElectionEvent, PaymentMetrics, WorkerFault, WorkersHealthResponse } from "../types";
import { ElectionLog } from "./ElectionLog";
import { FlowDiagram } from "./FlowDiagram";
import { Button, Card, Dot, ErrorText } from "./ui";

const MODES: { mode: "normal" | "fail" | "delay"; label: string }[] = [
  { mode: "normal", label: "Normal" },
  { mode: "fail", label: "Decline" },
  { mode: "delay", label: "Slow (8s)" },
];

export function SystemStatus({
  leadership,
  health,
  metrics,
  faultInjectionEnabled,
  onChanged,
}: {
  leadership: CoordinatorLeadership | null;
  health: WorkersHealthResponse | null;
  metrics: PaymentMetrics | null;
  faultInjectionEnabled: boolean;
  onChanged: () => void;
}) {
  const [faults, setFaults] = useState<WorkerFault[]>([]);
  const [electionEvents, setElectionEvents] = useState<ElectionEvent[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  async function loadFaults() {
    if (!faultInjectionEnabled) {
      return;
    }
    try {
      setFaults(await fetchFaults());
    } catch {
      /* switches are optional */
    }
  }

  async function loadElection() {
    try {
      setElectionEvents(await fetchElectionEvents(30));
    } catch {
      /* the log is optional */
    }
  }

  useEffect(() => {
    void loadFaults();
    void loadElection();
    const poll = window.setInterval(() => void loadElection(), 3000);
    const clock = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [faultInjectionEnabled]);

  async function act(action: () => Promise<string>) {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      setMessage(await action());
      await loadFaults();
      await loadElection();
      onChanged();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const leaseLeft = leadership?.lease_expires_at
    ? Math.max(0, (new Date(leadership.lease_expires_at).getTime() - Date.now()) / 1000)
    : 0;
  const rate = metrics?.success_rate == null ? "—" : `${Math.round(metrics.success_rate * 100)}%`;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Number label="Payments" value={metrics?.total_payments} />
        <Number label="Succeeded" value={metrics?.successful_payments} tone="text-emerald-700" />
        <Number label="Failed" value={metrics?.failed_payments} tone="text-rose-700" />
        <Number label="Unknown" value={metrics?.unknown_payments} tone="text-violet-700" hint="Waiting to be settled" />
        <Number label="Success rate" value={rate} hint="Of settled payments" />
      </div>

      <Card title="What is running right now" subtitle="Refreshed every 3 seconds">
        <FlowDiagram leadership={leadership} health={health} />
      </Card>

      {(message || error) && (
        <div className="rounded-xl bg-white px-4 py-3 ring-1 ring-slate-200">
          {message && <p className="text-sm text-slate-700">{message}</p>}
          {error && <ErrorText>{error}</ErrorText>}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Card
          title="Coordinators and the leader"
          subtitle="Three copies. One is leader and must keep renewing its lease with heartbeats."
          action={
            faultInjectionEnabled ? (
              <Button
                variant="danger"
                disabled={busy || leadership?.leader_id == null}
                onClick={() =>
                  void act(async () => {
                    const result = await crashLeader(15);
                    return `Coordinator ${result.crashed_leader_id} is now crashed for 15 seconds. Watch the log below for the election.`;
                  })
                }
              >
                Crash leader (15s)
              </Button>
            ) : undefined
          }
        >
          <dl className="mb-4 grid grid-cols-3 gap-3 rounded-xl bg-slate-50 p-3 text-sm">
            <div>
              <dt className="text-xs text-slate-500">Leader</dt>
              <dd className="font-semibold text-slate-900">{leadership?.leader_id ? `Coordinator ${leadership.leader_id}` : "None"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Term</dt>
              <dd className="font-semibold text-slate-900">{leadership?.term ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Lease left</dt>
              <dd className={`font-semibold ${leaseLeft > 0 ? "text-slate-900" : "text-rose-700"}`}>
                {leaseLeft > 0 ? `${leaseLeft.toFixed(1)}s` : "expired"}
              </dd>
            </div>
          </dl>
          <p className="mb-2 text-sm font-medium text-slate-700">Election log</p>
          <ElectionLog events={electionEvents} emptyText="No election messages yet." />
        </Card>

        <Card title="Workers" subtitle="Each switch changes how that worker behaves, for testing failures.">
          <ul className="space-y-3">
            {(health?.workers ?? []).map((worker) => {
              const current = faults.find((fault) => fault.worker_id === worker.worker_id)?.mode ?? "normal";
              return (
                <li key={worker.worker_id} className="rounded-xl bg-slate-50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <Dot tone={worker.reachable ? "green" : "red"} />
                      {worker.worker_id}
                      <span className="font-normal text-slate-500">{worker.reachable ? "online" : "offline"}</span>
                    </p>
                    {faultInjectionEnabled && (
                      <div className="flex rounded-lg bg-white p-0.5 ring-1 ring-slate-200">
                        {MODES.map(({ mode, label }) => (
                          <button
                            key={mode}
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                await setWorkerFault(worker.worker_id, mode, mode === "delay" ? 8 : 0);
                                return mode === "normal" ? `${worker.worker_id} is back to normal.` : `${worker.worker_id} is set to ${label.toLowerCase()}.`;
                              })
                            }
                            className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                              current === mode ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
            {(health?.workers ?? []).length === 0 && (
              <p className="text-sm text-slate-500">{health?.detail ?? "No worker report from the leader yet."}</p>
            )}
          </ul>
          {!faultInjectionEnabled && (
            <p className="mt-3 text-xs text-slate-500">Failure switches are off. Start the stack with FAULT_INJECTION_ENABLED=true.</p>
          )}
          <div className="mt-5 border-t border-slate-100 pt-4">
            <p className="text-sm font-medium text-slate-900">Settle UNKNOWN payments</p>
            <p className="mt-0.5 text-sm text-slate-500">
              Looks up what each worker actually saved and updates the payment. It never re-sends a payment.
            </p>
            <div className="mt-3">
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await reconcile();
                    return `Reconciliation settled ${result.resolved.length} payment(s); ${result.unknown.length} still have no worker result.`;
                  })
                }
              >
                Run reconciliation
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Number({ label, value, tone = "text-slate-900", hint }: { label: string; value?: number | string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200/70">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value ?? "—"}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}
