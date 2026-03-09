import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { LendBTC } from './LendBTC';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';

// Factory — returns a fresh instance on every call (constructor runs each interaction)
Blockchain.contract = (): LendBTC => {
    return new LendBTC();
};

// Required runtime exports
export * from '@btc-vision/btc-runtime/runtime/exports';

// Required abort handler
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
