export type Priority = "P1" | "P2" | "P3";

export interface Finding {
  priority: Priority;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
}
