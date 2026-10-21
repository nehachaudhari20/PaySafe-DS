import { useEffect, useState } from "react";
import { crashLeader, fetchElectionEvents, fetchFaults, reconcile, setWorkerFault } from "../api";
import type { CoordinatorLeadership, ElectionEvent, PaymentMetrics, WorkerFault, WorkersHealthResponse } from "../types";
import { currentLeaderId } from "./FlowDiagram";
import { ElectionLog } from "./ElectionLog";
import { FlowDiagram } from "./FlowDiagram";
import { Button, Card, Dot, ErrorText } from "./ui";

const MODES: { mode: "normal" | "fail" | "delay"; label: string }[] = [
  { mode: "normal", label: "Normal" },
  { mode: "fail", label: "Decline" },
  { mode: "delay", label: "Slow (8s)" },
];

type ClusterErrors = {
  leadership?: string;
  health?: string;
  metrics?: string;
};

function faultModeLabel(mode: string, delaySeconds: number): string {
  if (mode === "fail") {
    return "decline";
  }
  if (mode === "delay") {
    return `slow (${delaySeconds}s)`;
  }
  return "normal";
}

export function SystemStatus({
  leadership,
  health,
  metrics,
  faultInjectionEnabled,
  clusterErrors,
  clusterLoading,
  clusterLastUpdated,
  onChanged,
}: {
  leadership: CoordinatorLeadership | null;
  health: WorkersHealthResponse | null;
  metrics: PaymentMetrics | null;
  faultInjectionEnabled: boolean;
  clusterErrors: ClusterErrors;
  clusterLoading: boolean;
  clusterLastUpdated: number | null;
  onChanged: () => void;
}) {
  const [faults, setFaults] = useState<WorkerFault[]>([]);
  const [electionEvents, setElectionEvents] = useState<ElectionEvent[]>([]);
  const [faultsError, setFaultsError] = useState("");
  const [electionError, setElectionError] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  const effectiveLeaderId = clusterErrors.leadership ? null : currentLeaderId(leadership);
  const leaseExpired =
    !clusterErrors.leadership && leadership?.leader_id != null && leadership.lease_expires_at != null && effectiveLeaderId == null;

  async function loadFaults() {
    if (!faultInjectionEnabled) {
      setFaults([]);
      setFaultsError("");
      return;
    }
    try {
      setFaults(await fetchFaults());
      setFaultsError("");
    } catch (loadError) {
      setFaultsError(loadError instanceof Error ? loadError.message : "Could not load fault switches.");
    }
  }

  async function loadElection() {
    try {
      setElectionEvents(await fetchElectionEvents(30));
      setElectionError("");
    } catch (loadError) {
      setElectionError(loadError instanceof Error ? loadError.message : "Could not load election log.");
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

  const leaseLeft =
    leadership?.lease_expires_at && !clusterErrors.leadership
      ? Math.max(0, (new Date(leadership.lease_expires_at).getTime() - Date.now()) / 1000)
      : null;
  const rate =
    clusterErrors.metrics || metrics == null ? null : metrics.success_rate == null ? "—" : `${Math.round(metrics.success_rate * 100)}%`;
  const refreshAge =
    clusterLastUpdated == null ? null : Math.max(0, Math.floor((Date.now() - clusterLastUpdated) / 1000));
  const clusterRefreshFailed = Boolean(clusterErrors.leadership || clusterErrors.health || clusterErrors.metrics);

  return (
    <div className="space-y-5">
      {(clusterRefreshFailed || clusterLoading) && (
        <div
          className={`rounded-xl px-4 py-3 text-sm ring-1 ${
            clusterLoading ? "bg-slate-50 text-slate-700 ring-slate-200" : "bg-amber-50 text-amber-950 ring-amber-200"
          }`}
        >
          {clusterLoading && <p>Loading live status from the API…</p>}
          {!clusterLoading && clusterRefreshFailed && (
            <div className="space-y-1">
              <p className="font-medium">Some status data could not be refreshed.</p>
              {clusterErrors.metrics && <p>Metrics: {clusterErrors.metrics}</p>}
              {clusterErrors.leadership && <p>Leadership: {clusterErrors.leadership}</p>}
              {clusterErrors.health && <p>Workers: {clusterErrors.health}</p>}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <p>Refreshed every 3 seconds from the payment API.</p>
        <p>
          {refreshAge == null ? "Last update: —" : `Last update: ${refreshAge}s ago`}
          {clusterRefreshFailed && !clusterLoading ? " (partial failure)" : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Number label="Payments" value={clusterErrors.metrics ? undefined : metrics?.total_payments} error={clusterErrors.metrics} loading={clusterLoading} />
        <Number
          label="Succeeded"
          value={clusterErrors.metrics ? undefined : metrics?.successful_payments}
          tone="text-emerald-700"
          error={clusterErrors.metrics}
          loading={clusterLoading}
        />
        <Number
          label="Failed"
          value={clusterErrors.metrics ? undefined : metrics?.failed_payments}
          tone="text-rose-700"
          error={clusterErrors.metrics}
          loading={clusterLoading}
        />
        <Number
          label="Unknown"
          value={clusterErrors.metrics ? undefined : metrics?.unknown_payments}
          tone="text-violet-700"
          hint="Waiting to be settled"
          error={clusterErrors.metrics}
          loading={clusterLoading}
        />
        <Number
          label="Processing"
          value={clusterErrors.metrics ? undefined : metrics?.processing_payments}
          tone="text-slate-700"
          hint="Not yet confirmed"
          error={clusterErrors.metrics}
          loading={clusterLoading}
        />
        <Number
          label="Success rate"
          value={rate ?? undefined}
          hint={metrics?.success_rate_basis ?? "Of SUCCESS and FAILED only"}
          error={clusterErrors.metrics}
          loading={clusterLoading}
        />
      </div>

      <Card title="What is running right now" subtitle="Live coordinator and worker reachability from the API">
        <FlowDiagram leadership={leadership} health={health} />
        <p className="mt-3 text-xs text-slate-500">
          The database is not probed directly on this page. Payment rows and metrics imply the API can reach PostgreSQL when
          those endpoints succeed.
        </p>
        {health?.coordinator_reachable === false && (
          <p className="mt-2 text-sm text-rose-700">{health.detail ?? "The coordinator could not be reached for worker health."}</p>
        )}
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
          subtitle="Three replicas; the leader must renew its lease with heartbeats."
          action={
            faultInjectionEnabled ? (
              <Button
                variant="danger"
                disabled={busy || effectiveLeaderId == null || Boolean(clusterErrors.leadership)}
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
          <dl className="mb-4 grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 text-sm md:grid-cols-4">
            <div>
              <dt className="text-xs text-slate-500">Leader (valid lease)</dt>
              <dd className="font-semibold text-slate-900">
                {clusterErrors.leadership ? "Unavailable" : effectiveLeaderId ? `Coordinator ${effectiveLeaderId}` : "None"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Stored leader_id</dt>
              <dd className="font-semibold text-slate-900">{clusterErrors.leadership ? "—" : (leadership?.leader_id ?? "—")}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Term</dt>
              <dd className="font-semibold text-slate-900">{clusterErrors.leadership ? "—" : (leadership?.term ?? "—")}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Lease left</dt>
              <dd
                className={`font-semibold ${
                  clusterErrors.leadership ? "text-amber-700" : leaseLeft != null && leaseLeft > 0 ? "text-slate-900" : "text-rose-700"
                }`}
              >
                {clusterErrors.leadership ? "unavailable" : leaseLeft != null && leaseLeft > 0 ? `${leaseLeft.toFixed(1)}s` : "expired"}
              </dd>
            </div>
          </dl>
          {leaseExpired && <p className="mb-3 text-sm text-rose-700">A leader row exists, but the lease has expired (includes a 2s grace).</p>}
          <p className="mb-2 text-sm font-medium text-slate-700">Election log</p>
          {electionError && <ErrorText>{electionError}</ErrorText>}
          <ElectionLog events={electionEvents} emptyText={electionError ? "Could not load election messages." : "No election messages yet."} />
        </Card>

        <Card title="Workers" subtitle="Reachability is gRPC health; fault mode is a separate development switch.">
          <ul className="space-y-3">
            {(health?.workers ?? []).map((worker) => {
              const fault = faults.find((item) => item.worker_id === worker.worker_id);
              const mode = fault?.mode ?? "normal";
              return (
                <li key={worker.worker_id} className="rounded-xl bg-slate-50 p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                        <Dot tone={worker.reachable ? "green" : "red"} />
                        {worker.worker_id}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Reachable: {worker.reachable ? "yes" : "no"} ({worker.status}) · Fault mode:{" "}
                        {faultInjectionEnabled ? faultModeLabel(mode, fault?.delay_seconds ?? 0) : "unknown (switches off)"}
                      </p>
                    </div>
                    {faultInjectionEnabled && (
                      <div className="flex rounded-lg bg-white p-0.5 ring-1 ring-slate-200">
                        {MODES.map(({ mode: faultMode, label }) => (
                          <button
                            key={faultMode}
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                await setWorkerFault(worker.worker_id, faultMode, faultMode === "delay" ? 8 : 0);
                                return faultMode === "normal"
                                  ? `${worker.worker_id} is back to normal.`
                                  : `${worker.worker_id} is set to ${label.toLowerCase()}.`;
                              })
                            }
                            className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                              mode === faultMode ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"
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
            {!clusterErrors.health && (health?.workers ?? []).length === 0 && (
              <p className="text-sm text-slate-500">{health?.detail ?? "No worker report from the leader yet."}</p>
            )}
            {clusterErrors.health && <ErrorText>{clusterErrors.health}</ErrorText>}
          </ul>
          {!faultInjectionEnabled && (
            <p className="mt-3 text-xs text-slate-500">Failure switches are off. Start the stack with FAULT_INJECTION_ENABLED=true.</p>
          )}
          {faultsError && <p className="mt-2 text-sm text-rose-700">{faultsError}</p>}
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

function Number({
  label,
  value,
  tone = "text-slate-900",
  hint,
  error,
  loading,
}: {
  label: string;
  value?: number | string;
  tone?: string;
  hint?: string;
  error?: string;
  loading?: boolean;
}) {
  let display: string;
  if (loading && value == null && !error) {
    display = "…";
  } else if (error) {
    display = "—";
  } else {
    display = value == null ? "—" : String(value);
  }

  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200/70">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${error ? "text-amber-700" : tone}`}>{display}</p>
      {error && <p className="mt-0.5 text-[11px] text-amber-600">Unavailable</p>}
      {hint && !error && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}
