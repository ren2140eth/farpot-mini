import type { Config } from "wagmi";
import type { Hash } from "viem";
import { waitForTransactionReceipt } from "wagmi/actions";

const RECEIPT_ATTEMPTS = 3;
const RECEIPT_ATTEMPT_TIMEOUT_MS = 60_000;
const RECEIPT_RETRY_DELAY_MS = 1_000;

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Confirms an already-submitted transaction without ever resubmitting it.
 *
 * viem's receipt watcher correctly keeps polling when a receipt is merely not
 * found yet, but other transient RPC/watch errors reject the whole wait. A
 * second observation of the same hash is safe and avoids showing a false
 * failure when another endpoint can confirm the transaction.
 */
export async function confirmTransaction(config: Config, hash: Hash) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= RECEIPT_ATTEMPTS; attempt += 1) {
    try {
      return await waitForTransactionReceipt(config, {
        hash,
        timeout: RECEIPT_ATTEMPT_TIMEOUT_MS,
      });
    } catch (error) {
      lastError = error;
      if (attempt === RECEIPT_ATTEMPTS) break;

      console.warn(
        `Receipt confirmation attempt ${attempt} failed for ${hash}; retrying the same transaction hash.`,
        error,
      );
      await delay(RECEIPT_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}
