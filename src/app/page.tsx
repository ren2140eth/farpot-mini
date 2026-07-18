"use client";

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { useAccount, useConfig, useReadContract } from "wagmi";
import { estimateGas, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { stringToHex, formatUnits, encodeFunctionData } from "viem";
import { Connected } from "@coinbase/onchainkit";
import { ConnectWallet } from "@coinbase/onchainkit/wallet";
import { useMiniKit, useComposeCast } from "@coinbase/onchainkit/minikit";
import { sdk } from "@farcaster/miniapp-sdk";
import {
  JACKPOT_ADDRESS,
  RANDOM_TICKET_BUYER_ADDRESS,
  USDC_ADDRESS,
  AUTO_SUBSCRIPTION_ADDRESS,
  JACKPOT_ABI,
  RANDOM_TICKET_BUYER_ABI,
  AUTO_SUBSCRIPTION_ABI,
  USDC_ABI,
  REFERRAL_WALLET,
  MEGAPOT_API_BASE,
} from "@/lib/constants";

// ── Constants ────────────────────────────────────────────────────────

const SOURCE = stringToHex("megapot-mini", { size: 32 });
const REFERRAL_SPLIT = BigInt(1_000_000_000_000_000_000);
const USDC_DECIMALS = 6;
const APP_URL = "https://farpot.vercel.app";

// ── Types ────────────────────────────────────────────────────────────

interface DrawingState {
  prizePool: bigint;
  ticketPrice: bigint;
  globalTicketsBought: bigint;
  ballMax: number;
  bonusballMax: number;
  drawingTime: number;
  jackpotLock: boolean;
}

interface TicketSelection {
  normals: number[];
  bonusball: number;
}

type BuyPhase = "idle" | "approving" | "buying" | "success" | "error";
type TabKey = "play" | "gift" | "results";
type QtyPreset = "1" | "5" | "10" | "custom";

function ConfettiBurst() {
  return (
    <div className="confetti-burst" aria-hidden="true">
      {Array.from({ length: 28 }, (_, index) => (
        <span key={index} className="confetti-piece" />
      ))}
      {/* A few gold stars in the mix — echoes the FAR★POT wordmark */}
      {Array.from({ length: 6 }, (_, index) => (
        <span key={`star-${index}`} className="confetti-piece confetti-star">
          ⭐
        </span>
      ))}
    </div>
  );
}

// ── Haptics — physical feedback via the mini-app host ───────────────
// Best-effort only: outside a mini-app host (plain browser) the SDK call may
// reject or throw, and either way the app must carry on silently.
function tryHaptic(fire: () => Promise<void>) {
  try {
    fire().catch(() => {});
  } catch {
    /* not in a mini-app host */
  }
}
const haptics = {
  select: () => tryHaptic(() => sdk.haptics.selectionChanged()),
  impact: () => tryHaptic(() => sdk.haptics.impactOccurred("medium")),
  success: () => tryHaptic(() => sdk.haptics.notificationOccurred("success")),
  error: () => tryHaptic(() => sdk.haptics.notificationOccurred("error")),
};

// ── Subscription types ───────────────────────────────────────────────

type SubPhase = "idle" | "approving" | "subscribing" | "success" | "error" | "cancelling";

interface SubscriptionInfo {
  isActive: boolean;
  daysRemaining: number;
  balance: bigint;
  dynamicTicketCount: number;
}

// ── API types (from Megapot Data API) ────────────────────────────────

interface ApiAmount {
  amount: string;
  decimals: number;
}

interface ApiRound {
  id: string;
  status: string;
  prize_pool: ApiAmount;
  ticket_count: number;
  unique_participants: number;
  winners_count: number;
  top_prize_amount: ApiAmount | null;
  top_prize_winners_count: number;
  started_at: string | null;
  ended_at: string | null;
  settled_at: string | null;
  ball_pool: { normals_max: number; bonusball_max: number };
  winning_numbers: { normals: number[]; bonusball: number } | null;
  prize_tiers: ApiPrizeTier[] | null;
}

interface ApiPrizeTier {
  tier_id: number;
  normal_matches: number;
  bonusball_match: boolean;
  payout: ApiAmount;
  ticket_count: number;
}

interface ApiTicket {
  id: string;
  user_ticket_id: string; // on-chain NFT token id — the arg claimWinnings expects
  round_id: string;
  normals: number[];
  bonusball: number;
  matched_normals: number | null;
  bonusball_match: boolean | null;
  winnings_amount: ApiAmount | null;
  claimed: boolean;
  created_at: string;
}

interface ApiPaginated<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateQuickPick(
  ballMax: number,
  bonusballMax: number,
): TicketSelection {
  const normals = new Set<number>();
  while (normals.size < 5) {
    normals.add(Math.floor(Math.random() * ballMax) + 1);
  }
  return {
    normals: [...normals].sort((a, b) => a - b),
    bonusball: Math.floor(Math.random() * bonusballMax) + 1,
  };
}

function formatCountdown(targetSeconds: number): string {
  const diff = targetSeconds * 1000 - Date.now();
  if (diff <= 0) return "DRAWING NOW";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1_000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatUSDC(value: bigint): string {
  return formatUnits(value, USDC_DECIMALS);
}

// Jackpot odds for the current game: C(ballMax, 5) × bonusballMax. Computed
// from live drawing state so the copy can never drift from the real game.
function jackpotOdds(ballMax: number, bonusballMax: number): number {
  let combos = 1;
  for (let i = 0; i < 5; i++) combos = (combos * (ballMax - i)) / (i + 1);
  return Math.round(combos) * bonusballMax;
}

function formatApiAmount(amount: ApiAmount | null | undefined): string {
  if (!amount) return "0";
  return (Number(amount.amount) / 10 ** amount.decimals).toFixed(2);
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── "The Sweat" — first-view staggered results check ────────────────
// A newly settled ticket reveals its matches one ball at a time, once. Seen
// ticket ids are remembered locally so the drama never replays.
const SWEAT_SEEN_KEY = "farpot-sweated-tickets";

function getSweatedIds(): Set<string> {
  try {
    return new Set(
      JSON.parse(localStorage.getItem(SWEAT_SEEN_KEY) ?? "[]") as string[],
    );
  } catch {
    return new Set();
  }
}

function markSweated(ids: string[]) {
  try {
    const seen = getSweatedIds();
    ids.forEach((id) => seen.add(id));
    localStorage.setItem(SWEAT_SEEN_KEY, JSON.stringify([...seen].slice(-200)));
  } catch {
    /* storage unavailable (private mode) — the reveal just replays next visit */
  }
}

// ── API fetch helpers ────────────────────────────────────────────────

async function fetchApi<T>(path: string): Promise<ApiPaginated<T> | null> {
  try {
    const res = await fetch(`${MEGAPOT_API_BASE}${path}`);
    if (!res.ok) return null;
    return res.json() as Promise<ApiPaginated<T>>;
  } catch {
    return null;
  }
}

// ── Read ?tab from URL (must be in Suspense for Next.js 16) ─────────

function TabReader({ onTab }: { onTab: (tab: TabKey) => void }) {
  const searchParams = useSearchParams();
  const tab = (searchParams?.get("tab") as TabKey) ?? "play";
  useEffect(() => onTab(tab), [tab, onTab]);
  return null;
}

// ── Gift mode state ────────────────────────────────────────────────

interface GiftState {
  address: `0x${string}` | null;
  username: string | null;
}

// ── Read ?gift=\u003caddress\u003e\u0026to=\u003cusername\u003e from URL ────────

function GiftReader({ onGift }: { onGift: (gift: GiftState) => void }) {
  const searchParams = useSearchParams();
  const giftAddr = searchParams?.get("gift");
  const toUser = searchParams?.get("to");
  const noWalletFid = searchParams?.get("no_wallet");
  useEffect(() => {
    if (noWalletFid) {
      // Target has no verified address — signal this to parent
      onGift({ address: null, username: `no-wallet-${noWalletFid}` });
      return;
    }
    if (giftAddr) {
      // Validate it looks like an Ethereum address
      if (/^0x[a-fA-F0-9]{40}$/.test(giftAddr)) {
        onGift({ address: giftAddr as `0x${string}`, username: toUser || null });
      } else {
        onGift({ address: null, username: null });
      }
    } else {
      onGift({ address: null, username: null });
    }
  }, [giftAddr, toUser, noWalletFid, onGift]);
  return null;
}

// ── Gift user search state (plain gift entry) ──────────────────────

interface SearchUserResult {
  fid: number;
  username: string;
  verified_address: `0x${string}` | null;
}

// ── Odometer jackpot headline ──────────────────────────────────────
// Digits roll into place mechanically instead of swapping as text. The final
// resting value is always the real API value — the roll is presentation only.
const ODO_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function Odometer({ value }: { value: number }) {
  // The contract's jackpot-tier payout does not change on every unique ticket
  // purchase, so whole dollars avoid implying false per-ticket precision.
  const str = value.toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
  // First paint renders every strip at 0; arming on the next frame transitions
  // each digit to its target so the number visibly rolls in on mount.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <span className="odometer" role="text" aria-label={`$${str}`}>
      <span aria-hidden="true">$</span>
      {str.split("").map((ch, i) =>
        /\d/.test(ch) ? (
          <span key={`${str.length}-${i}`} className="odo-col" aria-hidden="true">
            <span
              className="odo-strip"
              style={{ transform: `translateY(${armed ? -Number(ch) : 0}em)` }}
            >
              {ODO_DIGITS.map((d) => (
                <b key={d}>{d}</b>
              ))}
            </span>
          </span>
        ) : (
          <span key={`${str.length}-${i}`} aria-hidden="true">
            {ch}
          </span>
        ),
      )}
    </span>
  );
}

// ── Shared FAR ★ POT lockup from the approved brand mockup ─────────
function Logo({ scale = 1 }: { scale?: number }) {
  return (
    <Image
      src="/wordmark-v1.png"
      alt="Farpot"
      width={942}
      height={252}
      priority
      className="mx-auto h-auto"
      style={{ width: `${210 * scale}px` }}
    />
  );
}

// ── Bottom tab navigation (floating pill) ────────────────────────
// Brief item 4b: green badge dot on Results when claimable winnings exist
function BottomNav({ activeTab, onTabChange, hasClaimable }: { activeTab: TabKey; onTabChange: (tab: TabKey) => void; hasClaimable?: boolean }) {
  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-50" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <nav className="flex items-center gap-1 px-3 py-2 rounded-full bg-white/95 backdrop-blur-md border border-slate-200 shadow-lg shadow-slate-300/40">
        {[
          {
            key: 'play' as TabKey,
            icon: (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="6" width="20" height="12" rx="3" />
                <line x1="6" y1="10" x2="6" y2="14" />
                <line x1="4" y1="12" x2="8" y2="12" />
                <circle cx="15" cy="10.5" r="0.75" fill="currentColor" />
                <circle cx="18" cy="13.5" r="0.75" fill="currentColor" />
              </svg>
            ),
            label: 'Play',
          },
          {
            key: 'gift' as TabKey,
            icon: (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="8" width="18" height="4" rx="1" />
                <rect x="3" y="14" width="18" height="4" rx="1" />
                <path d="M8 8V6a2 2 0 012-2h4a2 2 0 012 2v2" />
                <line x1="12" y1="8" x2="12" y2="14" />
              </svg>
            ),
            label: 'Gift',
          },
          {
            key: 'results' as TabKey,
            icon: (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="12" width="4" height="8" rx="1" />
                <rect x="10" y="6" width="4" height="14" rx="1" />
                <rect x="17" y="9" width="4" height="11" rx="1" />
              </svg>
            ),
            label: 'Results',
          },
        ].map(({ key, icon, label }) => (
          <button
            key={key}
            onClick={() => onTabChange(key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-full transition-colors relative ${
              activeTab === key
                ? 'bg-royal/10 text-royal'
                : 'text-mut/70 hover:text-navy hover:bg-slate-100'
            }`}
          >
            <span>{icon}</span>
            <span className="text-[12px] font-heading font-bold tracking-wide">{label}</span>
            {key === 'results' && hasClaimable && (
              <span className="absolute top-1 right-2 w-1.5 h-1.5 rounded-full bg-wins-green" />
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────

export default function Home() {
  const config = useConfig();
  const { address, isConnected } = useAccount();

  // ── Dismiss the Farcaster splash screen ───────────────
  const { setMiniAppReady, isMiniAppReady } = useMiniKit();
  useEffect(() => {
    if (!isMiniAppReady) setMiniAppReady();
  }, [isMiniAppReady, setMiniAppReady]);

  // ── Tab state (deep-linkable via ?tab=results) ────────────────
  const [activeTab, setActiveTab] = useState<TabKey>("play");

  // ── Gift state (deep-linkable via ?gift=<addr>&to=<user>) ──
  const [giftState, setGiftState] = useState<GiftState>({
    address: null,
    username: null,
  });

  // Auto-switch to Gift tab when a gift deep-link is detected. Gift and recurring
  // are mutually exclusive for v1 — a gift is a one-time gesture, so force the
  // Repeat-daily switch off whenever gift mode engages.
  useEffect(() => {
    if (giftState.address) {
      setActiveTab("gift");
      setIsRecurring(false);
    }
  }, [giftState.address]);

  // ── Plain gift search state ────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchUserResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  // ── Contract reads ────────────────────────────────────────────────
  const { data: currentDrawingId, refetch: refetchDrawingId } = useReadContract({
    address: JACKPOT_ADDRESS,
    abi: JACKPOT_ABI,
    functionName: "currentDrawingId",
    query: { refetchInterval: 60_000 },
  });

  const { data: drawingStateRaw, isLoading: loadingState, refetch: refetchDrawingState } = useReadContract({
    address: JACKPOT_ADDRESS,
    abi: JACKPOT_ABI,
    functionName: "getDrawingState",
    args: currentDrawingId !== undefined ? [currentDrawingId] : undefined,
    query: { enabled: currentDrawingId !== undefined, refetchInterval: 60_000 },
  });

  const { data: tierPayouts, refetch: refetchTierPayouts } = useReadContract({
    address: JACKPOT_ADDRESS,
    abi: JACKPOT_ABI,
    functionName: "getDrawingTierPayouts",
    args: currentDrawingId !== undefined ? [currentDrawingId] : undefined,
    query: { enabled: currentDrawingId !== undefined, refetchInterval: 60_000 },
  });

  const { data: usdcBalance, refetch: refetchUsdcBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // ── Purchase route / allowance (play + gift tab) ──────────────────
  // Small one-time Play orders are editable slips. Large orders and gifts use
  // RandomTicketBuyer so the contract assigns every combination on-chain.
  const [quantity, setQuantity] = useState(1);
  const purchaseUsesOnchainRandom = quantity > 10 || activeTab === "gift";
  const targetContract = purchaseUsesOnchainRandom
    ? RANDOM_TICKET_BUYER_ADDRESS
    : JACKPOT_ADDRESS;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "allowance",
    args: address ? [address, targetContract] : undefined,
    query: { enabled: !!address && (activeTab === "play" || activeTab === "gift") },
  });

  // ── Derived drawing state ────────────────────────────────────────
  const drawingState = useMemo<DrawingState | null>(() => {
    if (!drawingStateRaw) return null;
    type RawDrawingState = Record<string, bigint | number | boolean | string>;
    const ds = drawingStateRaw as unknown as RawDrawingState;
    return {
      prizePool: (ds.prizePool as bigint) ?? BigInt(0),
      ticketPrice: (ds.ticketPrice as bigint) ?? BigInt(0),
      globalTicketsBought: (ds.globalTicketsBought as bigint) ?? BigInt(0),
      ballMax: Number(ds.ballMax ?? 0),
      bonusballMax: Number(ds.bonusballMax ?? 0),
      drawingTime: Number(ds.drawingTime ?? 0),
      jackpotLock: Boolean(ds.jackpotLock ?? false),
    };
  }, [drawingStateRaw]);

  // Recent settled rounds: social proof strips and results history.
  const [recentRounds, setRecentRounds] = useState<ApiRound[]>([]);

  // Index 11 is the 5-normal + bonusball jackpot tier. Using the contract's
  // current-drawing payout avoids estimating it from historical round ratios.
  const jackpotTierPayout = tierPayouts?.[11];
  const headlineJackpotUsd =
    jackpotTierPayout !== undefined ? Number(formatUSDC(jackpotTierPayout)) : null;

  const isSalesOpen = !drawingState?.jackpotLock;

  // ── Play tab state ───────────────────────────────────────────────
  const [ticketSelections, setTicketSelections] = useState<TicketSelection[]>([]);
  const [editingTicketIndex, setEditingTicketIndex] = useState<number | null>(null);
  // Quantity presets: 1 / 5 / 10 / Custom.
  const [qtyPreset, setQtyPreset] = useState<QtyPreset>("1");
  const [buyPhase, setBuyPhase] = useState<BuyPhase>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [countdown, setCountdown] = useState("--:--:--");

  // ── Quick-pick number reveal state ────────────────────────────────
  // After a quick-pick purchase, the real assigned numbers are unknown until
  // the API returns them. We show a shuffle animation during the pending state
  // that resolves onto the actual numbers once fetched.
  const [resolvedQuickPick, setResolvedQuickPick] = useState<TicketSelection | null>(null);
  const [isShuffling, setIsShuffling] = useState(false);
  const [shuffleDisplay, setShuffleDisplay] = useState<TicketSelection>({ normals: [0, 0, 0, 0, 0], bonusball: 0 });
  // Set when we bought a quick-pick but could NOT confirm the freshly-minted
  // numbers from the API (indexer lag / no baseline). We must never show a stale
  // or other ticket's numbers as "yours" — fall back to pointing at Results.
  const [quickPickPending, setQuickPickPending] = useState(false);

  // Keep a distinct shuffled selection ready for every editable slip. Shrinking
  // quantity intentionally preserves hidden selections so increasing it again
  // does not unexpectedly replace a user's earlier choices.
  useEffect(() => {
    if (!drawingState || quantity > 10) return;
    const timer = window.setTimeout(() => {
      setTicketSelections((current) => {
        if (current.length >= quantity) return current;
        const additions = Array.from({ length: quantity - current.length }, () =>
          generateQuickPick(drawingState.ballMax, drawingState.bonusballMax),
        );
        return [...current, ...additions];
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [drawingState, quantity]);

  // Slot-machine shuffle effect — cycles random numbers while isShuffling is true
  useEffect(() => {
    if (!isShuffling || !drawingState) return;
    const interval = setInterval(() => {
      setShuffleDisplay({
        normals: Array.from({ length: 5 }, () => Math.floor(Math.random() * drawingState.ballMax) + 1).sort((a, b) => a - b),
        bonusball: Math.floor(Math.random() * drawingState.bonusballMax) + 1,
      });
    }, 80); // fast cycle for slot-machine feel
    return () => clearInterval(interval);
  }, [isShuffling, drawingState]);

  // ── Countdown timer ──────────────────────────────────────────────
  // isGoldenHour: final hour before the draw (and the draw itself) flips the
  // jackpot card into its night look — urgency you can feel, not read.
  const [isGoldenHour, setIsGoldenHour] = useState(false);
  useEffect(() => {
    if (!drawingState) return;
    const tickClock = () =>
      setCountdown(formatCountdown(Number(drawingState.drawingTime)));
    const tickGolden = () =>
      setIsGoldenHour(
        Number(drawingState.drawingTime) * 1000 - Date.now() < 3_600_000,
      );
    tickClock();
    tickGolden();
    const interval = setInterval(() => {
      tickClock();
      tickGolden();
    }, 1_000);
    return () => clearInterval(interval);
  }, [drawingState]);

  // Clear stale buy-phase / error state when switching tabs, changing recipient,
  // or changing quantity — prevents a success/error banner from one context
  // leaking into another (e.g. Play buy → switch to Gift tab shows "@friend").
  useEffect(() => {
    setBuyPhase("idle");
    setErrorMessage("");
  }, [activeTab, quantity, giftState.address]);

  // ── Recurring / Subscription state ─────────────────────────────────

  const [isRecurring, setIsRecurring] = useState(false);
  const [subDuration, setSubDuration] = useState(7); // days
  const [subTicketsPerDay, setSubTicketsPerDay] = useState(1);
  const [subPhase, setSubPhase] = useState<SubPhase>("idle");
  const [subError, setSubError] = useState("");
  // Active-sub banner "Manage" expand toggle (brief item 5)
  const [manageOpen, setManageOpen] = useState(false);

  // Repeat-daily switch (brief items 1-2). Snap the current one-time quantity to
  // the nearest recurring preset (1/2/3/5) when turning the switch ON, so an
  // invalid value (e.g. 10) never carries into the subscription.
  const setRepeatDaily = (on: boolean) => {
    if (on) {
      const nearest = [1, 2, 3, 5].reduce(
        (best, p) => (Math.abs(p - quantity) < Math.abs(best - quantity) ? p : best),
        1,
      );
      setSubTicketsPerDay(nearest);
    }
    setIsRecurring(on);
  };

  // Read subscription info for connected wallet
  const { data: subInfoRaw, refetch: refetchSubInfo } = useReadContract({
    address: AUTO_SUBSCRIPTION_ADDRESS,
    abi: AUTO_SUBSCRIPTION_ABI,
    functionName: "getSubscriptionInfo",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Derived subscription info
  const subInfo = useMemo<SubscriptionInfo | null>(() => {
    if (!subInfoRaw) return null;
    type RawSub = Record<string, boolean | bigint | number | unknown[]>;
    const s = subInfoRaw as unknown as RawSub;
    return {
      isActive: Boolean(s.isActive ?? false),
      daysRemaining: Number(s.daysRemaining ?? 0),
      balance: (s.balance as bigint) ?? BigInt(0),
      dynamicTicketCount: Number(s.dynamicTicketCount ?? 0),
    };
  }, [subInfoRaw]);

  // Subscription total cost = ticketPrice × subTicketsPerDay × subDuration
  const subTotalCost = useMemo(() => {
    if (!drawingState) return BigInt(0);
    return drawingState.ticketPrice * BigInt(subTicketsPerDay) * BigInt(subDuration);
  }, [drawingState, subTicketsPerDay, subDuration]);

  // ── Mode / allowance (play + gift tab) ────────────────────────────
  const totalCost = useMemo(() => {
    if (!drawingState) return BigInt(0);
    return drawingState.ticketPrice * BigInt(quantity);
  }, [drawingState, quantity]);

  const needsApproval = useMemo(() => {
    if (totalCost === BigInt(0)) return false;
    // Treat undefined (still loading) as "needs approval" to prevent firing a buy
    // before we know the allowance state. This avoids the allowance race that
    // occurs when switching PICK → QUICK and targetContract flips.
    if (allowance === undefined) return true;
    return allowance < totalCost;
  }, [allowance, totalCost]);

  const isValidSelection = useMemo(() => {
    if (purchaseUsesOnchainRandom) return drawingState !== null;
    return (
      ticketSelections.length >= quantity &&
      ticketSelections
        .slice(0, quantity)
        .every((ticket) => ticket.normals.length === 5 && ticket.bonusball > 0)
    );
  }, [purchaseUsesOnchainRandom, ticketSelections, quantity, drawingState]);

  const canBuy =
    isConnected &&
    isValidSelection &&
    isSalesOpen &&
    buyPhase === "idle" &&
    usdcBalance !== undefined &&
    usdcBalance >= totalCost &&
    allowance !== undefined; // Block while allowance loads — prevents allowance race on mode switch

  // ── Share-to-cast ────────────────────────────────────────────────
  const { composeCast } = useComposeCast();

  const handleShare = useCallback(() => {
    if (!drawingState) return;
    const ticketPriceUsd = Number(formatUSDC(drawingState.ticketPrice));
    const formattedJackpot =
      headlineJackpotUsd == null
        ? null
        : headlineJackpotUsd >= 1_000_000
          ? `$${(headlineJackpotUsd / 1_000_000).toFixed(1)}M`
          : `$${(headlineJackpotUsd / 1_000).toFixed(0)}K`;
    const jackpotPhrase = formattedJackpot ? ` — ${formattedJackpot} jackpot` : "";

    if (giftState.address) {
      composeCast({
        text: `🎰 Gifted a lottery ticket to @${giftState.username || "friend"} on Farpot${jackpotPhrase}! Good luck! 🍀`,
        embeds: [APP_URL],
      });
    } else {
      composeCast({
        text: `Just grabbed a lottery ticket on Farpot 🎰${jackpotPhrase} — ${ticketPriceUsd} USDC a ticket. Try your luck:`,
        embeds: [APP_URL],
      });
    }
  }, [composeCast, drawingState, giftState, headlineJackpotUsd]);

  // ── Gift user search (Neynar API) ──────────────────────────────

  const handleSearchUser = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError("");
    try {
      const res = await fetch("/api/gift/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim() }),
      });
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      const found = data.results || [];
      setSearchResults(found);
      if (found.length === 0) {
        setSearchError(
          `No Farcaster user @${query.trim().replace(/^@/, "")} found.`,
        );
      }
    } catch {
      setSearchError("Could not look up that user.");
    } finally {
      setSearching(false);
    }
  }, []);

  const handleSelectGiftRecipient = useCallback(
    (result: SearchUserResult) => {
      if (!result.verified_address) {
        setSearchError(`@${result.username} hasn't connected a wallet yet.`);
        return;
      }
      setGiftState({
        address: result.verified_address,
        username: result.username,
      });
      setSearchQuery("");
      setSearchResults([]);
      setSearchError("");
    },
    [],
  );

  const handleGiftSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      handleSearchUser(searchQuery);
    },
    [searchQuery, handleSearchUser],
  );

  // ── Handlers ─────────────────────────────────────────────────────

  const handleShuffleSelections = useCallback(() => {
    if (!drawingState) return;
    haptics.impact();
    setTicketSelections((current) => {
      const next = [...current];
      for (let index = 0; index < Math.min(quantity, 10); index += 1) {
        next[index] = generateQuickPick(drawingState.ballMax, drawingState.bonusballMax);
      }
      return next;
    });
  }, [drawingState, quantity]);

  const toggleBall = useCallback(
    (num: number) => {
      if (editingTicketIndex === null) return;
      haptics.select();
      setTicketSelections((current) =>
        current.map((ticket, index) => {
          if (index !== editingTicketIndex) return ticket;
          const isSelected = ticket.normals.includes(num);
          const normals = isSelected
            ? ticket.normals.filter((n) => n !== num)
            : ticket.normals.length < 5
              ? [...ticket.normals, num].sort((a, b) => a - b)
              : ticket.normals;
          return { ...ticket, normals };
        }),
      );
    },
    [editingTicketIndex],
  );

  const toggleBonus = useCallback(
    (num: number) => {
      if (editingTicketIndex === null) return;
      haptics.select();
      setTicketSelections((current) =>
        current.map((ticket, index) =>
          index === editingTicketIndex
            ? { ...ticket, bonusball: ticket.bonusball === num ? 0 : num }
            : ticket,
        ),
      );
    },
    [editingTicketIndex],
  );

  // Intentionally NOT wrapped in useCallback — a plain async function reads
  // fresh closure values (quantity, totalCost, needsApproval) from the current
  // render, avoiding any stale-capture risk on the buy path.
  const handleBuy = async () => {
    if (!address || !drawingState || !isValidSelection || !isSalesOpen) return;

    // Determine recipient: gift address if in gift mode, otherwise buyer's address
    const recipient: `0x${string}` = giftState.address ?? address;

    haptics.impact();

    try {
      setErrorMessage("");

      // Step 1: Approve USDC spending if needed
      if (needsApproval) {
        setBuyPhase("approving");
        const approveHash = await writeContract(config, {
          address: USDC_ADDRESS,
          abi: USDC_ABI,
          functionName: "approve",
          args: [targetContract, totalCost],
        });
        const approveReceipt = await waitForTransactionReceipt(config, {
          hash: approveHash,
        });
        if (approveReceipt.status === "reverted") {
          throw new Error("Approval transaction reverted");
        }
      }

      // Step 2: Buy tickets
      setBuyPhase("buying");

      // Estimate gas with 1.5× buffer — RandomTicketBuyer has a heavy internal
      // call that OOGs at the bare estimate (see tx c903…b6fd on Base).
      const buyArgs =
        purchaseUsesOnchainRandom
          ? ([BigInt(quantity), recipient, [REFERRAL_WALLET], [REFERRAL_SPLIT], SOURCE] as const)
          : ([
                ticketSelections.slice(0, quantity).map((t) => ({
                  normals: t.normals,
                  bonusball: t.bonusball,
                })),
                recipient,
                [REFERRAL_WALLET],
                [REFERRAL_SPLIT],
                SOURCE,
              ] as const);

      const buyTarget = purchaseUsesOnchainRandom ? RANDOM_TICKET_BUYER_ADDRESS : JACKPOT_ADDRESS;
      const buyAbi = purchaseUsesOnchainRandom ? RANDOM_TICKET_BUYER_ABI : JACKPOT_ABI;

      // Encode calldata so we can estimate gas before signing
      const buyCalldata = encodeFunctionData({
        abi: buyAbi,
        functionName: "buyTickets",
        args: buyArgs,
      });

      // Estimate gas with 1.5× buffer — RandomTicketBuyer has a heavy internal
      // call that OOGs at the bare estimate (see tx c903…b6fd on Base).
      const estimatedGas = await estimateGas(config, {
        account: address,
        to: buyTarget,
        data: buyCalldata,
      });
      // 1.5× buffer — pure BigInt math. (A non-integer reaching BigInt() throws
      // RangeError, which would crash the buy before it ever reaches the wallet.)
      const bufferedGas = (estimatedGas * BigInt(3)) / BigInt(2);

      // Snapshot the buyer's latest indexed ticket BEFORE minting, so afterward we
      // can tell a freshly-indexed ticket apart from a stale one and never reveal
      // numbers that aren't from THIS purchase. Tri-state: preBuyOk=false means we
      // couldn't establish a baseline → the reveal is skipped for the safe fallback.
      let preBuyOk = false;
      let preBuySig: string | null = null;
      if (purchaseUsesOnchainRandom) {
        try {
          const snapAddr = giftState.address ?? address;
          const snap = await fetch(`${MEGAPOT_API_BASE}/wallets/${snapAddr}/tickets?limit=1`);
          if (snap.ok) {
            const snapData = await snap.json();
            preBuyOk = true;
            preBuySig = snapData?.data?.[0] ? JSON.stringify(snapData.data[0]) : null;
          }
        } catch {
          /* baseline is best-effort; leaving preBuyOk=false forces the safe fallback */
        }
      }

      const buyHash = await writeContract(config, {
        address: buyTarget,
        abi: buyAbi,
        functionName: "buyTickets",
        args: buyArgs,
        gas: bufferedGas,
      });
      const buyReceipt = await waitForTransactionReceipt(config, {
        hash: buyHash,
      });
      if (buyReceipt.status === "reverted") {
        throw new Error("REVERTED");
      }

      setBuyPhase("success");
      haptics.success();
      // Refetch on-chain reads so balance + jackpot update immediately
      refetchUsdcBalance();
      refetchDrawingState();
      refetchTierPayouts();
      // The exact-amount approval was just consumed by this buy, so on-chain
      // allowance is back to ~0. Refetch it, otherwise a second buy this session
      // reads a stale allowance, skips the now-needed re-approval, and reverts.
      refetchAllowance();
      // Bump results refresh so a newly-minted ticket re-pulls from API
      setResultsRefresh((n) => n + 1);

      // For quick-pick: reveal the REAL assigned numbers, but only once a ticket
      // NEWER than the pre-mint baseline is indexed. Otherwise fall back to a
      // "see Results" pointer — never show stale or fabricated numbers as yours.
      if (purchaseUsesOnchainRandom) {
        setResolvedQuickPick(null);
        setQuickPickPending(false);
        if (!preBuyOk) {
          // No baseline → can't prove freshness → don't risk a stale reveal.
          setQuickPickPending(true);
        } else {
          setIsShuffling(true);
          const buyerAddr = giftState.address ?? address;
          let revealed: TicketSelection | null = null;
          // Poll a few times to absorb indexer lag (~6s worst case).
          for (let i = 0; i < 5 && !revealed; i++) {
            try {
              const res = await fetch(`${MEGAPOT_API_BASE}/wallets/${buyerAddr}/tickets?limit=1`);
              if (res.ok) {
                const data = await res.json();
                const top = data?.data?.[0];
                // Only accept a ticket that differs from the pre-mint baseline.
                if (top && JSON.stringify(top) !== preBuySig) {
                  revealed = { normals: top.normals, bonusball: top.bonusball };
                }
              }
            } catch {
              /* transient — keep polling */
            }
            if (!revealed) await new Promise((r) => setTimeout(r, 1200));
          }
          if (revealed) {
            setResolvedQuickPick(revealed);
            // Stop shuffling after a beat so the animation resolves smoothly
            setTimeout(() => setIsShuffling(false), 600);
          } else {
            // Ticket not indexed in time — stop the shuffle, point at Results.
            setIsShuffling(false);
            setQuickPickPending(true);
          }
        }
      }
    } catch (err: unknown) {
      console.error("Buy failed:", err);
      const raw = err instanceof Error ? err.message : String(err);
      const rejected = /user rejected|user denied|rejected the request/i.test(raw);
      // REVERTED is thrown by our own code when buyReceipt.status === "reverted"
      // — hard revert / OOG. The tx definitely failed and funds are safe.
      const reverted = raw === "REVERTED";
      setBuyPhase("error");
      haptics.error();
      // Gift buys can fail if the recipient's wallet can't receive ticket NFTs.
      // Surface that possibility only on a real failure (not as an upfront block —
      // most smart-contract wallets DO receive fine, so a pre-warning would be noise).
      const giftHint = giftState.address
        ? " If it keeps failing, the recipient's wallet may not be able to receive ticket NFTs."
        : "";
      setErrorMessage(
        rejected
          ? "Transaction cancelled."
          : reverted
            ? `Transaction failed on-chain — you weren't charged.${giftHint}`
            : `Couldn't confirm the purchase. If your wallet shows a minted ticket it went through — otherwise tap Try again.${giftHint}`,
      );
    }
  };

  const handleReset = useCallback(() => {
    setBuyPhase("idle");
    setErrorMessage("");
    setResolvedQuickPick(null);
    setIsShuffling(false);
    setQuickPickPending(false);
  }, []);

  // ── Social proof: recent rounds (public, no wallet needed) ────────
  // Brief item 3 — ticket ticker + recent wins strip + fairness line.
  // Re-polled every 60s so the headline's top-tier ratio follows a round
  // settling while the app is open. (recentRounds state lives up by the
  // headline derivation, which consumes it.)
  useEffect(() => {
    const pull = () =>
      fetchApi<ApiRound>("/rounds?limit=10").then((res) => {
        if (res) setRecentRounds(res.data.filter((r) => r.status === "settled"));
      });
    pull();
    const interval = setInterval(pull, 60_000);
    return () => clearInterval(interval);
  }, []);

  // ── Subscription allowance (for recurring mode) ────────────────────

  const { data: subAllowance, refetch: refetchSubAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "allowance",
    args: address ? [address, AUTO_SUBSCRIPTION_ADDRESS] : undefined,
    query: { enabled: !!address && isRecurring && activeTab === "play" },
  });

  // ── Subscription handlers ──────────────────────────────────────────

  const handleCreateSubscription = async () => {
    if (!address || !drawingState || !isSalesOpen) return;

    try {
      setSubError("");

      // Step 1: Approve USDC spending for AutoSubscription if needed
      const needsSubApproval =
        subAllowance === undefined || subAllowance < subTotalCost;
      if (needsSubApproval) {
        setSubPhase("approving");
        const approveHash = await writeContract(config, {
          address: USDC_ADDRESS,
          abi: USDC_ABI,
          functionName: "approve",
          args: [AUTO_SUBSCRIPTION_ADDRESS, subTotalCost],
        });
        const approveReceipt = await waitForTransactionReceipt(config, {
          hash: approveHash,
        });
        if (approveReceipt.status === "reverted") {
          throw new Error("Approval transaction reverted");
        }
      }

      // Step 2: Create subscription
      setSubPhase("subscribing");

      const ticketsPerDay = BigInt(subTicketsPerDay);
      const totalDays = BigInt(subDuration);

      // Recurring buys always request fresh on-chain random combinations.
      const staticTickets: TicketSelection[] = [];
      const dynamicCount = ticketsPerDay;

      const subHash = await writeContract(config, {
        address: AUTO_SUBSCRIPTION_ADDRESS,
        abi: AUTO_SUBSCRIPTION_ABI,
        functionName: "createSubscription",
        args: [
          address,              // _recipient
          totalDays,           // _totalDays
          dynamicCount,        // _dynamicTicketCount
          staticTickets,       // _userStaticTickets
          [REFERRAL_WALLET],   // _referrers
          [REFERRAL_SPLIT],    // _referralSplit (100% to our referrer)
          SOURCE,             // _source
        ],
      });
      const subReceipt = await waitForTransactionReceipt(config, {
        hash: subHash,
      });
      if (subReceipt.status === "reverted") {
        throw new Error("Subscription creation reverted");
      }

      setSubPhase("success");
      refetchUsdcBalance();
      refetchSubInfo();
    } catch (err: unknown) {
      console.error("Subscription failed:", err);
      const raw = err instanceof Error ? err.message : String(err);
      const rejected = /user rejected|user denied|rejected the request/i.test(raw);
      setSubPhase("error");
      setSubError(
        rejected
          ? "Transaction cancelled."
          : raw.includes("reverted")
            ? "Subscription creation failed on-chain — you weren't charged."
            : "Couldn't confirm the subscription. If your wallet shows it went through, otherwise tap to try again.",
      );
    }
  };

  const handleCancelSubscription = async () => {
    if (!address) return;

    try {
      setSubPhase("cancelling");
      setSubError("");

      const cancelHash = await writeContract(config, {
        address: AUTO_SUBSCRIPTION_ADDRESS,
        abi: AUTO_SUBSCRIPTION_ABI,
        functionName: "cancelSubscription",
        args: [],
      });
      const cancelReceipt = await waitForTransactionReceipt(config, {
        hash: cancelHash,
      });
      if (cancelReceipt.status === "reverted") {
        throw new Error("Cancel reverted");
      }

      setSubPhase("success");
      refetchUsdcBalance();
      refetchSubInfo();
    } catch (err: unknown) {
      console.error("Cancel failed:", err);
      const raw = err instanceof Error ? err.message : String(err);
      const rejected = /user rejected|user denied|rejected the request/i.test(raw);
      setSubPhase("error");
      setSubError(
        rejected
          ? "Cancel cancelled."
          : "Couldn't confirm the cancellation.",
      );
    }
  };

  const handleResetSub = useCallback(() => {
    setSubPhase("idle");
    setSubError("");
  }, []);

  // ── Results tab state ────────────────────────────────────────────
  const [pastRounds, setPastRounds] = useState<ApiRound[]>([]);
  const [userTickets, setUserTickets] = useState<ApiTicket[]>([]);
  const [loadingResults, setLoadingResults] = useState(false);
  const [resultsRefresh, setResultsRefresh] = useState(0); // bump to refetch after a claim

  // ── Claim state ──────────────────────────────────────────────────
  type ClaimPhase = "idle" | "claiming" | "success" | "error";
  const [claimPhase, setClaimPhase] = useState<ClaimPhase>("idle");
  const [claimError, setClaimError] = useState("");
  const [claimingIds, setClaimingIds] = useState<string[]>([]); // API ids in flight
  const [optimisticallyClaimedIds, setOptimisticallyClaimedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [lastClaimedAmount, setLastClaimedAmount] = useState<bigint>(BigInt(0));
  const [lastClaimedTickets, setLastClaimedTickets] = useState<ApiTicket[]>([]);

  // Map round id → its winning numbers, so a ticket can be checked against the
  // ACTUAL draw (matched_normals is only a count — it doesn't say which hit).
  const winningByRound = useMemo(() => {
    const m = new Map<string, { normals: number[]; bonusball: number }>();
    for (const r of pastRounds) {
      if (r.winning_numbers) m.set(r.id, r.winning_numbers);
    }
    return m;
  }, [pastRounds]);

  // Unclaimed winning tickets (winnings > 0 and not yet claimed). The on-chain
  // claim takes `user_ticket_id` (the NFT token id), not the API's small `id`.
  const claimableWins = useMemo(
    () =>
      userTickets.filter(
        (t) =>
          !t.claimed &&
          !optimisticallyClaimedIds.has(t.id) &&
          t.winnings_amount != null &&
          Number(t.winnings_amount.amount) > 0,
      ),
    [userTickets, optimisticallyClaimedIds],
  );

  const totalClaimable = useMemo(
    () =>
      claimableWins.reduce(
        (sum, t) => sum + BigInt(t.winnings_amount!.amount),
        BigInt(0),
      ),
    [claimableWins],
  );

  // ── The Sweat: stagger-reveal freshly settled tickets together ──
  // sweatStep counts revealed columns shared by the group: 0..4 normals,
  // 5 bonus, 6 verdict shown. Every fresh ticket from the newest settled draw
  // advances on the same clock so buying several does not multiply the wait.
  const [sweatTicketIds, setSweatTicketIds] = useState<Set<string>>(() => new Set());
  const [sweatStep, setSweatStep] = useState(0);
  const sweatInProgress = sweatTicketIds.size > 0 && sweatStep < 7;

  // Called with freshly fetched tickets; decides whether a sweat reveal runs.
  const maybeStartSweat = useCallback((tickets: ApiTicket[]) => {
    const settled = tickets.filter((t) => t.matched_normals !== null);
    if (settled.length === 0) return;
    const seen = getSweatedIds();
    const newestFresh = settled.find((ticket) => !seen.has(ticket.id));
    // Reveal every unseen ticket from the newest newly-settled draw together.
    // Older history is still marked seen so a first visit does not animate a
    // long backlog of unrelated rounds.
    const fresh = newestFresh
      ? settled.filter(
          (ticket) => ticket.round_id === newestFresh.round_id && !seen.has(ticket.id),
        )
      : [];
    markSweated(settled.map((t) => t.id));
    if (fresh.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setSweatTicketIds(new Set(fresh.map((ticket) => ticket.id)));
    setSweatStep(0);
  }, []);

  // ── Results tab fetch (brief item 4: extend to initial load) ────
  // Fetch rounds on mount for social proof; fetch user tickets only when connected + Results visible.
  useEffect(() => {
    setLoadingResults(true);
    Promise.all([
      fetchApi<ApiRound>("/rounds?limit=10"),
      isConnected && address ? fetchApi<ApiTicket>(`/wallets/${address}/tickets?limit=20`) : null,
    ]).then(([roundsRes, ticketsRes]) => {
      if (roundsRes) setPastRounds(roundsRes.data.filter((r) => r.status === "settled"));
      if (ticketsRes) {
        setUserTickets(ticketsRes.data);
        maybeStartSweat(ticketsRes.data);
      }
      setLoadingResults(false);
    });
  }, [isConnected, address, resultsRefresh, activeTab, maybeStartSweat]);

  useEffect(() => {
    if (sweatTicketIds.size === 0 || sweatStep >= 7) return;
    const t = setTimeout(
      () => setSweatStep((s) => s + 1),
      sweatStep === 0 ? 750 : 620,
    );
    return () => clearTimeout(t);
  }, [sweatTicketIds, sweatStep]);

  // ── Claim handler ────────────────────────────────────────────────
  const handleClaim = useCallback(
    async (tickets: ApiTicket[]) => {
      if (!address || tickets.length === 0) return;
      const claimedAmount = tickets.reduce(
        (sum, ticket) => sum + BigInt(ticket.winnings_amount?.amount ?? "0"),
        BigInt(0),
      );
      setClaimError("");
      setClaimingIds(tickets.map((t) => t.id));
      setClaimPhase("claiming");
      try {
        const ids = tickets.map((t) => BigInt(t.user_ticket_id));
        const hash = await writeContract(config, {
          address: JACKPOT_ADDRESS,
          abi: JACKPOT_ABI,
          functionName: "claimWinnings",
          args: [ids],
        });
        const receipt = await waitForTransactionReceipt(config, { hash });
        if (receipt.status === "reverted") throw new Error("Claim reverted");
        setOptimisticallyClaimedIds((current) => {
          const next = new Set(current);
          tickets.forEach((ticket) => next.add(ticket.id));
          return next;
        });
        setLastClaimedAmount(claimedAmount);
        setLastClaimedTickets(tickets);
        setClaimPhase("success");
        haptics.success();
        // Refetch on-chain reads so balance updates immediately
        refetchUsdcBalance();
        setResultsRefresh((n) => n + 1); // re-pull tickets so they show as claimed
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : String(err);
        const rejected = /user rejected|user denied|rejected the request/i.test(raw);
        setClaimPhase("error");
        haptics.error();
        setClaimError(
          rejected
            ? "Claim cancelled."
            : "Couldn't confirm the claim. If your USDC balance went up it went through — otherwise tap to try again.",
        );
      } finally {
        setClaimingIds([]);
      }
    },
    [address, config],
  );

  const handleShareWinnings = useCallback(() => {
    if (lastClaimedAmount <= BigInt(0)) return;
    const featuredTicket = lastClaimedTickets[0];
    const params = new URLSearchParams({
      amount: formatUSDC(lastClaimedAmount),
      round: featuredTicket?.round_id ?? "",
      normals: featuredTicket?.normals.join(",") ?? "",
      bonus: featuredTicket ? String(featuredTicket.bonusball) : "",
      bonusHit: featuredTicket?.bonusball_match ? "1" : "0",
      tickets: String(lastClaimedTickets.length),
    });
    const cardUrl = `${APP_URL}/api/share/win-card?${params.toString()}`;
    composeCast({
      text: `I just won $${formatUSDC(lastClaimedAmount)} USDC on Farpot 🎉 Feeling lucky?`,
      embeds: [cardUrl, APP_URL],
    });
  }, [composeCast, lastClaimedAmount, lastClaimedTickets]);

  // ── Render: Loading ──────────────────────────────────────────────

  if (loadingState || !drawingState) {
    return (
      <div className="flex flex-col items-center justify-center flex-1">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-gold border-t-transparent" />
        <p className="text-mut mt-4">Loading jackpot data…</p>
      </div>
    );
  }

  // ── Render: Main UI (brief item 2: no early-return wall) ──────────

  return (
    <div className="app-shell flex flex-col flex-1 max-w-lg mx-auto w-full px-4 py-5 gap-4 pb-28">
      <Suspense fallback={null}>
        <TabReader onTab={setActiveTab} />
        <GiftReader onGift={setGiftState} />
      </Suspense>
      {/* Header */}
      <div className="text-center py-3">
        <Logo scale={1.35} />
      </div>

      {/* ── PLAY TAB ─────────────────────────────────────────────── */}

      {activeTab === "play" && (
        <>
          {/* Brief item 4a: slim claim banner on Play when totalClaimable > 0 */}
          {isConnected && totalClaimable > BigInt(0) && (
            <button
              onClick={() => setActiveTab("results")}
              className="w-full flex items-center justify-between rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-sm"
            >
              <span className="text-emerald-400 font-medium">
                🎉 You won <span className="font-bold">${formatUSDC(totalClaimable)}</span> — tap to claim
              </span>
              <span className="text-gold font-heading font-extrabold text-xs px-3 py-1.5 rounded-lg btn-gold">CLAIM</span>
            </button>
          )}

          {/* Jackpot info card — clean flagship surface with lottery accents.
              Final hour before the draw flips it into golden-hour night mode. */}
          <div className={`jackpot-card rounded-3xl p-6 space-y-5 ${isGoldenHour ? "jackpot-golden" : ""}`}>
            <div className="text-center">
              <p className="text-royal text-xs font-heading font-bold uppercase tracking-[0.22em]">
                Today&apos;s jackpot
              </p>
              <p className="jackpot-headline display gold-text pulse-gold text-6xl mt-2 tabular-nums">
                {headlineJackpotUsd != null ? <Odometer value={headlineJackpotUsd} /> : "…"}
              </p>
              <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-royal/25 bg-royal/10 px-3 py-1.5 text-xs font-semibold text-mut">
                <span className="h-1.5 w-1.5 rounded-full bg-wins-green" />
                <span className="font-bold text-cream tabular-nums">
                  {drawingState.globalTicketsBought.toLocaleString()}
                </span>{" "}
                tickets in today&apos;s draw
              </p>
            </div>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-mut text-[10px] uppercase tracking-wider">Draws In</p>
                <p className="jackpot-countdown text-royal font-heading font-extrabold text-lg">{countdown}</p>
              </div>
              <div>
                <p className="text-mut text-[10px] uppercase tracking-wider">Ticket</p>
                <p className="text-cream font-heading font-extrabold text-lg">
                  ${formatUSDC(drawingState.ticketPrice)}
                </p>
              </div>
              <div>
                <p className="text-mut text-[10px] uppercase tracking-wider">Status</p>
                <p
                  className={`font-heading font-extrabold text-lg ${
                    isSalesOpen ? "text-wins-green" : "text-win"
                  }`}
                >
                  {isSalesOpen ? "OPEN" : "LOCKED"}
                </p>
              </div>
            </div>
            {isGoldenHour && (
              <p className="golden-hour-note">⭐ Golden hour — the draw is close</p>
            )}
          </div>

          {/* Brief item 3a: ticket-count pill ticker from most recent settled round */}
          {recentRounds.length > 0 && (
            <div className="hidden">
              <span className="inline-flex items-center gap-2 text-xs font-semibold text-mut bg-royal/20 border border-royal/40 rounded-full px-3 py-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-wins-green" />
                <span className="text-cream font-bold">{recentRounds[0].ticket_count.toLocaleString()} tickets</span> in last draw
              </span>
            </div>
          )}

          {/* Brief item 3b: 3-card recent wins strip with verify links */}
          {recentRounds.filter((r) => r.winners_count > 0).length >= 1 && (
            <div className="hidden">
              {recentRounds
                .filter((r) => r.winners_count > 0 && r.top_prize_amount != null)
                .slice(0, 3)
                .map((round) => (
                  <a
                    key={round.id}
                    href={`https://basescan.org/address/${JACKPOT_ADDRESS}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 rounded-xl border border-white/7 bg-navy-card p-2 flex flex-col gap-0.5 text-center"
                  >
                    <span className="text-[10px] text-mut truncate">Round #{round.id}</span>
                    <span className="text-wins-green font-extrabold text-xs tabular-nums">
                      ${formatApiAmount(round.top_prize_amount)}
                    </span>
                    <span className="text-royal text-[9px] underline">verify ↗</span>
                  </a>
                ))}
            </div>
          )}

          {/* Brief item 3c: fairness line */}
          <p className="hidden">
            Every draw is provably fair —{" "}
            <a
              href={`https://basescan.org/address/${JACKPOT_ADDRESS}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cream underline underline-offset-2"
            >
              verify on BaseScan
            </a>
          </p>

          {/* Play controls — hidden for unconnected users (they can't pick numbers) */}
          {isConnected && (<>
          <div className="play-ticket-panel space-y-5">
          <h2 className="text-center text-xl font-heading font-extrabold text-navy">
            Your tickets
          </h2>

          {/* ── Persistent active-subscription banner (brief item 5) ──── */}
          {/* Shows whenever a sub is active, regardless of the Repeat-daily switch. */}
          {subInfo?.isActive && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5">
              <div className="flex items-center justify-between gap-2 p-3">
                <p className="text-emerald-400 font-heading font-bold text-sm flex items-center gap-2 min-w-0">
                  <span>🔁</span>
                  <span className="truncate">
                    Auto-buy active
                    {subInfo.dynamicTicketCount > 0 ? ` · ${subInfo.dynamicTicketCount}/day` : ""}
                    {` · ${subInfo.daysRemaining} ${subInfo.daysRemaining === 1 ? "day" : "days"} left`}
                  </span>
                </p>
                <button
                  onClick={() => setManageOpen((o) => !o)}
                  className="text-xs font-heading font-bold text-emerald-400/80 hover:text-emerald-400 shrink-0"
                >
                  {manageOpen ? "Close" : "Manage"}
                </button>
              </div>
              {manageOpen && (
                <div className="border-t border-emerald-500/20 p-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-mut text-[10px] uppercase tracking-wider">Days Remaining</p>
                      <p className="text-white font-heading font-extrabold">{subInfo.daysRemaining}</p>
                    </div>
                    <div>
                      <p className="text-mut text-[10px] uppercase tracking-wider">Tickets / Day</p>
                      <p className="text-white font-heading font-extrabold">
                        {subInfo.dynamicTicketCount > 0 ? subInfo.dynamicTicketCount : "Custom"}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={handleCancelSubscription}
                    disabled={subPhase === "cancelling"}
                    className="w-full py-2.5 rounded-lg bg-win/20 border border-win/30 text-win font-heading font-bold text-sm hover:bg-win/30 disabled:opacity-50 transition-colors"
                  >
                    {subPhase === "cancelling" ? "Cancelling…" : "Cancel Subscription"}
                  </button>
                </div>
              )}
            </div>
          )}

          {!isRecurring && !purchaseUsesOnchainRandom && (
            <div className="space-y-3">
              <button
                onClick={handleShuffleSelections}
                className="ticket-shuffle-button w-full rounded-2xl py-4 font-heading text-lg font-extrabold"
              >
                <span aria-hidden="true">↻</span> Shuffle my numbers
              </button>
              <p className="text-center text-xs text-mut">
                Tap any ticket to pick your own numbers.
              </p>
              <div className="space-y-2">
                {ticketSelections.slice(0, quantity).map((ticket, index) => (
                  <button
                    key={index}
                    onClick={() => setEditingTicketIndex(index)}
                    className="number-ticket-preview ticket-slip-button relative w-full rounded-xl px-4 py-4"
                    aria-label={`Edit ticket ${index + 1}`}
                  >
                    <span className="ticket-slip-label">Ticket {index + 1}</span>
                    <span className="flex gap-1.5 items-center justify-center flex-wrap">
                      {ticket.normals.map((number) => (
                        <span key={number} className="w-[30px] h-[30px] rounded-full flex items-center justify-center text-xs font-heading font-extrabold brand-ball">
                          {String(number).padStart(2, "0")}
                        </span>
                      ))}
                      <span className="text-white/60 text-xs mx-0.5">+</span>
                      <span className="w-[30px] h-[30px] rounded-full flex items-center justify-center text-xs font-heading font-extrabold brand-ball-gold">
                        {String(ticket.bonusball).padStart(2, "0")}
                      </span>
                    </span>
                    <span className="ticket-slip-edit">Edit</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {(isRecurring || purchaseUsesOnchainRandom) && (
            <div className="quick-pick-feature onchain-random-card">
              <div className="relative z-10 text-center space-y-2">
                <span className="quick-pick-kicker">
                  {isRecurring ? "Fresh numbers every drawing" : "Big play!"}
                </span>
                <p className="quick-pick-copy">
                  {isRecurring
                    ? "Every ticket is generated securely onchain."
                    : `${quantity} tickets will be generated securely onchain.`}
                </p>
                {quickPickPending ? (
                  <p className="text-white/80 text-xs font-heading font-semibold">
                    Numbers assigned — see Results below ↓
                  </p>
                ) : (
                  <div className="flex gap-1.5 items-center justify-center">
                    {(resolvedQuickPick
                      ? resolvedQuickPick.normals
                      : isShuffling
                        ? shuffleDisplay.normals
                        : [0, 0, 0, 0, 0]
                    ).map((number, index) => (
                      <span
                        key={index}
                        className={`w-[30px] h-[30px] rounded-full flex items-center justify-center text-xs font-heading font-extrabold tabular-nums ${
                          number > 0 ? "brand-ball" : "brand-ball-empty"
                        } ${resolvedQuickPick ? "animate-[numberReveal_0.4s_ease-out_both]" : ""}`}
                        style={resolvedQuickPick ? { animationDelay: `${index * 100}ms` } : undefined}
                      >
                        {number > 0 ? String(number).padStart(2, "0") : "?"}
                      </span>
                    ))}
                    <span className="text-white/60 text-xs">+</span>
                    <span className={`w-[30px] h-[30px] rounded-full flex items-center justify-center text-xs font-heading font-extrabold tabular-nums ${
                      (resolvedQuickPick?.bonusball ?? shuffleDisplay.bonusball) > 0
                        ? "brand-ball-gold"
                        : "brand-ball-empty"
                    }`}>
                      {resolvedQuickPick
                        ? String(resolvedQuickPick.bonusball).padStart(2, "0")
                        : isShuffling
                          ? String(shuffleDisplay.bonusball).padStart(2, "0")
                          : "?"}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          <p className="text-center text-[10px] text-mut">
            1 in {jackpotOdds(drawingState.ballMax, drawingState.bonusballMax).toLocaleString()}{" "}
            for the jackpot — someone&apos;s gotta win 🍀
          </p>

          {/* ── Ticket count — morphs for recurring (brief items 1-2) ─ */}
          {/* One-time: 1 / 5 / 10 / Custom → quantity. Recurring: 1 / 2 / 3 / 5 → subTicketsPerDay. */}
          <div className="space-y-2">
            <span className="text-mut text-xs uppercase tracking-widest font-heading font-bold">
              {isRecurring ? "Tickets / day" : "Tickets"}
            </span>
            {isRecurring ? (
              <div className="flex gap-2">
                {[1, 2, 3, 5].map((t) => (
                  <button
                    key={t}
                    onClick={() => setSubTicketsPerDay(t)}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-heading font-extrabold transition-all ${
                      subTicketsPerDay === t
                        ? "bg-royal/20 text-cream border border-royal"
                        : "bg-white/5 text-mut border border-white/10 hover:bg-white/10"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  {(["1", "5", "10", "custom"] as QtyPreset[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        setQtyPreset(p);
                        if (p !== "custom") setQuantity(Number(p));
                      }}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-heading font-extrabold transition-all ${
                        qtyPreset === p
                          ? "bg-royal/20 text-cream border border-royal"
                          : "bg-white/5 text-mut border border-white/10 hover:bg-white/10"
                      }`}
                    >
                      {p === "custom" ? "Custom" : p}
                    </button>
                  ))}
                </div>
                {qtyPreset === "custom" && (
                  <div className="flex items-center justify-center gap-3">
                    <button
                      onClick={() => setQuantity(Math.max(1, quantity - 1))}
                      className="w-8 h-8 rounded-lg bg-white/10 text-white flex items-center justify-center hover:bg-white/20"
                    >
                      −
                    </button>
                    <span className="text-white font-heading font-extrabold w-8 text-center">{quantity}</span>
                    <button
                      onClick={() => {
                        const maxTickets = usdcBalance
                          ? Number(usdcBalance / drawingState.ticketPrice)
                          : 99;
                        setQuantity(Math.min(maxTickets, quantity + 1));
                      }}
                      className="w-8 h-8 rounded-lg bg-white/10 text-white flex items-center justify-center hover:bg-white/20"
                    >
                      +
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Summary card + Repeat-daily switch (brief items 1, 3) ─ */}
          <div className="soft-panel rounded-xl p-4 space-y-3">
            {/* Repeat-daily switch row — disabled when a sub is active or in gift mode */}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-navy font-heading font-bold flex items-center gap-1.5">
                  <span>🔁</span> Repeat daily
                </p>
                {(subInfo?.isActive || giftState.address) && (
                  <p className="text-[10px] text-mut mt-0.5">
                    {subInfo?.isActive
                      ? "You already have an auto-buy running — manage it above."
                      : "Gifts are one-time."}
                  </p>
                )}
              </div>
              <button
                role="switch"
                aria-checked={isRecurring}
                aria-label="Repeat daily"
                disabled={!!subInfo?.isActive || !!giftState.address}
                onClick={() => setRepeatDaily(!isRecurring)}
                className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${
                  isRecurring ? "bg-royal" : "bg-slate-300"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                    isRecurring ? "translate-x-5" : ""
                  }`}
                />
              </button>
            </div>

            {/* Duration row — only when recurring is ON */}
            {isRecurring && (
              <div className="flex items-center justify-between border-t border-white/10 pt-3">
                <span className="text-sm text-mut">Duration</span>
                <div className="flex gap-1.5">
                  {[7, 14, 30].map((d) => (
                    <button
                      key={d}
                      onClick={() => setSubDuration(d)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-heading font-bold transition-colors ${
                        subDuration === d
                          ? "bg-gold/20 text-gold border border-gold/40"
                          : "bg-white/5 text-mut hover:text-white border border-transparent"
                      }`}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Cost breakdown — morphs with the switch */}
            <div className="space-y-1 text-sm border-t border-white/10 pt-3">
              {isRecurring ? (
                <>
                  <div className="flex justify-between text-mut">
                    <span>Daily cost</span>
                    <span>${formatUSDC(drawingState.ticketPrice * BigInt(subTicketsPerDay))} USDC</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-mut">Total ({subDuration} days)</span>
                    <span className="text-navy font-heading font-bold">${formatUSDC(subTotalCost)} USDC</span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between text-mut">
                  <span>Total cost</span>
                  <span className="text-navy font-heading font-bold">${formatUSDC(totalCost)} USDC</span>
                </div>
              )}
              {usdcBalance !== undefined && (
                <div className="flex justify-between text-mut">
                  <span>Your balance</span>
                  <span className={usdcBalance >= (isRecurring ? subTotalCost : totalCost) ? "text-wins-green" : "text-win"}>
                    ${formatUSDC(usdcBalance)} USDC
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ── Status messages (single block for both flows) ─────── */}
          {subPhase === "success" ? (
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-4 text-center space-y-3">
              <p className="text-emerald-400 font-medium">🎰 Auto-buy started!</p>
              <p className="text-xs text-mut">
                {subDuration}-day auto-buy active. Check back to see your tickets each drawing.
              </p>
              <button
                onClick={handleResetSub}
                className="text-sm text-emerald-400/70 hover:text-emerald-400"
              >
                Done
              </button>
            </div>
          ) : buyPhase === "success" ? (
            <div className="relative rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-4 text-center space-y-3 overflow-visible">
              <ConfettiBurst />
              <p className="text-emerald-400 font-medium">🎉 Tickets purchased!</p>
              <button
                onClick={handleShare}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-royal hover:bg-royal/80 text-white text-sm font-heading font-bold transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
                  <polyline points="16,6 12,2 8,6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
                Share on Farcaster
              </button>
              {/* Post-buy upsell (brief item 6) — turn this into a daily auto-buy */}
              {!giftState.address && !subInfo?.isActive && (
                <button
                  onClick={() => { setRepeatDaily(true); handleReset(); }}
                  className="block w-full text-xs text-gold hover:text-gold-light font-heading font-bold"
                >
                  Make this a daily thing →
                </button>
              )}
              <div className="h-px bg-emerald-500/10" />
              <button
                onClick={handleReset}
                className="text-sm text-emerald-400/70 hover:text-emerald-400"
              >
                Buy more tickets
              </button>
            </div>
          ) : subPhase === "error" ? (
            <div className="rounded-xl bg-win/10 border border-win/30 p-4 text-center">
              <p className="text-win font-medium">❌ {subError}</p>
              <button onClick={handleResetSub} className="mt-2 text-sm text-win/80 hover:text-win">
                Try again
              </button>
            </div>
          ) : buyPhase === "error" ? (
            <div className="rounded-xl bg-win/10 border border-win/30 p-4 text-center">
              <p className="text-win font-medium">❌ {errorMessage}</p>
              <button onClick={handleReset} className="mt-2 text-sm text-win/80 hover:text-win">
                Try again
              </button>
            </div>
          ) : null}

          {/* ── Single CTA — morphs between one-time buy and auto-buy ── */}
          {isRecurring ? (
            subPhase !== "success" && subPhase !== "error" && (
              <button
                onClick={handleCreateSubscription}
                disabled={
                  !isSalesOpen ||
                  subPhase === "approving" ||
                  subPhase === "subscribing" ||
                  subAllowance === undefined ||
                  (usdcBalance !== undefined && usdcBalance < subTotalCost)
                }
                className={`w-full py-4 rounded-xl font-heading font-extrabold text-lg tracking-wide uppercase transition-all ${
                  isSalesOpen &&
                  subAllowance !== undefined &&
                  !(usdcBalance !== undefined && usdcBalance < subTotalCost) &&
                  subPhase !== "approving" &&
                  subPhase !== "subscribing"
                    ? "btn-gold"
                    : "bg-white/5 text-mut cursor-not-allowed"
                } ${subPhase === "approving" || subPhase === "subscribing" ? "animate-pulse" : ""}`}
              >
                {subPhase === "approving"
                  ? "Approving USDC…"
                  : subPhase === "subscribing"
                  ? "Creating subscription…"
                  : !isSalesOpen
                  ? "Sales Closed"
                  : subAllowance === undefined
                  ? "Checking approval…"
                  : usdcBalance !== undefined && usdcBalance < subTotalCost
                  ? "Insufficient Balance"
                  : `Start ${subDuration}-Day Auto-Buy · $${formatUSDC(subTotalCost)}`}
              </button>
            )
          ) : (
            <button
              onClick={handleBuy}
              disabled={!canBuy}
              className={`w-full py-4 rounded-xl font-heading font-extrabold text-lg tracking-wide uppercase transition-all ${
                canBuy ? "btn-gold" : "bg-white/5 text-mut cursor-not-allowed"
              } ${buyPhase === "approving" || buyPhase === "buying" ? "animate-pulse" : ""}`}
            >
              {buyPhase === "approving"
                ? "Approving USDC…"
                : buyPhase === "buying"
                ? "Purchasing…"
              : !isSalesOpen
                ? "Sales Closed"
                : allowance === undefined
                ? "Checking approval…"
                : usdcBalance !== undefined && usdcBalance < totalCost
                ? "Insufficient Balance"
                : giftState.address
                ? `Gift ${quantity} Ticket${quantity > 1 ? "s" : ""} to @${giftState.username || "friend"}`
              : `Buy ${quantity} Ticket${quantity > 1 ? "s" : ""}`}
            </button>
          )}


          </div>

          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-2 text-center text-[11px] text-mut">
            {recentRounds.length > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {recentRounds[0].ticket_count.toLocaleString()} tickets last draw
              </span>
            )}
            <span aria-hidden="true">·</span>
            <a
              href={`https://basescan.org/address/${JACKPOT_ADDRESS}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-royal underline underline-offset-2"
            >
              Provably fair on BaseScan ↗
            </a>
          </div>
          </>)}

          {/* ── Wallet button ────────────────────────────────────── */}


          {/* ── Buy button (unconnected — triggers connect) ──────── */}

          {!isConnected && (
            <div className="play-ticket-panel">
              <p className="mb-4 text-center text-sm text-mut">
                Connect your wallet to pick numbers or start a recurring buy.
              </p>
              <ConnectWallet
                className="w-full !bg-transparent hover:!bg-transparent !p-0 !rounded-xl"
                disconnectedLabel={
                  <span className="w-full py-4 rounded-xl font-heading font-extrabold text-lg tracking-wide uppercase btn-gold inline-flex items-center justify-center">
                    Buy a ticket · $1
                  </span>
                }
              />
            </div>
          )}

          {/* Brief item 6: Credit / disclosure footer */}
          <p className="text-center text-[10px] leading-relaxed text-mut px-2">
            Farpot was built — and is kept running — by an{" "}
            <span className="text-cream font-semibold">autonomous agent</span>.{" "}
            The standard 10% Megapot referral fee on every ticket funds it.
            {/* TODO: insert agent's Farcaster @handle here once live */}
          </p>

          {isConnected && (
          <div className="flex justify-center">
            <Connected>
              <div className="flex flex-col items-center gap-1 text-sm text-mut">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  Connected
                </div>
                <p className="text-[10px] uppercase tracking-[0.25em] text-mut/70">
                  Powered by Megapot
                </p>
              </div>
            </Connected>
          </div>
          )}
        </>
      )}

      {/* ── GIFT TAB ─────────────────────────────────────────────── */}

      {activeTab === "gift" && (
        <>
          {/* Gift recipient search */}
          {!giftState.address && (
            <div className="space-y-3">
              <p className="text-mut text-sm text-center">
                Send a lottery ticket to someone on Farcaster.
              </p>

              {/* Search form */}
              <form onSubmit={handleGiftSearchSubmit} className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Enter exact @username"
                  className="flex-1 px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-sm placeholder:text-mut focus:outline-none focus:border-gold/50"
                />
                <button
                  type="submit"
                  disabled={searching || !searchQuery.trim()}
                  className="px-4 py-2 rounded-lg bg-royal hover:bg-royal/80 text-white text-sm font-heading font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {searching ? "..." : "Search"}
                </button>
              </form>

              {searchError && (
                <p className="text-xs text-win">{searchError}</p>
              )}

              {searchResults.length > 0 && (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {searchResults.map((result) => (
                    <button
                      key={result.fid}
                      onClick={() => handleSelectGiftRecipient(result)}
                      className="w-full text-left px-3 py-2 rounded-lg bg-black/20 hover:bg-black/30 border border-white/5 hover:border-gold/40 text-sm transition-all flex items-center justify-between group"
                    >
                      <span className="flex items-center gap-2">
                        <span className="text-white">@{result.username}</span>
                        <span className={`text-[10px] ${result.verified_address ? 'text-emerald-400' : 'text-win'}`}>
                          {result.verified_address ? '✓ wallet' : 'no wallet'}
                        </span>
                      </span>
                      {result.verified_address && (
                        <span className="text-xs font-heading font-bold text-gold group-hover:text-gold-light">
                          Tap to gift →
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Empty state when no search yet */}
              {searchResults.length === 0 && !searchError && (
                <p className="text-xs text-mut text-center italic">
                  Search for a Farcaster user to gift them a ticket.
                </p>
              )}
            </div>
          )}

          {/* Selected recipient banner */}
          {giftState.address && (
            <div className="rounded-xl border border-gold/30 bg-gradient-to-r from-gold/10 to-royal/10 p-4 text-center space-y-2">
              <p className="text-lg">🎁 Gifting to @{giftState.username || "user"}</p>
              <p className="text-xs text-mut font-mono break-all">{giftState.address}</p>
              <button
                onClick={() => {
                  setGiftState({ address: null, username: null });
                  setSearchQuery("");
                  setSearchResults([]);
                  setSearchError("");
                }}
                className="text-xs text-mut hover:text-white underline"
              >
                Change recipient
              </button>
            </div>
          )}

          {/* Quantity presets (brief item 1 — Gift tab) */}
          <div className="space-y-2">
            <span className="text-mut text-xs uppercase tracking-widest font-heading font-bold">Tickets</span>
            <div className="flex gap-2">
              {(["1", "5", "10", "custom"] as QtyPreset[]).map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setQtyPreset(p);
                    if (p !== "custom") setQuantity(Number(p));
                  }}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-heading font-extrabold transition-all ${
                    qtyPreset === p
                      ? "bg-royal/20 text-cream border border-royal"
                      : "bg-white/5 text-mut border border-white/10 hover:bg-white/10"
                  }`}
                >
                  {p === "custom" ? "Custom" : p}
                </button>
              ))}
            </div>
            {qtyPreset === "custom" && (
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  className="w-8 h-8 rounded-lg bg-white/10 text-white flex items-center justify-center hover:bg-white/20"
                >
                  −
                </button>
                <span className="text-white font-heading font-extrabold w-8 text-center">{quantity}</span>
                <button
                  onClick={() => {
                    const maxTickets = usdcBalance
                      ? Number(usdcBalance / drawingState.ticketPrice)
                      : 99;
                    setQuantity(Math.min(maxTickets, quantity + 1));
                  }}
                  className="w-8 h-8 rounded-lg bg-white/10 text-white flex items-center justify-center hover:bg-white/20"
                >
                  +
                </button>
              </div>
            )}
          </div>

          {/* Summary */}
          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-mut">
              <span>Total cost</span>
              <span className="text-white font-heading font-bold">${formatUSDC(totalCost)} USDC</span>
            </div>
            {usdcBalance !== undefined && (
              <div className="flex justify-between text-mut">
                <span>Your balance</span>
                <span
                  className={
                    usdcBalance >= totalCost ? "text-emerald-400" : "text-win"
                  }
                >
                  ${formatUSDC(usdcBalance)} USDC
                </span>
              </div>
            )}
          </div>

          {/* Status messages */}
          {giftState.address && buyPhase === "success" && (
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-4 text-center space-y-3">
              <p className="text-emerald-400 font-medium">
                🎁 Gift sent to @{giftState.username || "friend"}!
              </p>
              <button
                onClick={handleShare}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-royal hover:bg-royal/80 text-white text-sm font-heading font-bold transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
                  <polyline points="16,6 12,2 8,6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
                Share on Farcaster
              </button>
              <div className="h-px bg-emerald-500/10" />
              <button
                onClick={handleReset}
                className="text-sm text-emerald-400/70 hover:text-emerald-400"
              >
                Gift more tickets
              </button>
            </div>
          )}

          {buyPhase === "error" && (
            <div className="rounded-xl bg-win/10 border border-win/30 p-4 text-center">
              <p className="text-win font-medium">❌ {errorMessage}</p>
              <button
                onClick={handleReset}
                className="mt-2 text-sm text-win/80 hover:text-win"
              >
                Try again
              </button>
            </div>
          )}

          {/* Buy & Gift button */}
          <button
            onClick={handleBuy}
            disabled={!canBuy || !giftState.address}
            className={`w-full py-4 rounded-xl font-heading font-extrabold text-lg tracking-wide uppercase transition-all ${
              canBuy && giftState.address
                ? "btn-gold"
                : "bg-white/5 text-mut cursor-not-allowed"
            } ${
              buyPhase === "approving" || buyPhase === "buying"
                ? "animate-pulse"
                : ""
            }`}
          >
            {buyPhase === "approving"
              ? "Approving USDC…"
              : buyPhase === "buying"
              ? "Purchasing…"
              : !giftState.address
              ? "Select a Recipient"
              : !isSalesOpen
              ? "Sales Closed"
              : allowance === undefined
              ? "Checking approval…"
              : usdcBalance !== undefined && usdcBalance < totalCost
              ? "Insufficient Balance"
              : `Gift ${quantity} Ticket${quantity > 1 ? "s" : ""} to @${giftState.username || "friend"}`}
          </button>

          {/* Wallet button */}
          <div className="flex justify-center">
            <Connected>
              <div className="flex flex-col items-center gap-1 text-sm text-mut">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  Connected
                </div>
                <p className="text-[10px] uppercase tracking-[0.25em] text-mut/70">
                  Powered by Megapot
                </p>
              </div>
            </Connected>
          </div>
        </>
      )}

      {/* ── RESULTS TAB ──────────────────────────────────────────── */}

      {activeTab === "results" && (
        <div className="space-y-6">
          {/* User tickets — first thing the user sees */}
          <div>
            <h2 className="text-lg font-semibold text-white mb-3">Your Tickets</h2>

            {claimPhase === "success" && (
              <div className="claim-success-card relative mb-3 overflow-visible rounded-xl p-4 text-center space-y-3">
                <ConfettiBurst />
                <p className="text-emerald-700 font-heading font-extrabold">
                  🎉 ${formatUSDC(lastClaimedAmount)} USDC claimed!
                </p>
                <p className="text-xs text-mut">Your winnings were sent to your wallet.</p>
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={handleShareWinnings}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-royal text-white text-sm font-heading font-bold"
                  >
                    Share your win
                  </button>
                  <button
                    onClick={() => setClaimPhase("idle")}
                    className="text-xs text-mut hover:text-royal"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* Claim-all banner — appears when there are unclaimed winnings.
                Held back while a sweat reveal is running so it can't spoil it. */}
            {claimableWins.length > 0 && !sweatInProgress && (
              <div className="mb-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-emerald-400 font-heading font-extrabold">
                      🎉 You won ${formatUSDC(totalClaimable)} USDC
                    </p>
                    <p className="text-xs text-mut">
                      {claimableWins.length} winning ticket
                      {claimableWins.length > 1 ? "s" : ""} ready to claim
                    </p>
                  </div>
                  <button
                    onClick={() => handleClaim(claimableWins)}
                    disabled={claimPhase === "claiming"}
                    className="px-4 py-2.5 rounded-lg btn-gold font-heading font-extrabold text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {claimPhase === "claiming" ? "Claiming…" : "Claim all"}
                  </button>
                </div>
                {claimPhase === "error" && (
                  <p className="text-xs text-win">{claimError}</p>
                )}
              </div>
            )}

            {loadingResults ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-4 border-gold border-t-transparent" />
                <p className="text-mut ml-3">Loading tickets…</p>
              </div>
            ) : !address ? (
              <div className="text-center py-8 space-y-3">
                <p className="text-mut text-sm">Connect your wallet to see your tickets.</p>
              </div>
            ) : userTickets.length === 0 ? (
              <div className="text-center py-8 space-y-3">
                <p className="text-mut text-sm">No tickets yet.</p>
                <button
                  onClick={() => setActiveTab("play")}
                  className="text-sm text-gold hover:text-gold-light underline"
                >
                  Buy your first ticket →
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {userTickets.map((ticket) => {
                  const winning = winningByRound.get(ticket.round_id);
                  const hasResult = ticket.matched_normals !== null;
                  // Losing settled tickets return winnings_amount {amount:"0"} (NOT
                  // null), so a null check alone marks every ticket as a winner.
                  const won =
                    ticket.winnings_amount != null &&
                    Number(ticket.winnings_amount.amount) > 0;
                  const isClaimed = ticket.claimed || optimisticallyClaimedIds.has(ticket.id);
                  const isMatch = (n: number) =>
                    winning ? winning.normals.includes(n) : false;
                  const bonusHit =
                    ticket.bonusball_match ??
                    (winning ? winning.bonusball === ticket.bonusball : false);
                  // The Sweat: all fresh tickets from the newest settled draw
                  // reveal each ball column together on first view.
                  const isSweating = sweatTicketIds.has(ticket.id);
                  const ballRevealed = (i: number) => !isSweating || sweatStep > i;
                  const sweatDone = !isSweating || sweatStep >= 7;

                  return (
                    <div
                      key={ticket.id}
                      className={`relative rounded-xl border p-4 space-y-2 ${
                        won && sweatDone
                          ? "border-emerald-500/40 bg-emerald-500/5"
                          : "border-white/10 bg-navy-card/40"
                      }`}
                    >
                      {isSweating && sweatDone && won && <ConfettiBurst />}
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-mut">
                          Round #{ticket.round_id} · {formatDateTime(ticket.created_at)}
                        </span>
                        {won && sweatDone && (
                          <span className="text-xs font-medium text-emerald-400 flex items-center gap-2">
                            Won ${formatApiAmount(ticket.winnings_amount)} USDC
                            {isClaimed ? (
                              <span className="text-mut">✓ claimed</span>
                            ) : (
                              <button
                                onClick={() => handleClaim([ticket])}
                                disabled={claimPhase === "claiming"}
                                className="px-2 py-0.5 rounded-md btn-gold font-heading font-bold text-[11px] disabled:opacity-60 disabled:cursor-not-allowed"
                              >
                                {claimingIds.includes(ticket.id) ? "Claiming…" : "Claim"}
                              </button>
                            )}
                          </span>
                        )}
                      </div>

                      {/* Ticket numbers — unrevealed sweat balls keep the
                          "pending" look until their turn comes up */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {ticket.normals.map((n, i) => (
                          <span
                            key={i}
                            className={`w-7 h-7 rounded-full text-xs font-heading font-extrabold flex items-center justify-center ${
                              !ballRevealed(i)
                                ? "bg-royal/25 text-cream"
                                : isMatch(n)
                                ? "bg-emerald-500 text-black"
                                : hasResult
                                ? "brand-ball-empty"
                                : "bg-royal/25 text-cream"
                            } ${isSweating && ballRevealed(i) ? "sweat-flip" : ""}`}
                          >
                            {n}
                          </span>
                        ))}
                        <span className="text-mut/70">+</span>
                        <span
                          className={`w-7 h-7 rounded-full text-xs font-heading font-extrabold flex items-center justify-center ${
                            !ballRevealed(5)
                              ? "bg-gold/25 text-navy"
                              : bonusHit
                              ? "brand-ball-gold"
                              : hasResult
                              ? "brand-ball-empty"
                              : "bg-gold/25 text-navy"
                          } ${isSweating && ballRevealed(5) ? "sweat-flip" : ""}`}
                        >
                          {ticket.bonusball}
                        </span>
                      </div>

                      {hasResult ? (
                        !sweatDone ? (
                          <span className="text-xs text-mut">
                            Checking your numbers…
                          </span>
                        ) : isSweating ? (
                          <span
                            className={`sweat-verdict block text-xs font-semibold ${
                              won ? "text-emerald-500" : "text-mut"
                            }`}
                          >
                            {won
                              ? `🎉 ${ticket.matched_normals}/5${bonusHit ? " + bonus ⭐" : ""} — you won $${formatApiAmount(ticket.winnings_amount)}!`
                              : (ticket.matched_normals ?? 0) >= 2 || bonusHit
                              ? `So close — ${ticket.matched_normals}/5 matched${bonusHit ? " + bonus ⭐" : ""}. Run it back?`
                              : "Not this round — the next draw awaits 🍀"}
                          </span>
                        ) : (
                          <span className="text-xs text-mut">
                            {ticket.matched_normals}/5 matched
                            {bonusHit && " + bonus ⭐"}
                            {!won && " · no win"}
                          </span>
                        )
                      ) : (
                        <span className="text-xs text-mut">Pending draw</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Past drawings */}
          <div>
            <h2 className="text-lg font-semibold text-white mb-3">Past Results</h2>
            {loadingResults ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-4 border-gold border-t-transparent" />
                <p className="text-mut ml-3">Loading results…</p>
              </div>
            ) : pastRounds.length === 0 ? (
              <p className="text-mut text-sm text-center py-8">
                No settled drawings yet.
              </p>
            ) : (
              <div className="space-y-2">
                {pastRounds.map((round) => (
                  <div
                    key={round.id}
                    className="rounded-xl border border-white/10 bg-navy-card/40 p-4 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-white">
                        Round #{round.id}
                      </span>
                      <span className="text-xs text-mut">
                        {formatDate(round.settled_at)}
                      </span>
                    </div>

                    {/* Jackpot + top prize */}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-mut">
                        Pool: ${Number(Number(round.prize_pool.amount) / 10 ** round.prize_pool.decimals).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </span>
                      {round.top_prize_amount && (
                        <span className="text-gold">
                          Top: ${Number(Number(round.top_prize_amount.amount) / 10 ** round.top_prize_amount.decimals).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                      )}
                    </div>

                    {/* Winning numbers */}
                    {round.winning_numbers && (
                      <div className="flex items-center gap-2 flex-wrap">
                        {round.winning_numbers.normals.map((n, i) => (
                          <span
                            key={i}
                            className="w-8 h-8 rounded-full brand-ball text-xs font-heading font-extrabold flex items-center justify-center"
                          >
                            {n}
                          </span>
                        ))}
                        <span className="text-mut/70">+</span>
                        <span className="w-8 h-8 rounded-full brand-ball-gold text-xs font-heading font-extrabold flex items-center justify-center">
                          {round.winning_numbers.bonusball}
                        </span>
                        <span className="text-xs text-mut ml-2">
                          ({round.winners_count} winners)
                        </span>
                      </div>
                    )}

                    <div className="text-xs text-mut/70">
                      {round.ticket_count} tickets · {round.unique_participants} players
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Wallet connect */}
          <div className="flex justify-center pt-4">
            <Connected>
              <div className="flex flex-col items-center gap-1 text-sm text-mut">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  Connected
                </div>
                <p className="text-[10px] uppercase tracking-[0.25em] text-mut/70">
                  Powered by Megapot
                </p>
              </div>
            </Connected>
          </div>
        </div>
      )}

      {editingTicketIndex !== null && ticketSelections[editingTicketIndex] && (
        <div
          className="ticket-picker-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEditingTicketIndex(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ticket-picker-title"
            className="ticket-picker-modal"
          >
            <div className="flex items-center justify-between gap-4">
              <h2 id="ticket-picker-title" className="text-xl font-heading font-extrabold text-navy">
                Pick your numbers
              </h2>
              <button
                onClick={() => setEditingTicketIndex(null)}
                className="ticket-picker-close"
                aria-label="Close number picker"
              >
                ×
              </button>
            </div>

            <div>
              <p className="text-mut text-sm mb-2">
                Pick 5 numbers ({ticketSelections[editingTicketIndex].normals.length}/5)
              </p>
              <div className="grid grid-cols-10 gap-1.5">
                {Array.from({ length: drawingState.ballMax }, (_, index) => index + 1).map((number) => {
                  const selected = ticketSelections[editingTicketIndex].normals.includes(number);
                  return (
                    <button
                      key={number}
                      onClick={() => toggleBall(number)}
                      disabled={ticketSelections[editingTicketIndex].normals.length >= 5 && !selected}
                      className={`aspect-square rounded-full text-xs font-heading font-extrabold transition-all ${
                        selected
                          ? "brand-ball ring-2 ring-coral ball-pop"
                          : "brand-ball-empty hover:bg-white/10"
                      } disabled:opacity-30`}
                    >
                      {number}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <p className="text-mut text-sm mb-2">Pick 1 bonus</p>
              <div className="grid grid-cols-10 gap-1.5">
                {Array.from({ length: drawingState.bonusballMax }, (_, index) => index + 1).map((number) => {
                  const selected = ticketSelections[editingTicketIndex].bonusball === number;
                  return (
                    <button
                      key={number}
                      onClick={() => toggleBonus(number)}
                      className={`aspect-square rounded-full text-xs font-heading font-extrabold transition-all ${
                        selected
                          ? "brand-ball-gold ring-2 ring-gold-light ball-pop"
                          : "brand-ball-empty hover:bg-white/10"
                      }`}
                    >
                      {number}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              onClick={() => setEditingTicketIndex(null)}
              className="btn-gold w-full rounded-xl py-3 font-heading font-extrabold"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Bottom navigation (fixed) */}
      <BottomNav activeTab={activeTab} onTabChange={setActiveTab} hasClaimable={isConnected && totalClaimable > BigInt(0)} />
    </div>
  );
}
