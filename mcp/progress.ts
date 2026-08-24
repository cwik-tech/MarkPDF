/** A transport-neutral progress update produced by one tool operation. */
export interface ToolProgress {
  progress?: number;
  total?: number;
  message?: string;
}
