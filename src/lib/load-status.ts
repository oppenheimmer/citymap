import type { LoadProgress } from './domain.ts';

/** Seconds without any load activity before the UI says the download may have stalled. */
export const STALL_SECONDS = 15;

/** Bytes received for the current load; `total` is set only when the size is known. */
export interface Transfer { bytes: number; total?: number }
export interface LoadActivity { text: string; value?: number; max?: number; warning?: string }

export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Describes a running load for the progress bar and status line. Times are in
 * milliseconds from one clock. A determinate bar needs a known total that the received
 * bytes have not exceeded; compressed or unknown lengths stay indeterminate.
 */
export function describeLoad(progress: LoadProgress | null, transfer: Transfer | null, startedAt: number, lastActivityAt: number, now: number): LoadActivity {
  const total = transfer?.total && transfer.bytes <= transfer.total ? transfer.total : undefined;
  const parts = [progress?.message || 'Starting…'];
  if (transfer) parts.push(total ? `${formatBytes(transfer.bytes)} of ${formatBytes(total)} (${Math.floor(100 * transfer.bytes / total)}%)` : `${formatBytes(transfer.bytes)} received`);
  if (progress?.totalChunks) parts.push(`${progress.completedChunks || 0} of ${progress.totalChunks} chunks`);
  parts.push(`${Math.max(0, Math.floor((now - startedAt) / 1000))} s`);
  const idle = Math.max(0, Math.floor((now - lastActivityAt) / 1000));
  // Only network stages can stall silently; projection and drawing report their own progress.
  const network = !progress || progress.stage === 'cache' || progress.stage === 'download';
  let warning: string | undefined;
  if (network && idle >= STALL_SECONDS) {
    warning = transfer?.bytes
      ? `No data for ${idle} s. The connection may have stalled; loading stops by itself if nothing arrives.`
      : `No response after ${idle} s. Large cities can take a minute or more before data starts arriving.`;
  }
  return { text: parts.join(' · '), value: total ? transfer!.bytes : undefined, max: total, warning };
}
