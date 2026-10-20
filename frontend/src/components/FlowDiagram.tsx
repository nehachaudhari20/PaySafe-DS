import type { CoordinatorLeadership, WorkersHealthResponse } from "../types";

export type FlowNode = "you" | "api" | "leader" | "worker" | "db";
export type WorkerMode = "ok" | "fail" | "slow";

const NODES: { id: FlowNode; title: string; caption: string }[] = [
  { id: "you", title: "You", caption: "Browser sends the payment" },
  { id: "api", title: "Payment API", caption: "Saves the request first" },
  { id: "leader", title: "Coordinators", caption: "Only the leader gives out work" },
  { id: "worker", title: "Workers", caption: "Carry out the payment" },
  { id: "db", title: "Database", caption: "Remembers every result" },
];

type Chip = { label: string; tone: "green" | "red" | "amber" | "slate" };

const LEASE_GRACE_MS = 2000;

export function currentLeaderId(leadership: CoordinatorLeadership | null): number | null {
  if (!leadership?.leader_id || !leadership.lease_expires_at) {
    return null;
  }
  return new Date(leadership.lease_expires_at).getTime() + LEASE_GRACE_MS > Date.now() ? leadership.leader_id : null;
}

export function FlowDiagram({
  leadership,
  health,
  active = [],
  upcoming = [],
  crashedId = null,
  workerMode = "ok",
}: {
  leadership: CoordinatorLeadership | null;
  health: WorkersHealthResponse | null;
  active?: FlowNode[];
  upcoming?: FlowNode[];
  crashedId?: number | null;
  workerMode?: WorkerMode;
}) {
  const leaderId = currentLeaderId(leadership);

  const coordinatorChips: Chip[] = [1, 2, 3].map((id) => {
    if (id === crashedId) {
      return { label: `C${id} crashed`, tone: "red" };
    }
    if (id === leaderId) {
      return { label: `C${id} leader`, tone: "green" };
    }
    return { label: `C${id}`, tone: "slate" };
  });

  const workerChips: Chip[] = (health?.workers ?? []).map((worker) => {
    const name = worker.worker_id.replace("worker-", "").toUpperCase();
    if (!worker.reachable) {
      return { label: `${name} offline`, tone: "red" };
    }
    if (workerMode === "fail") {
      return { label: `${name} declines`, tone: "red" };
    }
    if (workerMode === "slow") {
      return { label: `${name} slow`, tone: "amber" };
    }
    return { label: `${name} ok`, tone: "green" };
  });

  const chips: Partial<Record<FlowNode, Chip[]>> = {
    leader: coordinatorChips,
    worker: workerChips.length ? workerChips : [{ label: "no report", tone: "amber" }],
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
      {NODES.map((node, index) => {
        const isActive = active.includes(node.id);
        const isUpcoming = !isActive && upcoming.includes(node.id);
        const broken = (node.id === "leader" && crashedId != null) || (node.id === "worker" && workerMode !== "ok");
        return (
          <div key={node.id} className="flex flex-1 items-center gap-2">
            <div
              className={`relative h-full flex-1 rounded-xl p-3 transition-all duration-300 ${
                isActive
                  ? "scale-[1.03] bg-indigo-50 shadow-md ring-4 ring-indigo-500"
                  : broken
                    ? "bg-rose-50 ring-2 ring-rose-500"
                    : isUpcoming
                      ? "bg-white outline-dashed outline-2 outline-indigo-300"
                      : "bg-white ring-1 ring-slate-200"
              }`}
            >
              {isActive && (
                <span className="absolute -top-2.5 right-2 flex items-center gap-1 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow">
                  <span className="h-1.5 w-1.5 animate-ping rounded-full bg-white" /> working here
                </span>
              )}
              {broken && !isActive && (
                <span className="absolute -top-2.5 left-2 rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow">
                  broken on purpose
                </span>
              )}
              {isUpcoming && (
                <span className="absolute -top-2.5 right-2 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
                  next
                </span>
              )}
              <p className="text-sm font-semibold text-slate-900">{node.title}</p>
              <p className="mt-0.5 text-xs text-slate-500">{node.caption}</p>
              {chips[node.id] && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {chips[node.id]!.map((chip) => (
                    <ChipView key={chip.label} chip={chip} />
                  ))}
                </div>
              )}
            </div>
            {index < NODES.length - 1 && (
              <span className={`hidden text-lg sm:block ${isActive ? "text-indigo-500" : "text-slate-300"}`}>→</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChipView({ chip }: { chip: Chip }) {
  const styles = {
    green: "bg-emerald-100 text-emerald-800",
    red: "bg-rose-100 text-rose-800",
    amber: "bg-amber-100 text-amber-800",
    slate: "bg-slate-100 text-slate-600",
  }[chip.tone];
  return <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${styles}`}>{chip.label}</span>;
}
