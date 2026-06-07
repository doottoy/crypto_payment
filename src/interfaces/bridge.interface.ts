/**
 * Supported bridge destinations. The source chain is always Sepolia L1.
 */
export type BridgeDestination = 'base' | 'arbitrum';

/**
 * Structure for a native ETH L1->L2 bridge (deposit) request.
 *
 * Deposits ETH from Sepolia to the selected L2 (Base Sepolia or Arbitrum Sepolia).
 * If `payee_address` is omitted, the funds are credited to the sender's own
 * address on the destination chain; otherwise to the provided recipient.
 *
 * The returned `tx_id` is the hash of the L1 deposit transaction — arrival of
 * funds on the L2 happens asynchronously afterwards.
 */
export interface BridgeRequestBody {
    data: {
        destination: BridgeDestination;
        private_key: string;
        amount: string;
        payee_address?: string;
        currency?: string;
        request_id?: string;
        wait_for_receipt?: boolean;
    };
}
