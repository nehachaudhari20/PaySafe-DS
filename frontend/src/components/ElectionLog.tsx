import type { ElectionEvent } from "../types";
import { Dot, Empty, formatTime } from "./ui";

const PLAIN: Record<string, string> = {
  ELECTION_STARTED: "Started an election",
  ELECTION_RESPONSE_RECEIVED: "Replied to an election",
  ELECTION_YIELDED: "Stepped back for a higher ID",
  LEADER_ANNOUNCED: "Leader announced",
  HEARTBEAT_TIMEOUT: "Noticed the leader went quiet",
  LEADERSHIP_CHANGED: "Leadership changed",
  FENCING_REJECTED: "Refused work (not the leader)",
  HEARTBEAT_RENEWED: "Heartbeat",
};

const TONE: Record<string, "green" | "red" | "amber" | "slate" | "violet" | "indigo"> = {
  LEADER_ANNOUNCED: "green",
  HEARTBEAT_TIMEOUT: "red",
  LEADERSHIP_CHANGED: "amber",
  ELECTION_STARTED: "indigo",
  ELECTION_YIELDED: "violet",
  FENCING_REJECTED: "slate",
};

type Group = { first: ElectionEvent; last: ElectionEvent; count: number };

function group(events: ElectionEvent[]): Group[] {
  const groups: Group[] = [];
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const previous = groups[groups.length - 1];
    if (
      previous &&
      previous.last.coordinator_id === event.coordinator_id &&
      previous.last.event_type === event.event_type &&
      previous.last.message === event.message
    ) {
      previous.last = event;
      previous.count += 1;
    } else {
      groups.push({ first: event, last: event, count: 1 });
    }
  }
  return groups.reverse();
}

export function ElectionLog({ events, emptyText }: { events: ElectionEvent[]; emptyText: string }) {
  if (events.length === 0) {
    return <Empty>{emptyText}</Empty>;
  }
  return (
    <ol className="max-h-96 space-y-2 overflow-y-auto pr-1">
      {group(events).map(({ first, last, count }) => (
        <li key={first.id} className="flex gap-3 rounded-lg bg-slate-50 px-3 py-2">
          <span className="pt-1.5">
            <Dot tone={TONE[first.event_type] ?? "slate"} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <p className="text-sm font-medium text-slate-900">
                Coordinator {first.coordinator_id}: {PLAIN[first.event_type] ?? first.event_type}
                {count > 1 && <span className="ml-1.5 text-xs font-normal text-slate-500">×{count}</span>}
              </p>
              <p className="text-xs tabular-nums text-slate-400">
                {formatTime(first.created_at)}
                {count > 1 ? ` – ${formatTime(last.created_at)}` : ""}
              </p>
            </div>
            <p className="text-xs text-slate-500">
              {first.message}
              {first.term ? ` · term ${first.term}` : ""}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
