export type PaymentStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "UNKNOWN";

export type Payment = {
  id: number;
  transaction_id: string;
  amount: string;
  description: string;
  status: PaymentStatus | string;
  worker_id: string | null;
  idempotency_key: string | null;
  reconciliation_required: boolean;
  attempt_count: number;
  last_error: string | null;
  last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkerFault = {
  worker_id: string;
  mode: string;
  delay_seconds: number;
};

export type WorkerHealth = {
  worker_id: string;
  reachable: boolean;
  status: string;
};

export type PaymentEvent = {
  id: number;
  transaction_id: string;
  event_type: string;
  created_at: string;
  service: string;
  worker_id: string | null;
  attempt: number | null;
  message: string;
  metadata: Record<string, string | number | boolean> | null;
};

export type PaymentMetrics = {
  total_payments: number;
  successful_payments: number;
  failed_payments: number;
  unknown_payments: number;
  processing_payments: number;
  pending_payments: number;
  success_rate: number | null;
  success_rate_basis: string;
  worker_attempts: number;
  retries: number;
  reconciliation_resolved: number;
  reconciliation_inconclusive: number;
  fault_injection_enabled: boolean;
};

export type WorkersHealthResponse = {
  coordinator_reachable: boolean;
  workers: WorkerHealth[];
  detail?: string;
};
