import type { CaseDemonstration } from "../scenarios/demonstration";
import { formatFlowPath, hasIdempotencyConflict, hasIdempotencyReplay, shortenKey } from "../scenarios/demonstration";
import { ElectionLog } from "./ElectionLog";
import { TimelineList } from "./ExecutionTimeline";
import { StatusBadge } from "./StatusBadge";
import { Card } from "./ui";

export function CaseDemonstrationPanel({ demonstration, embedded = false }: { demonstration: CaseDemonstration; embedded?: boolean }) {
  const tone =
    demonstration.caseId === "failed"
      ? "border-rose-200 bg-rose-50/40"
      : demonstration.caseId === "unknown"
        ? "border-violet-200 bg-violet-50/40"
        : demonstration.caseId === "conflict"
          ? "border-amber-200 bg-amber-50/40"
          : demonstration.caseId === "double"
            ? "border-indigo-200 bg-indigo-50/40"
            : demonstration.caseId === "leader"
              ? "border-slate-300 bg-slate-50/80"
              : "border-emerald-200 bg-emerald-50/30";

  const inner = (
    <>
      {demonstration.narrative.length > 0 && (
        <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-slate-700">
          {demonstration.narrative.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {demonstration.normal && (
        <div className="space-y-3">
          <PaymentSummary payment={demonstration.normal.payment} />
          <TimelineList events={demonstration.normal.events} />
        </div>
      )}

      {demonstration.requests && demonstration.requests.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {demonstration.requests.map((request) => (
            <div key={request.label} className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
              <p className="text-sm font-semibold text-slate-900">{request.label}</p>
              <p className="mt-1 text-xs text-slate-500">
                Key {shortenKey(request.idempotencyKey)} · {request.amount} · {request.description}
              </p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="font-mono text-xs text-slate-800">{request.payment.transaction_id}</p>
                <StatusBadge status={request.payment.status} />
              </div>
              {request.flowPath && (
                <p className="mt-2 text-xs font-medium text-indigo-900">Path: {formatFlowPath(request.flowPath)}</p>
              )}
              {request.idempotencyOutcome && (
                <p className="mt-1 text-xs text-slate-600">API idempotency: {request.idempotencyOutcome}</p>
              )}
              <p className="mt-2 text-xs text-slate-600">
                Worker dispatch steps in timeline: {request.dispatchEventCount}
                {request.label.includes("#2") && hasIdempotencyReplay(request.events) ? " · IDEMPOTENCY_REPLAYED recorded" : ""}
              </p>
              {request.label.includes("#2") && (
                <p className="mt-1 text-xs font-medium text-indigo-800">
                  {request.payment.updated_at === demonstration.requests![0].payment.updated_at
                    ? "Same transaction and updated_at as request #1 — deduplicated."
                    : "Same transaction ID returned."}
                </p>
              )}
              <div className="mt-3 max-h-48 overflow-y-auto">
                <TimelineList events={request.events} />
              </div>
            </div>
          ))}
        </div>
      )}

      {demonstration.conflict && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl bg-white p-4 ring-1 ring-emerald-200">
            <p className="text-sm font-semibold text-emerald-900">Request #1 — accepted</p>
            {demonstration.conflict.firstFlowPath && (
              <p className="mt-1 text-xs font-medium text-emerald-800">Path: {formatFlowPath(demonstration.conflict.firstFlowPath)}</p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              Key {shortenKey(demonstration.conflict.idempotencyKey)} · {demonstration.conflict.firstAmount}
            </p>
            <div className="mt-2 flex items-center justify-between">
              <p className="font-mono text-xs">{demonstration.conflict.firstPayment.transaction_id}</p>
              <StatusBadge status={demonstration.conflict.firstPayment.status} />
            </div>
            <div className="mt-3 max-h-40 overflow-y-auto">
              <TimelineList events={demonstration.conflict.firstEvents} />
            </div>
          </div>
          <div className="rounded-xl bg-white p-4 ring-1 ring-rose-200">
            <p className="text-sm font-semibold text-rose-900">Request #2 — rejected (payload conflict)</p>
            {demonstration.conflict.secondFlowPath && (
              <p className="mt-1 text-xs font-medium text-rose-800">Path: {formatFlowPath(demonstration.conflict.secondFlowPath)} (stops at API)</p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              Same key · amount changed to {demonstration.conflict.secondAmount}
            </p>
            {demonstration.conflict.httpStatus > 0 ? (
              <>
                <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
                  HTTP {demonstration.conflict.httpStatus}: {demonstration.conflict.httpMessage}
                </p>
                <p className="mt-2 text-xs text-slate-600">
                  No second payment row was created. Original amount stays {demonstration.conflict.firstPayment.amount}.
                  {hasIdempotencyConflict(demonstration.conflict.firstEvents) ? " IDEMPOTENCY_PAYLOAD_CONFLICT recorded on the original payment." : ""}
                </p>
              </>
            ) : (
              <p className="mt-3 text-sm text-slate-600">Waiting for the conflicting second request…</p>
            )}
          </div>
        </div>
      )}

      {demonstration.failed && (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">
            Worker fault mode before payment: <span className="font-medium">{demonstration.failed.workerMode}</span>
          </p>
          <PaymentSummary payment={demonstration.failed.payment} />
          <TimelineList events={demonstration.failed.events} />
        </div>
      )}

      {demonstration.unknown && (
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            Workers delayed {demonstration.unknown.workerDelaySeconds}s; coordinator gRPC timeout is about{" "}
            {demonstration.unknown.rpcTimeoutSeconds}s.
          </p>
          <div className="rounded-xl bg-violet-50 p-4 ring-1 ring-violet-200">
            <p className="text-sm font-semibold text-violet-900">After timeout — uncertain</p>
            <PaymentSummary payment={demonstration.unknown.uncertainPayment} />
            <div className="mt-2 max-h-40 overflow-y-auto">
              <TimelineList events={demonstration.unknown.uncertainEvents} />
            </div>
          </div>
          <div className="rounded-xl bg-emerald-50 p-4 ring-1 ring-emerald-200">
            <p className="text-sm font-semibold text-emerald-900">After reconciliation — settled from worker evidence</p>
            <PaymentSummary payment={demonstration.unknown.reconciledPayment} />
            <div className="mt-2 max-h-48 overflow-y-auto">
              <TimelineList events={demonstration.unknown.reconciledEvents} />
            </div>
          </div>
        </div>
      )}

      {demonstration.leadership && (
        <div className="space-y-4">
          <dl className="grid gap-3 sm:grid-cols-3">
            <LeadershipBox label="Before crash" value={demonstration.leadership.before} />
            <LeadershipBox label="After failover" value={demonstration.leadership.afterCrash} />
            <LeadershipBox label="Final" value={demonstration.leadership.final} />
          </dl>
          <p className="text-xs text-slate-500">
            Simulated crash of Coordinator {demonstration.leadership.crashedLeaderId} via the development endpoint (lease stops renewing; not a
            container kill).
          </p>
          <PaymentSummary payment={demonstration.leadership.payment} />
          <div className="max-h-48 overflow-y-auto">
            <TimelineList events={demonstration.leadership.paymentEvents} />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-slate-800">Election messages (from API)</p>
            <ElectionLog events={demonstration.leadership.electionEvents} emptyText="No election events returned." />
          </div>
        </div>
      )}
    </>
  );

  if (embedded) {
    return <div className={`rounded-xl p-4 ring-1 ${tone}`}>{inner}</div>;
  }

  return (
    <Card title="What this case actually did" subtitle="From live API responses and stored execution events" className={tone}>
      {inner}
    </Card>
  );
}

function PaymentSummary({ payment }: { payment: { transaction_id: string; status: string; amount: string; worker_id: string | null; attempt_count: number } }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/80 px-3 py-2 text-sm ring-1 ring-slate-200">
      <span className="font-mono text-slate-900">{payment.transaction_id}</span>
      <StatusBadge status={payment.status} />
      <span className="text-slate-600">
        {payment.amount} · {payment.worker_id ?? "—"} · {payment.attempt_count} attempt{payment.attempt_count === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function LeadershipBox({ label, value }: { label: string; value: { leader_id: number | null; term: number | null } }) {
  return (
    <div className="rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-sm font-semibold text-slate-900">
        {value.leader_id ? `Coordinator ${value.leader_id}` : "None"} · term {value.term ?? "—"}
      </dd>
    </div>
  );
}
