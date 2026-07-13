"use client";

import { ReactNode, useState } from "react";
import { WagmiProvider, createConfig, http, fallback } from "wagmi";
import { base } from "wagmi/chains";
import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OnchainKitProvider } from "@coinbase/onchainkit";
import "@coinbase/onchainkit/styles.css";

const apiKey = process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY;

// Reliable Base RPC transport.
//
// OnchainKit's default config uses a single transport — and with no API key that
// is the public `mainnet.base.org` endpoint, which is load-balanced across nodes
// at slightly different heights. eth_call / estimateGas pinned to a fresh block
// intermittently hit a node that hasn't synced it yet and throw
// "block not found" / "Requested resource not found", which broke ticket buys.
//
// fallback() rotates to the next RPC on any such error, so a flaky endpoint no
// longer fails a purchase. Coinbase's RPC (when an API key is present) goes first
// as the most consistent backend, then public providers as backups.
const wagmiConfig = createConfig({
  chains: [base],
  connectors: [farcasterMiniApp()],
  transports: {
    [base.id]: fallback([
      ...(apiKey
        ? [http(`https://api.developer.coinbase.com/rpc/v1/base/${apiKey}`)]
        : []),
      http("https://base.publicnode.com"),
      http("https://1rpc.io/base"),
      http("https://mainnet.base.org"),
    ]),
  },
  ssr: true,
});

export function RootProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <OnchainKitProvider
          apiKey={apiKey}
          chain={base}
          config={{
            appearance: {
              mode: "auto",
            },
            wallet: {
              display: "modal",
              preference: "all",
            },
          }}
          miniKit={{
            enabled: true,
            autoConnect: true,
          }}
        >
          {children}
        </OnchainKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
