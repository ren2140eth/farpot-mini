"use client";

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  Suspense,
} from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { useAccount, useConfig, useDisconnect, useReadContract, useReadContracts } from "wagmi";
import { estimateGas, readContract, writeContract } from "wagmi/actions";
import { stringToHex, formatUnits, encodeFunctionData } from "viem";
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
  FARPOT_POOL_ADDRESS,
  FARPOT_POOL_ABI,
  POOL_STATE,
  POOL_SOFT_CAP_USDC,
  POOL_SPONSOR_SOFT_CAP_USDC,
  POOL_SPONSOR_BILLING_MIN_USDC,
  POOL_FIRST_DRAWING,
  POOL_HISTORY_LOOKBACK,
} from "@/lib/constants";
import { confirmTransaction } from "@/lib/transaction-receipt";
import { poolJoinLimits, poolSponsorLimits } from "@/lib/pool-cap";
import { bufferGas } from "@/lib/gas-buffer";
import { poolHistoryRange, poolRowState } from "@/lib/pool-history";

// ── Constants ────────────────────────────────────────────────────────

const SOURCE = stringToHex("megapot-mini", { size: 32 });
const REFERRAL_SPLIT = BigInt(1_000_000_000_000_000_000);
const USDC_DECIMALS = 6;
const APP_URL = "https://farpot.vercel.app";
const MAX_TICKETS_PER_PURCHASE = 99;

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
type TabKey = "play" | "pool" | "gift" | "results";
type QtyPreset = "1" | "2" | "5" | "10" | "custom";

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

// ── Theme: light / midnight ─────────────────────────────────────────
// data-theme on <html> is applied PRE-PAINT by the inline script in
// layout.tsx — that script is the source of truth on first render, not this
// module. React reads it through useSyncExternalStore rather than an effect,
// so the server can render "light" and the client can correct to whatever the
// script already applied without a hydration mismatch.
type Theme = "light" | "midnight";
const THEME_KEY = "farpot-theme";
const themeListeners = new Set<() => void>();

function subscribeTheme(onChange: () => void) {
  themeListeners.add(onChange);
  return () => {
    themeListeners.delete(onChange);
  };
}

function readTheme(): Theme {
  return document.documentElement.dataset.theme === "midnight" ? "midnight" : "light";
}

function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "light" as Theme);
  const toggle = useCallback(() => {
    haptics.select();
    const next: Theme = theme === "midnight" ? "light" : "midnight";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable — the choice just won't survive a reload */
    }
    themeListeners.forEach((listener) => listener());
  }, [theme]);
  return [theme, toggle];
}

// ── Subscription types ───────────────────────────────────────────────

type SubPhase = "idle" | "approving" | "subscribing" | "success" | "cancelled" | "error" | "cancelling";

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

// Shape served by our own /api/winners/recent route.
interface TickerWinner {
  round_id: string;
  wallet: string;
  username: string | null;
  pfp: string | null;
  amount: ApiAmount;
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

function shortenAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatShareUSDC(value: bigint): string {
  return Number(formatUSDC(value)).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

// Jackpot odds for the current game: C(ballMax, 5) × bonusballMax. Computed
// from live drawing state so the copy can never drift from the real game.
function jackpotOdds(ballMax: number, bonusballMax: number): number {
  let combos = 1;
  for (let i = 0; i < 5; i++) combos = (combos * (ballMax - i)) / (i + 1);
  return Math.round(combos) * bonusballMax;
}

function choose(n: number, k: number): number {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}

// Odds that one ticket wins ANY paying tier. Tier index = matches × 2 +
// (bonusball ? 1 : 0), so which (matches, bonusball) combos pay comes from the
// live getDrawingTierPayouts read — verified against drawing #118, where every
// tier pays except 0–1 matches without the bonusball (≈ 1 in 4 overall).
// Ceiled so the copy never overstates the player's chance.
function anyPrizeOdds(
  ballMax: number,
  bonusballMax: number,
  tierPayouts: readonly bigint[] | undefined,
): number | null {
  if (!tierPayouts || tierPayouts.length < 12 || ballMax < 6 || bonusballMax < 1) return null;
  const totalCombos = choose(ballMax, 5);
  let pWin = 0;
  for (let matches = 0; matches <= 5; matches++) {
    const pMatches = (choose(5, matches) * choose(ballMax - 5, 5 - matches)) / totalCombos;
    if (tierPayouts[matches * 2] > BigInt(0)) pWin += (pMatches * (bonusballMax - 1)) / bonusballMax;
    if (tierPayouts[matches * 2 + 1] > BigInt(0)) pWin += pMatches / bonusballMax;
  }
  return pWin > 0 ? Math.ceil(1 / pWin) : null;
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

// Wait before each reveal, indexed by the step we are leaving: [0] is the beat
// before the first normal ball, [1]–[4] the remaining normals, [5] the long
// hold before the bonusball (the tensest moment), [6] the pause before the
// verdict copy. ~7s in total — deliberately unhurried; this is the sweat.
const SWEAT_STEP_MS = [1000, 900, 900, 900, 900, 1400, 900];

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

interface PoolContributor {
  address: string;
  /** Decimal string: this wallet's ticket weight, read from contract state. */
  tickets: string;
  username: string | null;
  pfp: string | null;
}

interface SearchUserResult {
  fid: number;
  username: string;
  verified_address: `0x${string}` | null;
}

// ── Odometer jackpot headline ──────────────────────────────────────
// Digits roll into place mechanically instead of swapping as text. The final
// resting value is always the real API value — the roll is presentation only.
const ODO_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

// `prefix` defaults to "$" so the jackpot call site is unchanged; the Pool tab
// passes "" because its hero counts tickets, not dollars.
function Odometer({ value, prefix = "$" }: { value: number; prefix?: string }) {
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
    <span className="odometer" role="text" aria-label={`${prefix}${str}`}>
      {prefix && <span aria-hidden="true">{prefix}</span>}
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
function Logo({ scale = 1, theme = "light" }: { scale?: number; theme?: Theme }) {
  // wordmark-v1 is NOT used here: it has its cream ground baked in (no alpha)
  // and would be a pale slab on midnight. Both variants below are 879×165, so
  // switching themes cannot move the header by a pixel.
  //
  // The midnight variant lifts POT's purple #845fc9 → #a585e8. Measured on the
  // night ground the shipping purple is 3.32:1 against coral's 5.05:1, so POT
  // read muddy next to FAR; lifted it sits at 5.29:1 and the three elements
  // finally carry equal weight.
  return (
    <Image
      src={theme === "midnight" ? "/wordmark-midnight.png" : "/wordmark-transparent.png"}
      alt="Farpot"
      width={879}
      height={165}
      priority
      className="mx-auto h-auto"
      style={{ width: `${196 * scale}px` }}
    />
  );
}

// ── Bottom tab navigation (floating pill) ────────────────────────
// Brief item 4b: green badge dot on Results when claimable winnings exist
function BottomNav({ activeTab, onTabChange, hasClaimable }: { activeTab: TabKey; onTabChange: (tab: TabKey) => void; hasClaimable?: boolean }) {
  // Full-bleed wrapper with its own gutters, NOT left-1/2 + -translate-x-1/2:
  // the pill is content-sized, so a centred transform kept it 390.9px wide on
  // every screen and hung it 35px off BOTH edges at 320px. Centring inside an
  // inset-x-0 flex row lets it shrink instead.
  return (
    <div className="fixed bottom-3 inset-x-0 z-50 flex justify-center px-3" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {/* Surface styling lives in .nav-pill, not utilities, so the theme can
          own it — a bg-white/95 utility here beats any [data-theme] rule. */}
      <nav className="nav-pill flex items-center gap-1 px-2 py-2 rounded-full backdrop-blur-md w-full max-w-[420px]">
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
            key: 'pool' as TabKey,
            icon: (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="9" r="3.25" />
                <circle cx="15.5" cy="9" r="3.25" />
                <circle cx="12.25" cy="15" r="3.25" />
              </svg>
            ),
            label: 'Pool',
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
            className={`flex flex-auto min-w-0 items-center justify-center gap-1 px-1 py-2 rounded-full transition-colors relative ${
              activeTab === key
                ? 'bg-royal/10 text-royal'
                : 'text-mut/70 hover:text-navy hover:bg-slate-100'
            }`}
          >
            <span className="shrink-0">{icon}</span>
            <span className="text-[12px] font-heading font-bold tracking-wide truncate">{label}</span>
            {key === 'results' && hasClaimable && (
              <span className="absolute top-1 right-2 w-1.5 h-1.5 rounded-full bg-wins-green" />
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}

// Which sponsor gets billed on the hero line / group-win share card, given a drawing's
// sponsor list. Pulled out to a pure top-level function (rather than living only inside the
// `billedSponsor` useMemo) so the group-win share path can run the SAME selection against a
// past drawing's sponsor list without a second, driftable copy of the rule.
//
// Weight desc, then address asc. The second key is what makes this deterministic: the sponsor
// list comes out of a Redis Set, so its arrival order is arbitrary and a weight-only sort would
// let cache ordering pick the winner between equal sponsors.
function pickBilledSponsor(
  sponsors: PoolContributor[],
  ticketPrice: bigint,
): PoolContributor | null {
  const eligible = sponsors.filter(
    (s) => BigInt(s.tickets) * ticketPrice >= POOL_SPONSOR_BILLING_MIN_USDC,
  );
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => {
    const byWeight = Number(BigInt(b.tickets) - BigInt(a.tickets));
    if (byWeight !== 0) return byWeight;
    return a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1;
  })[0];
}

// ── Component ────────────────────────────────────────────────

export default function Home() {
  const config = useConfig();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [theme, toggleTheme] = useTheme();

  // ── Wallet sheet (chip in the header opens it) ────────────────
  const [walletSheetOpen, setWalletSheetOpen] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);

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

  // Individual recent winners (top wins per settled round), resolved to
  // Farcaster identities server-side where possible — /api/winners/recent.
  const [recentWinners, setRecentWinners] = useState<TickerWinner[]>([]);
  // The marquee must not be painted until BOTH feeds have settled — see the
  // render gate below for why a late arrival would visibly tear the strip.
  const [winnersSettled, setWinnersSettled] = useState(false);
  useEffect(() => {
    fetch("/api/winners/recent")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { winners?: TickerWinner[] } | null) => {
        if (data?.winners) setRecentWinners(data.winners);
      })
      .catch(() => {})
      // Settled means "we are done waiting", not "we got winners" — a failed
      // lookup still lets the round headlines through.
      .finally(() => setWinnersSettled(true));
  }, []);

  // Ticker interleaves each round's headline with its top winners: Farcaster
  // winners show pfp + gold @handle, bare wallets show a shortened address.
  const recentWinTicker = useMemo(() => {
    const winnersByRound = new Map<string, TickerWinner[]>();
    for (const winner of recentWinners) {
      const list = winnersByRound.get(winner.round_id) ?? [];
      list.push(winner);
      winnersByRound.set(winner.round_id, list);
    }
    const items: { key: string; pfp: string | null; handle: string | null; copy: string }[] = [];
    for (const round of recentRounds.filter((r) => r.winners_count > 0).slice(0, 6)) {
      items.push({
        key: `round-${round.id}`,
        pfp: null,
        handle: null,
        copy:
          round.top_prize_amount && Number(round.top_prize_amount.amount) > 0
            ? `${round.winners_count.toLocaleString()} winners shared $${formatApiAmount(round.top_prize_amount)} in round ${round.id}`
            : `${round.winners_count.toLocaleString()} winners scored in round ${round.id}`,
      });
      // The route sends up to 4 winners per round ordered by size, but only 3
      // fit. Taking the top 3 blindly threw away the Farcaster identities the
      // ticker exists to show: in live round 123 the one resolved winner was
      // 4th by amount, so the strip rendered nothing but bare wallets. Sort
      // identified winners first — the sort is stable, so amount order still
      // decides within each group.
      const roundWinners = [...(winnersByRound.get(round.id) ?? [])].sort(
        (a, b) => Number(Boolean(b.username)) - Number(Boolean(a.username)),
      );
      for (const winner of roundWinners.slice(0, 3)) {
        items.push({
          key: `win-${round.id}-${winner.wallet}`,
          pfp: winner.username ? winner.pfp : null,
          handle: winner.username ? `@${winner.username}` : null,
          // No leading space before "won" — the item is inline-flex, so a
          // space-led text node collapses; .win-ticker-handle carries a
          // margin-right instead.
          copy: winner.username
            ? `won $${formatApiAmount(winner.amount)}`
            : `${winner.wallet.slice(0, 6)}…${winner.wallet.slice(-4)} won $${formatApiAmount(winner.amount)}`,
        });
      }
    }
    return items.slice(0, 14);
  }, [recentRounds, recentWinners]);

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
    const subscription = subInfoRaw.subscription;
    const dailyTicketCount =
      subscription.dynamicTicketCount + BigInt(subInfoRaw.staticTickets.length);
    const dailyCost = subscription.subscribedTicketPrice * dailyTicketCount;
    return {
      isActive: subscription.remainingUSDC > BigInt(0),
      daysRemaining:
        dailyCost > BigInt(0) ? Number(subscription.remainingUSDC / dailyCost) : 0,
      balance: subscription.remainingUSDC,
      dynamicTicketCount: Number(subscription.dynamicTicketCount),
    };
  }, [subInfoRaw]);

  // Subscription total cost = ticketPrice × subTicketsPerDay × subDuration
  const subTotalCost = useMemo(() => {
    if (!drawingState) return BigInt(0);
    return drawingState.ticketPrice * BigInt(subTicketsPerDay) * BigInt(subDuration);
  }, [drawingState, subTicketsPerDay, subDuration]);

  // True whenever the "start a new subscription" config form (tickets/day,
  // duration, cost breakdown, CTA) has nothing useful to offer: either a
  // subscription is already active, or its cancellation confirmation is still
  // on screen (subInfo hasn't refetched to isActive:false yet).
  const subConfigBlocked = isRecurring && (!!subInfo?.isActive || subPhase === "cancelled");

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

  // ── Pool (group buy) ──────────────────────────────────────────────
  // Every number shown on this tab comes from the CONTRACT. The /api/pool
  // route supplies only the list of addresses, so if it fails the tab keeps
  // working and simply hides the faces — it can never show a wrong list.
  const [poolQuantity, setPoolQuantity] = useState(1);
  const [joinPhase, setJoinPhase] = useState<BuyPhase>("idle");
  const [joinError, setJoinError] = useState("");
  const [sponsorQuantity, setSponsorQuantity] = useState(1);
  const [sponsorPhase, setSponsorPhase] = useState<BuyPhase>("idle");
  const [sponsorError, setSponsorError] = useState("");
  const [poolRefresh, setPoolRefresh] = useState(0);
  const [contributors, setContributors] = useState<PoolContributor[]>([]);
  const [contributorsDegraded, setContributorsDegraded] = useState(false);
  // The per-address sponsor list from the same route, used to pick who the hero
  // line names (see billedSponsor below) — distinct from sponsorsOf's aggregate
  // totals, which stay reliable even when this list is empty or degraded.
  const [sponsors, setSponsors] = useState<PoolContributor[]>([]);
  const [yourPoolDrawings, setYourPoolDrawings] = useState<bigint[]>([]);
  const [yourSponsoredDrawings, setYourSponsoredDrawings] = useState<bigint[]>([]);
  const [poolClaimError, setPoolClaimError] = useState("");
  const [claimingDrawing, setClaimingDrawing] = useState<bigint | null>(null);
  // Set after a successful group claim, from `poolOf(drawingId)` — the pool's TOTAL pot and
  // headcount for that drawing, never the wallet's own share (which is all `shareOf` gives).
  // Feeds the "Share the group win" button; null hides it, same as the ticket-claim share path.
  const [lastGroupWin, setLastGroupWin] = useState<{
    drawingId: bigint;
    pot: bigint;
    contributorCount: bigint;
    sponsorHandle: string | null;
  } | null>(null);

  const poolArgs = currentDrawingId !== undefined ? ([currentDrawingId] as const) : undefined;

  const { data: poolData, refetch: refetchPool } = useReadContract({
    address: FARPOT_POOL_ADDRESS,
    abi: FARPOT_POOL_ABI,
    functionName: "poolOf",
    args: poolArgs,
    query: { enabled: currentDrawingId !== undefined, refetchInterval: 60_000 },
  });

  const { data: shareData, refetch: refetchShare } = useReadContract({
    address: FARPOT_POOL_ADDRESS,
    abi: FARPOT_POOL_ABI,
    functionName: "shareOf",
    args: currentDrawingId !== undefined && address ? [currentDrawingId, address] : undefined,
    query: { enabled: currentDrawingId !== undefined && !!address, refetchInterval: 60_000 },
  });

  // Same shape as poolOf — the pool-wide totals of tickets bought FOR the pool by sponsors.
  // Kept alongside poolOf's read so the two can never drift apart on screen; every place that
  // refetches poolOf also refetches this.
  const { data: sponsorsData, refetch: refetchSponsors } = useReadContract({
    address: FARPOT_POOL_ADDRESS,
    abi: FARPOT_POOL_ABI,
    functionName: "sponsorsOf",
    args: poolArgs,
    query: { enabled: currentDrawingId !== undefined, refetchInterval: 60_000 },
  });

  // Read the cap from the contract rather than hardcoding it, so the UI and the
  // constant can never diverge.
  const { data: maxTicketsPerJoin } = useReadContract({
    address: FARPOT_POOL_ADDRESS,
    abi: FARPOT_POOL_ABI,
    functionName: "MAX_TICKETS_PER_JOIN",
  });

  const { data: poolPaused } = useReadContract({
    address: FARPOT_POOL_ADDRESS,
    abi: FARPOT_POOL_ABI,
    functionName: "paused",
    query: { refetchInterval: 60_000 },
  });

  const { data: poolAllowance, refetch: refetchPoolAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "allowance",
    args: address ? [address, FARPOT_POOL_ADDRESS] : undefined,
    query: { enabled: !!address },
  });

  const poolTickets = poolData?.[0] ?? BigInt(0);
  const poolContributorCount = poolData?.[1] ?? BigInt(0);
  const poolState = poolData?.[3] ?? POOL_STATE.None;
  const yourPoolTickets = shareData?.[0] ?? BigInt(0);
  const sponsoredTickets = sponsorsData?.[0] ?? BigInt(0);
  const sponsorCount = sponsorsData?.[1] ?? BigInt(0);

  // Soft cap, converted through the LIVE ticket price — never a hardcoded $1,
  // because the price is a chain value. The arithmetic lives in pool-cap.ts so
  // its boundaries are testable against the same code this renders from.
  const poolTicketPrice = drawingState?.ticketPrice ?? BigInt(0);
  const contractCap = maxTicketsPerJoin ?? BigInt(0);
  const { maxThisJoin: poolMaxThisJoin, atCap: poolAtCap } = poolJoinLimits({
    poolTickets,
    ticketPrice: poolTicketPrice,
    contractCap,
    softCapUsdc: POOL_SOFT_CAP_USDC,
  });
  // Same cap arithmetic, a separate budget: sponsored value has its own soft cap so a
  // sponsorship cannot consume the joiners' headroom. `contractCap` is shared — join and
  // sponsor both route through the pool's one `_buyAndRecord`, so MAX_TICKETS_PER_JOIN is the
  // per-transaction ceiling for both.
  const { maxThisSponsor: sponsorMaxThisSponsor, atCap: sponsorAtCap } = poolSponsorLimits({
    sponsoredTickets,
    ticketPrice: poolTicketPrice,
    contractCap,
    softCapUsdc: POOL_SPONSOR_SOFT_CAP_USDC,
  });
  // Derived, not clamped into state by an effect. The pool fills underneath the
  // user while this tab is open, so the maximum moves; deriving it every render
  // keeps the displayed quantity in range without a setState-in-effect, and
  // without the frame where an out-of-range number is briefly visible.
  const poolQty = poolMaxThisJoin > 0 ? Math.min(poolQuantity, poolMaxThisJoin) : 0;
  const poolCost = poolTicketPrice * BigInt(poolQty);
  const sponsorQty = sponsorMaxThisSponsor > 0 ? Math.min(sponsorQuantity, sponsorMaxThisSponsor) : 0;
  const sponsorCost = poolTicketPrice * BigInt(sponsorQty);

  // ── Pool hero, derived at render (no state, nothing to keep in sync) ──
  // Share is floored to one decimal so it can never round 0.4% up to a whole
  // percent the contributor does not have; the contract's fullMulDiv floor is
  // the authority on what they are actually owed.
  const yourPoolShare =
    poolTickets > BigInt(0) && yourPoolTickets > BigInt(0)
      ? `${(Math.floor((Number(yourPoolTickets) * 1000) / Number(poolTickets)) / 10)
          .toFixed(1)
          .replace(/\.0$/, "")}%`
      : "—";
  const poolStatus = poolPaused
    ? "PAUSED"
    : drawingState?.jackpotLock
      ? "LOCKED"
      : poolAtCap
        ? "FULL"
        : "OPEN";
  const contributorLine = (() => {
    const name = (c: PoolContributor) =>
      c.username ? `@${c.username}` : `${c.address.slice(0, 6)}…${c.address.slice(-4)}`;
    const n = contributors.length;
    if (n === 0) return "";
    if (n === 1) return `${name(contributors[0])} is in`;
    if (n === 2) return `${name(contributors[0])} and ${name(contributors[1])} are in`;
    // One name plus a count, not two names: handles run to twenty characters
    // ("cheddarcole.base.eth"), and two of them wrapped the line onto a second
    // row next to the face pile.
    return `${name(contributors[0])} and ${n - 1} others are in`;
  })();

  // Billing follows SIZE, with a floor and a deterministic tie-break. "Largest wins" alone sets
  // only a relative price — in an otherwise unsponsored drawing a single $1 ticket would buy the
  // headline — and without a tie rule, cache and log ordering silently decides whose name sits on
  // the app. Sponsors below the floor still count in the totals (sponsoredTickets/sponsorCount);
  // they just get no headline.
  const billedSponsor = useMemo(
    () => pickBilledSponsor(sponsors, poolTicketPrice),
    [sponsors, poolTicketPrice],
  );
  // "a sponsor" fallback covers sponsors-exist-but-none-above-floor: sponsoredTickets > 0
  // while billedSponsor is null.
  const sponsorHeroName = billedSponsor
    ? billedSponsor.username
      ? `@${billedSponsor.username}`
      : `${billedSponsor.address.slice(0, 6)}…${billedSponsor.address.slice(-4)}`
    : "a sponsor";
  const poolNeedsApproval = poolAllowance === undefined || poolAllowance < poolCost;
  // Same USDC allowance as join — both spend from the wallet's approval to FARPOT_POOL_ADDRESS,
  // only the quantity (and so the cost) differs. `undefined` means NEEDS approval, never "no
  // approval needed": the allowance-race bug documented in AGENTS.md was caused by the opposite
  // default, and the sponsor button below additionally refuses to enable at all while this is
  // undefined rather than relying on the approve-first fallback alone.
  const sponsorNeedsApproval = poolAllowance === undefined || poolAllowance < sponsorCost;

  // The contributor list is decorative; a failure hides the faces and nothing else.
  useEffect(() => {
    if (activeTab !== "pool" || currentDrawingId === undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/pool/contributors?drawingId=${currentDrawingId}${address ? `&address=${address}` : ""}`,
        );
        const body = await res.json();
        if (cancelled) return;
        setContributors(body.contributors ?? []);
        setContributorsDegraded(Boolean(body.degraded));
        setSponsors(body.sponsors ?? []);
        setYourPoolDrawings(
          ((body.yourDrawings ?? []) as string[]).map((d) => BigInt(d)),
        );
        setYourSponsoredDrawings(
          ((body.yourSponsoredDrawings ?? []) as string[]).map((d) => BigInt(d)),
        );
      } catch {
        if (cancelled) return;
        setContributors([]);
        setContributorsDegraded(true);
        setSponsors([]);
        setYourPoolDrawings([]);
        setYourSponsoredDrawings([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, currentDrawingId, address, poolRefresh]);

  const handleJoin = useCallback(async () => {
    if (!address || poolQty < 1) return;
    setJoinError("");
    haptics.impact();
    try {
      if (poolNeedsApproval) {
        setJoinPhase("approving");
        const approveHash = await writeContract(config, {
          address: USDC_ADDRESS,
          abi: USDC_ABI,
          functionName: "approve",
          args: [FARPOT_POOL_ADDRESS, poolCost],
        });
        const approveReceipt = await confirmTransaction(config, approveHash);
        if (approveReceipt.status === "reverted") throw new Error("Approval transaction reverted");
      }
      setJoinPhase("buying");
      // join() routes through Megapot's buyTickets, the same heavy call the solo path
      // already buffers. Sending the bare estimate is what failed tx 0x5f0d…a7b9: it
      // consumed its whole limit and reverted. See gas-buffer.ts.
      const joinCalldata = encodeFunctionData({
        abi: FARPOT_POOL_ABI,
        functionName: "join",
        args: [poolQty],
      });
      const joinEstimate = await estimateGas(config, {
        account: address,
        to: FARPOT_POOL_ADDRESS,
        data: joinCalldata,
      });
      const hash = await writeContract(config, {
        address: FARPOT_POOL_ADDRESS,
        abi: FARPOT_POOL_ABI,
        functionName: "join",
        args: [poolQty],
        gas: bufferGas(joinEstimate),
      });
      const receipt = await confirmTransaction(config, hash);
      if (receipt.status === "reverted") throw new Error("Join reverted");
      setJoinPhase("success");
      haptics.success();
      refetchPool();
      refetchSponsors();
      refetchShare();
      refetchPoolAllowance();
      refetchUsdcBalance();
      // Re-pull the contributor list so the joiner sees themselves immediately.
      setPoolRefresh((n) => n + 1);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      setJoinPhase("error");
      haptics.error();
      // PoolLocked clears by itself; Paused does not. Distinguishing them is the
      // whole reason the custom errors are in the ABI.
      if (/user rejected|user denied|rejected the request/i.test(raw)) {
        setJoinError("Join cancelled.");
      } else if (/PoolLocked/i.test(raw)) {
        setJoinError("The draw is about to happen — joining reopens for the next drawing.");
      } else if (/Paused/i.test(raw)) {
        setJoinError("Joining is paused right now. Existing pools are unaffected.");
      } else if (/InvalidTicketCount/i.test(raw)) {
        setJoinError(`You can join with up to ${contractCap} tickets at a time.`);
      } else if (/transfer amount exceeds balance|insufficient/i.test(raw)) {
        setJoinError("Not enough USDC for that many tickets.");
      } else {
        setJoinError("Couldn't complete the join — try again, or try fewer tickets.");
      }
    }
  }, [
    address,
    config,
    contractCap,
    poolCost,
    poolNeedsApproval,
    poolQty,
    refetchPool,
    refetchPoolAllowance,
    refetchShare,
    refetchSponsors,
    refetchUsdcBalance,
  ]);

  const handleSponsor = useCallback(async () => {
    if (!address || sponsorQty < 1) return;
    setSponsorError("");
    haptics.impact();
    try {
      if (sponsorNeedsApproval) {
        setSponsorPhase("approving");
        const approveHash = await writeContract(config, {
          address: USDC_ADDRESS,
          abi: USDC_ABI,
          functionName: "approve",
          args: [FARPOT_POOL_ADDRESS, sponsorCost],
        });
        const approveReceipt = await confirmTransaction(config, approveHash);
        if (approveReceipt.status === "reverted") throw new Error("Approval transaction reverted");
      }
      setSponsorPhase("buying");
      // sponsor() routes through the same heavy buy path as join() (both share
      // _buyAndRecord), so it needs the same gas buffer — see gas-buffer.ts.
      const sponsorCalldata = encodeFunctionData({
        abi: FARPOT_POOL_ABI,
        functionName: "sponsor",
        args: [sponsorQty],
      });
      const sponsorEstimate = await estimateGas(config, {
        account: address,
        to: FARPOT_POOL_ADDRESS,
        data: sponsorCalldata,
      });
      const hash = await writeContract(config, {
        address: FARPOT_POOL_ADDRESS,
        abi: FARPOT_POOL_ABI,
        functionName: "sponsor",
        args: [sponsorQty],
        gas: bufferGas(sponsorEstimate),
      });
      const receipt = await confirmTransaction(config, hash);
      if (receipt.status === "reverted") throw new Error("Sponsor reverted");
      setSponsorPhase("success");
      haptics.success();
      refetchPool();
      refetchSponsors();
      refetchShare();
      refetchPoolAllowance();
      refetchUsdcBalance();
      // Re-pull the contributor list — the sponsor's own row (avatar/handle) surfaces there too.
      setPoolRefresh((n) => n + 1);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      setSponsorPhase("error");
      haptics.error();
      // Same distinction as handleJoin: PoolLocked clears by itself, Paused does not.
      if (/user rejected|user denied|rejected the request/i.test(raw)) {
        setSponsorError("Sponsor cancelled.");
      } else if (/PoolLocked/i.test(raw)) {
        setSponsorError("The draw is about to happen, try again shortly.");
      } else if (/Paused/i.test(raw)) {
        setSponsorError("Joining is paused right now. Existing pools are unaffected.");
      } else if (/InvalidTicketCount/i.test(raw)) {
        setSponsorError(`You can sponsor up to ${contractCap} tickets at a time.`);
      } else if (/transfer amount exceeds balance|insufficient/i.test(raw)) {
        setSponsorError("Not enough USDC for that many tickets.");
      } else {
        setSponsorError("Couldn't complete the sponsorship — try again, or try fewer tickets.");
      }
    }
  }, [
    address,
    config,
    contractCap,
    sponsorCost,
    sponsorNeedsApproval,
    sponsorQty,
    refetchPool,
    refetchPoolAllowance,
    refetchShare,
    refetchSponsors,
    refetchUsdcBalance,
  ]);

  // ── Past pools: the claim path ────────────────────────────────────
  //
  // `poolOf`/`shareOf` above are read for the CURRENT drawing only, which can never be
  // Claimable or Settled — those states exist exclusively for drawings that have rolled over.
  // Without this block the Claimable/Settled UI is unreachable and a contributor loses all
  // access to their winnings the moment the drawing ends. (It was, and they did.)
  // The wallet's FULL history from the log index (no expiry — claim() has no deadline on
  // chain, so the UI must not invent one), unioned with a bounded recent window. The window is
  // the fallback: if the log route is unavailable the user still sees and can claim recent
  // pools, rather than losing the claim path entirely whenever the index is down.
  const pastDrawingIds = useMemo(() => {
    if (currentDrawingId === undefined) return [];
    const recent = poolHistoryRange({
      currentDrawingId,
      firstDrawing: POOL_FIRST_DRAWING,
      lookback: POOL_HISTORY_LOOKBACK,
    });
    const seen = new Set(recent.map((d) => d.toString()));
    // Union the joiner and sponsor reverse indexes, deduping across both — a drawing this
    // wallet both joined and sponsored must only appear once in this id list (it renders as a
    // single joiner row below; see mySponsoredPools).
    const older: bigint[] = [];
    for (const d of [...yourPoolDrawings, ...yourSponsoredDrawings]) {
      const key = d.toString();
      if (d < currentDrawingId && !seen.has(key)) {
        seen.add(key);
        older.push(d);
      }
    }
    // Newest first across both sources.
    return [...recent, ...older].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  }, [currentDrawingId, yourPoolDrawings, yourSponsoredDrawings]);

  // Three entries per drawing, one multicall. `shareOf` carries the user's joiner weight, what
  // they are owed and whether they already claimed; `poolStateOf` gates whether either figure
  // may be shown at all; `sponsorShareOf` carries the same triple for the zero-joiner sponsor
  // fallback (Task 11B). Every index below MUST stay `i * 3` / `i * 3 + 1` / `i * 3 + 2` — an
  // off-by-one here silently pairs one drawing's read with another's.
  const { data: pastPoolReads, refetch: refetchPastPools } = useReadContracts({
    contracts: pastDrawingIds.flatMap((d) => [
      {
        address: FARPOT_POOL_ADDRESS,
        abi: FARPOT_POOL_ABI,
        functionName: "shareOf" as const,
        args: [d, address as `0x${string}`] as const,
      },
      {
        address: FARPOT_POOL_ADDRESS,
        abi: FARPOT_POOL_ABI,
        functionName: "poolStateOf" as const,
        args: [d] as const,
      },
      {
        address: FARPOT_POOL_ADDRESS,
        abi: FARPOT_POOL_ABI,
        functionName: "sponsorShareOf" as const,
        args: [d, address as `0x${string}`] as const,
      },
    ]),
    query: {
      enabled: activeTab === "pool" && !!address && pastDrawingIds.length > 0,
      refetchInterval: 60_000,
    },
  });

  const myPastPools = useMemo(() => {
    if (!pastPoolReads) return [];
    const out: {
      drawingId: bigint;
      tickets: bigint;
      owed: bigint;
      hasClaimed: boolean;
      state: number;
    }[] = [];
    pastDrawingIds.forEach((drawingId, i) => {
      const share = pastPoolReads[i * 3];
      const state = pastPoolReads[i * 3 + 1];
      // A failed read is skipped rather than rendered as a zero — showing "you won $0" because
      // an RPC call failed is worse than showing nothing.
      if (share?.status !== "success" || state?.status !== "success") return;
      const [tickets, owed, hasClaimed] = share.result as readonly [bigint, bigint, boolean];
      if (tickets === BigInt(0)) return; // never joined this drawing
      out.push({ drawingId, tickets, owed, hasClaimed, state: Number(state.result) });
    });
    return out;
  }, [pastPoolReads, pastDrawingIds]);

  // Sponsor rows: a drawing this wallet sponsored. A row qualifies ONLY when this wallet's
  // OWN `shareOf.tickets` is zero — a drawing the wallet both joined and sponsored already
  // renders above as a joiner row, and `totalTickets != 0` there by construction means
  // `sponsorShareOf.owed` is zero anyway (see Task 11B brief: showing both would imply two
  // payouts for one drawing).
  const mySponsoredPools = useMemo(() => {
    if (!pastPoolReads) return [];
    const out: {
      drawingId: bigint;
      tickets: bigint;
      owed: bigint;
      hasClaimed: boolean;
      state: number;
    }[] = [];
    pastDrawingIds.forEach((drawingId, i) => {
      const share = pastPoolReads[i * 3];
      const state = pastPoolReads[i * 3 + 1];
      const sponsorShare = pastPoolReads[i * 3 + 2];
      if (
        share?.status !== "success" ||
        state?.status !== "success" ||
        sponsorShare?.status !== "success"
      )
        return;
      const [joinerTickets] = share.result as readonly [bigint, bigint, boolean];
      if (joinerTickets !== BigInt(0)) return; // renders as a joiner row instead
      const [tickets, owed, hasClaimed] = sponsorShare.result as readonly [
        bigint,
        bigint,
        boolean,
      ];
      if (tickets === BigInt(0)) return; // never sponsored this drawing
      out.push({ drawingId, tickets, owed, hasClaimed, state: Number(state.result) });
    });
    return out;
  }, [pastPoolReads, pastDrawingIds]);

  const handleClaimPool = useCallback(
    async (drawingId: bigint) => {
      if (!address) return;
      setPoolClaimError("");
      setClaimingDrawing(drawingId);
      haptics.impact();
      try {
        // Lighter than join (no Megapot buy), but it is still the path that moves a
        // contributor's winnings, and padding is close to free — gas is billed on use.
        const claimCalldata = encodeFunctionData({
          abi: FARPOT_POOL_ABI,
          functionName: "claim",
          args: [[drawingId]],
        });
        const claimEstimate = await estimateGas(config, {
          account: address,
          to: FARPOT_POOL_ADDRESS,
          data: claimCalldata,
        });
        const hash = await writeContract(config, {
          address: FARPOT_POOL_ADDRESS,
          abi: FARPOT_POOL_ABI,
          functionName: "claim",
          args: [[drawingId]],
          gas: bufferGas(claimEstimate),
        });
        const receipt = await confirmTransaction(config, hash);
        if (receipt.status === "reverted") throw new Error("Claim reverted");
        haptics.success();
        refetchPastPools();
        refetchUsdcBalance();

        // Group-win share data: the drawing's TOTAL pot and headcount (poolOf), never the
        // wallet's own share — shareOf/sponsorShareOf only carry that. Best-effort: a failure
        // here must never surface as a claim error, since the claim itself already went
        // through above. Sponsor credit is a second best-effort layer inside the first, so a
        // sponsor-lookup failure still leaves the pot/headcount share intact.
        try {
          const poolOfResult = await readContract(config, {
            address: FARPOT_POOL_ADDRESS,
            abi: FARPOT_POOL_ABI,
            functionName: "poolOf",
            args: [drawingId],
          });
          const [, contributorCount, potAmount] = poolOfResult;
          let sponsorHandle: string | null = null;
          try {
            const res = await fetch(`/api/pool/contributors?drawingId=${drawingId}`);
            const body = await res.json();
            const billed = pickBilledSponsor(
              (body.sponsors ?? []) as PoolContributor[],
              poolTicketPrice,
            );
            sponsorHandle = billed?.username ?? null;
          } catch {
            /* sponsor credit is decorative; the pot/headcount below still stand alone */
          }
          setLastGroupWin({ drawingId, pot: potAmount, contributorCount, sponsorHandle });
        } catch {
          /* group-win share data is decorative; the claim already succeeded above */
        }
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : String(err);
        haptics.error();
        setPoolClaimError(
          /user rejected|user denied|rejected the request/i.test(raw)
            ? "Claim cancelled."
            : /NotSettled/i.test(raw)
              ? "This pool is still settling — try again shortly."
              : "Couldn't confirm the claim. If your USDC balance went up it went through.",
        );
      } finally {
        setClaimingDrawing(null);
      }
    },
    [address, config, poolTicketPrice, refetchPastPools, refetchUsdcBalance],
  );

  const handleSharePool = useCallback(() => {
    const count = Number(poolTickets);
    composeCast({
      text:
        `I'm in the Farpot group pool for this draw — ${count} ticket${count === 1 ? "" : "s"} in so far.` +
        ` More tickets, more chances to hit something together 🎰`,
      embeds: [APP_URL],
    });
  }, [composeCast, poolTickets]);

  const handleShareGroupWin = useCallback(() => {
    if (!lastGroupWin || lastGroupWin.pot <= BigInt(0)) return;
    const shareAmount = formatShareUSDC(lastGroupWin.pot);
    const players = Number(lastGroupWin.contributorCount);
    const params = new URLSearchParams({
      mode: "group",
      pot: shareAmount,
      players: String(players),
      // Busts the wrpcd.net CDN cache (immutable, 1y) so a common pot/player combo doesn't
      // keep serving a stale render across design changes. Bump when the card design changes.
      v: "3",
    });
    if (lastGroupWin.sponsorHandle) params.set("sponsor", lastGroupWin.sponsorHandle);
    const cardUrl = `${APP_URL}/api/share/win-card?${params.toString()}`;
    const sponsorSuffix = lastGroupWin.sponsorHandle
      ? ` — sponsored by @${lastGroupWin.sponsorHandle}`
      : "";
    composeCast({
      text: `Our Farpot group just won $${shareAmount} across ${players} player${players === 1 ? "" : "s"} 🎉${sponsorSuffix}`,
      embeds: [cardUrl, APP_URL],
    });
  }, [composeCast, lastGroupWin]);

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
        const approveReceipt = await confirmTransaction(config, approveHash);
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
      const bufferedGas = bufferGas(estimatedGas);

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
      const buyReceipt = await confirmTransaction(config, buyHash);
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

      // Re-read immediately before any approval. The cached hook result can be
      // stale after an execution in another session, but the contract permits
      // only one subscription with remaining funds per recipient.
      const latestSubInfo = await readContract(config, {
        address: AUTO_SUBSCRIPTION_ADDRESS,
        abi: AUTO_SUBSCRIPTION_ABI,
        functionName: "getSubscriptionInfo",
        args: [address],
      });
      if (latestSubInfo.subscription.remainingUSDC > BigInt(0)) {
        setIsRecurring(false);
        setSubPhase("error");
        setSubError("You already have an active auto-buy. Manage it above before starting another.");
        refetchSubInfo();
        return;
      }

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
        const approveReceipt = await confirmTransaction(config, approveHash);
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
      const subReceipt = await confirmTransaction(config, subHash);
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
      const alreadyActive = /ActiveSubscriptionExists/i.test(raw);
      setSubPhase("error");
      setSubError(
        rejected
          ? "Transaction cancelled."
          : alreadyActive
            ? "You already have an active auto-buy. Manage it above before starting another."
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
      const cancelReceipt = await confirmTransaction(config, cancelHash);
      if (cancelReceipt.status === "reverted") {
        throw new Error("Cancel reverted");
      }

      setSubPhase("cancelled");
      setManageOpen(false);
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
      SWEAT_STEP_MS[sweatStep] ?? 900,
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
        const receipt = await confirmTransaction(config, hash);
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
    const claimedRounds = new Set(lastClaimedTickets.map((ticket) => ticket.round_id));
    const totalTickets = userTickets.filter((ticket) => claimedRounds.has(ticket.round_id)).length;
    const shareAmount = formatShareUSDC(lastClaimedAmount);
    const params = new URLSearchParams({
      amount: shareAmount,
      won: String(lastClaimedTickets.length),
      tickets: String(Math.max(lastClaimedTickets.length, totalTickets)),
      // Busts the wrpcd.net CDN cache (immutable, 1y) so old casts' cached
      // renders don't shadow the redesigned card. Bump when the design changes.
      v: "2",
    });
    const cardUrl = `${APP_URL}/api/share/win-card?${params.toString()}`;
    composeCast({
      text: `I just won $${shareAmount} on Farpot 🎉`,
      embeds: [cardUrl, APP_URL],
    });
  }, [composeCast, lastClaimedAmount, lastClaimedTickets, userTickets]);

  // Shared onchain-random ball row: rendered inside the recurring daily
  // ticket and the >10-ticket "big play" card. Shows ? placeholders until
  // the real numbers resolve post-buy.
  const quickPickBallsRow = quickPickPending ? (
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
  );

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
      {/* The strip scrolls by translateX(-50%), a percentage of the track's OWN
          width, so its content must be final before it starts moving. The two
          feeds land seconds apart; when the winners arrived mid-animation the
          track nearly doubled and the same progress re-resolved to double the
          offset — the strip teleported ~500px, landing mid-word (measured:
          -540px → -1026px in one frame), and sped up 1.8x against the fixed
          duration. Hence: wait for both feeds, then key the track on its
          contents so a later change restarts the scroll cleanly from 0 instead
          of snapping it into the middle of an address. */}
      {recentWinTicker.length > 0 && winnersSettled && (
        <div className="win-ticker" aria-label="Recent Farpot wins">
          <div
            className="win-ticker-track"
            key={recentWinTicker.map((win) => win.key).join("|")}
            // Duration tracks item count so the marquee reads at one constant
            // speed; a fixed duration made a fuller strip scroll faster.
            style={{ animationDuration: `${(recentWinTicker.length * 2.4).toFixed(1)}s` }}
          >
            {[0, 1].map((copyIndex) => (
              <div className="win-ticker-set" key={copyIndex} aria-hidden={copyIndex === 1}>
                {recentWinTicker.map((win) => (
                  <span className="win-ticker-item" key={`${copyIndex}-${win.key}`}>
                    {win.pfp && (
                      // eslint-disable-next-line @next/next/no-img-element -- tiny external pfps; remotePatterns config isn't worth it
                      <img
                        className="win-ticker-pfp"
                        src={win.pfp}
                        alt=""
                        // visibility, not display: hiding the box would resize
                        // the track mid-scroll and retrigger the same teleport
                        // the render gate above exists to prevent.
                        onError={(e) => {
                          e.currentTarget.style.visibility = "hidden";
                        }}
                      />
                    )}
                    {win.handle && <b className="win-ticker-handle">{win.handle}</b>}
                    {win.copy}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Header — controls sit in their own row under the ticker, the wordmark
          below them. Both are in normal flow (not absolute) so the chips can
          never crowd the logo and the spacing is the same on every tab. */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            className="header-chip"
            aria-label={theme === "midnight" ? "Switch to light mode" : "Switch to midnight mode"}
          >
            {theme === "midnight" ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4.2" />
                <path d="M12 2.6v2.2M12 19.2v2.2M4.3 4.3l1.6 1.6M18.1 18.1l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.3 19.7l1.6-1.6M18.1 5.9l1.6-1.6" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
              </svg>
            )}
          </button>
          {/* Always present, connected or not — the wallet is a fixed landmark
              rather than something that appears once you're already in. */}
          <button
            type="button"
            onClick={() => {
              haptics.select();
              setWalletSheetOpen(true);
            }}
            className="header-chip"
            aria-label={
              isConnected && address
                ? `Wallet ${shortenAddress(address)} — connected`
                : "Wallet — not connected"
            }
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v2" />
              <path d="M3 7.5v9A2.5 2.5 0 0 0 5.5 19H19a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H5.5A2.5 2.5 0 0 1 3 7.5Z" />
              <circle cx="16" cy="13.5" r="1.15" fill="currentColor" stroke="none" />
            </svg>
            <span className={`wallet-chip-dot ${isConnected ? "" : "wallet-chip-dot-off"}`} />
          </button>
        </div>
        <div className="text-center pb-1">
          <Logo scale={1.35} theme={theme} />
        </div>
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
          {/* Golden hour's trick was flipping the card to night — that is the
              theme's job now, so in light mode the final hour keeps only the
              countdown cue and the card stays light. */}
          <div
            className={`jackpot-card rounded-3xl p-6 space-y-5 ${
              isGoldenHour ? (theme === "midnight" ? "jackpot-golden" : "jackpot-final-hour") : ""
            }`}
          >
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

          {!isRecurring && !purchaseUsesOnchainRandom && (
            <div className="space-y-3">
              <button
                onClick={handleShuffleSelections}
                className="ticket-shuffle-button w-full rounded-2xl py-4 font-heading text-lg font-extrabold"
              >
                <span aria-hidden="true">↻</span> Shuffle
              </button>
              <div className="space-y-2">
                {ticketSelections.slice(0, quantity).map((ticket, index) => (
                  <button
                    key={index}
                    onClick={() => setEditingTicketIndex(index)}
                    className="number-ticket-preview ticket-slip-button relative w-full rounded-xl"
                    aria-label={`Edit ticket ${index + 1}`}
                  >
                    <span className="ticket-slip-main">
                      <span className="ticket-slip-label">Ticket {String(index + 1).padStart(2, "0")}</span>
                      <span className="ticket-slip-numbers flex gap-1.5 items-center justify-center flex-wrap">
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
                    </span>
                    <span className="ticket-slip-stub"><span aria-hidden="true">✎</span> Edit</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {isRecurring && (
            <div className="number-ticket-preview ticket-slip-card relative w-full rounded-xl">
              <span className="ticket-slip-main">
                <span className="ticket-slip-label">Daily ticket</span>
                {quickPickBallsRow}
                <span className="ticket-slip-note">
                  Every ticket is generated securely onchain.
                </span>
              </span>
              <span className="ticket-slip-stub"><span aria-hidden="true">🔁</span> Daily</span>
            </div>
          )}

          {!isRecurring && purchaseUsesOnchainRandom && (
            <div className="quick-pick-feature onchain-random-card">
              <div className="relative z-10 text-center space-y-2">
                <p className="quick-pick-copy">
                  {quantity} tickets will be generated securely onchain.
                </p>
                {quickPickBallsRow}
              </div>
            </div>
          )}

          {/* One template literal: the JSX transform swallows line-leading
              spaces after {expr}, so never split this copy across lines. */}
          <p className="text-center text-[10px] text-mut">
            {(() => {
              const prizeOdds = anyPrizeOdds(
                drawingState.ballMax,
                drawingState.bonusballMax,
                tierPayouts,
              );
              const jackpot = `1 in ${jackpotOdds(drawingState.ballMax, drawingState.bonusballMax).toLocaleString()} for the jackpot`;
              return prizeOdds
                ? `1 in ${prizeOdds} tickets wins a prize · ${jackpot} — someone's gotta win 🍀`
                : `${jackpot} — someone's gotta win 🍀`;
            })()}
          </p>

          {/* ── Ticket count — morphs for recurring (brief items 1-2) ─ */}
          {/* One-time: 1 / 5 / 10 / Custom → quantity. Recurring: 1 / 2 / 3 / 5 → subTicketsPerDay.
              Hidden entirely while an auto-buy is already active — there's no
              "update subscription" action, so this would just be a config
              form for a new subscription the app already refuses to start. */}
          {!subConfigBlocked && (
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
                  {(["1", "2", "5", "10", "custom"] as QtyPreset[]).map((p) => (
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
                      onClick={() =>
                        setQuantity(Math.min(MAX_TICKETS_PER_PURCHASE, quantity + 1))
                      }
                      className="w-8 h-8 rounded-lg bg-white/10 text-white flex items-center justify-center hover:bg-white/20"
                    >
                      +
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          )}

          {/* ── Summary card + Repeat-daily switch (brief items 1, 3) ─ */}
          <div className="soft-panel rounded-xl p-4 space-y-3">
            {/* Active subscriptions reveal their management here; otherwise this is the setup switch. */}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-navy font-heading font-bold flex items-center gap-1.5">
                  <span>🔁</span> Repeat daily
                </p>
                {(subInfo?.isActive || giftState.address) && (
                  <p className="text-[10px] text-mut mt-0.5 flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
                    <span>
                      {subInfo?.isActive
                        ? `Auto-buy active · ${subInfo.daysRemaining} ${subInfo.daysRemaining === 1 ? "day" : "days"} left`
                        : "Gifts are one-time."}
                    </span>
                    {subInfo?.isActive && (
                      <button
                        onClick={() => setManageOpen((open) => !open)}
                        aria-expanded={manageOpen}
                        className="repeat-manage-link"
                      >
                        {manageOpen ? "Close" : "Manage"} <span aria-hidden="true">›</span>
                      </button>
                    )}
                  </p>
                )}
              </div>
              {/* Switch stays visible even with an active subscription — it only
                  toggles which picker view renders, so turning it off is how you
                  get back to the one-time ticket UI without cancelling the sub. */}
              <button
                role="switch"
                aria-checked={isRecurring}
                aria-label="Repeat daily"
                disabled={!!giftState.address}
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

            {subInfo?.isActive && manageOpen && (
              <div className="repeat-manage-panel">
                <div>
                  <span>Tickets / day</span>
                  <strong>{subInfo.dynamicTicketCount > 0 ? subInfo.dynamicTicketCount : "Custom"}</strong>
                </div>
                <div>
                  <span>Days left</span>
                  <strong>{subInfo.daysRemaining}</strong>
                </div>
                <button
                  onClick={handleCancelSubscription}
                  disabled={subPhase === "cancelling"}
                >
                  {subPhase === "cancelling" ? "Cancelling…" : "Cancel auto-buy"}
                </button>
              </div>
            )}

            {/* Duration row — only when configuring a new subscription */}
            {isRecurring && !subConfigBlocked && (
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

            {/* Cost breakdown — morphs with the switch. Hidden entirely while
                already subscribed: it's priced for a new subscription that
                can't be started (Manage above covers the active one). */}
            {!subConfigBlocked && (
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
            )}
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
          ) : subPhase === "cancelled" ? (
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-4 text-center space-y-3">
              <p className="text-emerald-400 font-medium">Auto-buy cancelled</p>
              <p className="text-xs text-mut">
                Your remaining balance has been refunded. No more daily tickets will be bought.
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

          {/* ── Single CTA — morphs between one-time buy and auto-buy.
              Hidden while subConfigBlocked — there's no "start" action to
              offer; Manage above is the CTA. ── */}
          {isRecurring ? (
            !subConfigBlocked && subPhase !== "success" && subPhase !== "error" && (
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
              {(["1", "2", "5", "10", "custom"] as QtyPreset[]).map((p) => (
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
                  onClick={() =>
                    setQuantity(Math.min(MAX_TICKETS_PER_PURCHASE, quantity + 1))
                  }
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

        </>
      )}

      {/* ── POOL TAB ─────────────────────────────────────────────── */}

      {/* Copy rule (non-negotiable): pooling is variance reduction and social
          play. It does NOT improve expected value — 50 people pooling have the
          same EV as 50 buying alone, just smaller and more frequent wins. Never
          imply better odds anywhere on this tab. */}
      {activeTab === "pool" && (
        <div className="space-y-6">
          {/* Hero, in the Play tab's jackpot-card grammar so the two tabs read as
              one app: eyebrow, ONE big gold number, a live pill, a stat row. The
              old flat royal slab opened with a three-line paragraph, which put the
              least interesting thing first. */}
          <div className="jackpot-card rounded-3xl p-6 space-y-5">
            <div className="text-center">
              <p className="text-royal text-xs font-heading font-bold uppercase tracking-[0.22em]">
                This draw&rsquo;s pool
              </p>

              {/* An empty pool is the COMMON case at soft-launch size, and a giant
                  gold 0 reads worse than no hero at all — so empty gets its own
                  line and the pill/faces below simply do not render. */}
              {poolTickets > BigInt(0) ? (
                <>
                  <p className="jackpot-headline display gold-text pulse-gold text-6xl mt-2 tabular-nums">
                    <Odometer value={Number(poolTickets)} prefix="" />
                  </p>
                  <p className="text-mut text-[11px] font-heading font-bold uppercase tracking-[0.18em] mt-1">
                    {poolTickets === BigInt(1) ? "ticket in the pot" : "tickets in the pot"}
                  </p>
                </>
              ) : (
                <p className="display gold-text text-4xl mt-3">Be first in</p>
              )}

              {poolContributorCount > BigInt(0) && (
                <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-royal/25 bg-royal/10 px-3 py-1.5 text-xs font-semibold text-mut">
                  <span className="h-1.5 w-1.5 rounded-full bg-wins-green" />
                  <span className="font-bold text-cream tabular-nums">
                    {poolContributorCount.toString()}
                  </span>{" "}
                  {poolContributorCount === BigInt(1) ? "player in" : "players in"}
                </p>
              )}
            </div>

            {/* Faces of everyone in. Hidden entirely when the log route is
                degraded — the numbers above still come from the contract, so the
                tab stays useful and never shows a partial or wrong list.
                Stacked, not side by side: a 20-character ENS handle
                ("@cheddarcole.base.eth and 6 others are in") wrapped onto a
                second line next to the pile and looked broken. Centred under the
                faces it has the full card width and reads as deliberate even
                when it does wrap.
                Gated on poolTickets too, so the "Be first in" hero can never sit
                above a pile of faces: poolOf reads at latest while the log route
                lags two confirmations, so the two feeds disagree transiently. */}
            {poolTickets > BigInt(0) && !contributorsDegraded && contributors.length > 0 && (
              <div className="flex flex-col items-center gap-2">
                <div className="flex -space-x-2">
                  {contributors.slice(0, 5).map((c) => (
                    c.pfp ? (
                      <Image
                        key={c.address}
                        src={c.pfp}
                        alt=""
                        width={28}
                        height={28}
                        className="pool-face rounded-full"
                        unoptimized
                        /* visibility, never display: collapsing the box would
                           reflow the row on every failed avatar. */
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                        }}
                      />
                    ) : (
                      <span key={c.address} className="pool-face w-7 h-7 rounded-full" />
                    )
                  ))}
                </div>
                <p className="pool-dimmer text-xs text-center">{contributorLine}</p>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-mut text-[10px] uppercase tracking-wider">Yours</p>
                <p className="text-cream font-heading font-extrabold text-lg tabular-nums">
                  {yourPoolTickets.toString()}
                </p>
              </div>
              <div>
                {/* "Share", not "Your share": the longer label wrapped to two
                    lines at 320 and pushed this column's value out of line with
                    the other two. */}
                <p className="text-mut text-[10px] uppercase tracking-wider">Share</p>
                <p className="text-cream font-heading font-extrabold text-lg tabular-nums">
                  {yourPoolShare}
                </p>
              </div>
              <div>
                <p className="text-mut text-[10px] uppercase tracking-wider">Status</p>
                <p
                  className={`font-heading font-extrabold text-lg ${
                    poolStatus === "OPEN" ? "text-wins-green" : "text-win"
                  }`}
                >
                  {poolStatus}
                </p>
              </div>
            </div>

            {/* Copy rule: variance reduction and social play, never better odds. */}
            <p className="text-mut text-xs text-center">
              Everyone&rsquo;s tickets ride together — the pot splits by how many you put in.
            </p>

            {/* Sponsored hero line — shown whenever this draw has ANY sponsored tickets,
                independent of whether one cleared the billing floor (see billedSponsor
                above). This is the one place on the tab where the "no better odds" copy
                rule does NOT apply: a sponsored draw is genuinely +EV for joiners, because
                sponsored tickets ride in the pot but pay out only to joiners. Both lines
                share the same gate so they always appear together. */}
            {sponsoredTickets > BigInt(0) && (
              <div className="mt-3 space-y-1 text-center">
                <p className="pool-dimmer text-[11px]">
                  {`${sponsoredTickets.toString()} sponsored ticket${sponsoredTickets === BigInt(1) ? "" : "s"} from ${sponsorHeroName} — free odds for everyone in`}
                </p>
                <p className="text-wins-green text-[11px] font-semibold">
                  {`Sponsored tickets pay out to joiners, so joining a sponsored pool is better than buying alone.`}
                </p>
              </div>
            )}
          </div>

          {/* Join — the same surface as the Play tab's ticket panel, so the
              action reads as a real card and not an untreated box. */}
          <div className="play-ticket-panel">
            {poolPaused ? (
              <p className="pool-dim text-sm">
                Joining is paused right now. Pools that already bought their tickets are
                unaffected — claiming always stays open.
              </p>
            ) : drawingState?.jackpotLock ? (
              <p className="pool-dim text-sm">
                The draw is about to happen, so joining is closed for a few minutes. It reopens
                for the next drawing.
              </p>
            ) : poolAtCap ? (
              <p className="pool-dim text-sm">
                This draw&rsquo;s pool is full for now — we&rsquo;re keeping pools to a soft cap
                of ${(Number(POOL_SOFT_CAP_USDC) / 1e6).toFixed(0)} per draw while the contract
                is still being audited. It reopens with the next drawing.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-white font-heading font-bold text-sm">Tickets to add</span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => {
                        haptics.select();
                        setPoolQuantity(Math.max(1, poolQty - 1));
                      }}
                      className="w-8 h-8 rounded-lg bg-white/10 text-white flex items-center justify-center hover:bg-white/20"
                    >
                      −
                    </button>
                    <span className="text-white font-heading font-extrabold w-8 text-center">
                      {poolQty}
                    </span>
                    <button
                      onClick={() => {
                        haptics.select();
                        setPoolQuantity(Math.min(poolMaxThisJoin, poolQty + 1));
                      }}
                      className="w-8 h-8 rounded-lg bg-white/10 text-white flex items-center justify-center hover:bg-white/20"
                    >
                      +
                    </button>
                  </div>
                </div>
                <p className="pool-dimmer text-[11px] mt-2">
                  Up to {poolMaxThisJoin} per join — join as often as you like.
                </p>

                {isConnected ? (
                  <button
                    onClick={handleJoin}
                    disabled={joinPhase === "approving" || joinPhase === "buying" || poolCost === BigInt(0)}
                    className={`w-full mt-4 py-4 rounded-xl font-heading font-extrabold text-lg tracking-wide uppercase transition-all ${
                      joinPhase === "approving" || joinPhase === "buying" || poolCost === BigInt(0)
                        ? "bg-white/5 text-mut cursor-not-allowed"
                        : "btn-gold"
                    } ${joinPhase === "approving" || joinPhase === "buying" ? "animate-pulse" : ""}`}
                  >
                    {joinPhase === "approving"
                      ? "Approving USDC…"
                      : joinPhase === "buying"
                        ? "Joining…"
                        : `Join with ${poolQty} ticket${poolQty === 1 ? "" : "s"} · $${formatUnits(poolCost, USDC_DECIMALS)}`}
                  </button>
                ) : (
                  <div className="mt-4">
                    <ConnectWallet />
                  </div>
                )}

                {joinPhase === "success" && (
                  <div className="mt-3">
                    <p className="text-wins-green text-sm font-heading font-bold">You&rsquo;re in 🎰</p>
                    <button
                      onClick={handleSharePool}
                      className="mt-2 text-gold text-xs font-heading font-bold underline"
                    >
                      Share on Farcaster
                    </button>
                  </div>
                )}
                {joinError && <p className="text-coral text-sm mt-3">{joinError}</p>}
              </>
            )}
          </div>

          {/* Sponsor — a secondary CTA below Join, same surface treatment. Sponsored
              tickets ride in the pot but carry no joiner weight of their own; a sponsor
              who also joins still collects a joiner share of the WHOLE pot, including
              their own sponsored tickets' winnings (see FarpotPool's
              test_sponsorWhoAlsoJoins_collectsAJoinerShare). The copy below must never
              say a sponsor "gets nothing" — it is false.

              This panel reads only the aggregate ticket counts from sponsorsOf, never
              sponsorShareOf's `owed`: while a sponsored drawing is still Accumulating
              with no joiners, `owed` reports the sponsor as owed the ENTIRE pot — a
              number that drops to zero the instant anyone joins. Same rule as
              myPastPools/poolRowState below (no payout figure before Settled); there is
              simply nothing here to gate because no payout figure is read at all. */}
          <div className="play-ticket-panel">
            <h3 className="text-white font-heading font-extrabold text-sm">Sponsor this pool</h3>
            <p className="pool-dim text-xs mt-2">
              Your tickets go into the pot, but their winnings pay out to everyone else who joins.
              Sponsoring is how you improve the odds for the whole group.
            </p>

            {sponsoredTickets > BigInt(0) && (
              // Kept as ONE template literal, not split JSX text/expression children — a
              // newline between a text node and an adjacent {expr} is trimmed away entirely
              // by the JSX transform (see the odds-line gotcha in AGENTS.md), which would
              // glue "far" directly onto "by".
              <p className="pool-dimmer text-[11px] mt-2">
                {`${sponsoredTickets.toString()} ticket${
                  sponsoredTickets === BigInt(1) ? "" : "s"
                } sponsored so far${
                  sponsorCount > BigInt(0)
                    ? ` by ${sponsorCount.toString()} sponsor${sponsorCount === BigInt(1) ? "" : "s"}.`
                    : "."
                }`}
              </p>
            )}

            {poolPaused ? (
              <p className="pool-dim text-sm mt-3">
                Joining is paused right now. Existing pools are unaffected.
              </p>
            ) : drawingState?.jackpotLock ? (
              <p className="pool-dim text-sm mt-3">
                The draw is about to happen, so sponsoring is closed for a few minutes. It
                reopens for the next drawing.
              </p>
            ) : sponsorAtCap ? (
              <p className="pool-dim text-sm mt-3">
                Sponsorship for this draw is full for now — we&rsquo;re keeping sponsorships to a
                soft cap of ${(Number(POOL_SPONSOR_SOFT_CAP_USDC) / 1e6).toFixed(0)} per draw
                while the contract is still being audited. It reopens with the next drawing.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between mt-4">
                  <span className="text-white font-heading font-bold text-sm">
                    Tickets to sponsor
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => {
                        haptics.select();
                        setSponsorQuantity(Math.max(1, sponsorQty - 1));
                      }}
                      className="w-8 h-8 rounded-lg bg-white/10 text-white flex items-center justify-center hover:bg-white/20"
                    >
                      −
                    </button>
                    <span className="text-white font-heading font-extrabold w-8 text-center">
                      {sponsorQty}
                    </span>
                    <button
                      onClick={() => {
                        haptics.select();
                        setSponsorQuantity(Math.min(sponsorMaxThisSponsor, sponsorQty + 1));
                      }}
                      className="w-8 h-8 rounded-lg bg-white/10 text-white flex items-center justify-center hover:bg-white/20"
                    >
                      +
                    </button>
                  </div>
                </div>
                <p className="pool-dimmer text-[11px] mt-2">
                  Up to {sponsorMaxThisSponsor} per sponsorship — sponsor as often as you like.
                </p>

                {isConnected ? (
                  <button
                    onClick={handleSponsor}
                    disabled={
                      sponsorPhase === "approving" ||
                      sponsorPhase === "buying" ||
                      sponsorCost === BigInt(0) ||
                      // Block while the allowance loads for the pool contract — treating
                      // an unknown allowance as "no approval needed" is the exact race
                      // documented in AGENTS.md.
                      poolAllowance === undefined
                    }
                    className={`w-full mt-4 py-4 rounded-xl font-heading font-extrabold text-lg tracking-wide uppercase transition-all ${
                      sponsorPhase === "approving" ||
                      sponsorPhase === "buying" ||
                      sponsorCost === BigInt(0) ||
                      poolAllowance === undefined
                        ? "bg-white/5 text-mut cursor-not-allowed"
                        : "btn-gold"
                    } ${sponsorPhase === "approving" || sponsorPhase === "buying" ? "animate-pulse" : ""}`}
                  >
                    {sponsorPhase === "approving"
                      ? "Approving USDC…"
                      : sponsorPhase === "buying"
                        ? "Sponsoring…"
                        : poolAllowance === undefined
                          ? "Checking approval…"
                          : `Sponsor ${sponsorQty} Ticket${sponsorQty === 1 ? "" : "s"} · $${formatUnits(sponsorCost, USDC_DECIMALS)}`}
                  </button>
                ) : (
                  <div className="mt-4">
                    <ConnectWallet />
                  </div>
                )}

                {sponsorPhase === "success" && (
                  <p className="text-wins-green text-sm font-heading font-bold mt-3">
                    Sponsored 🎁
                  </p>
                )}
                {sponsorError && <p className="text-coral text-sm mt-3">{sponsorError}</p>}
              </>
            )}
          </div>

          {/* Your past pools — the claim path.
              A Claimable pool must NOT show a payout figure: shareOf reports only the pot
              collected so far while claimBatch is still draining, so a number here would be
              wrong and would then change under the user. Only Settled is final.

              Two SEPARATE lists render here, never merged: `myPastPools` (joiner rows, from
              `shareOf`) and `mySponsoredPools` (sponsor rows, from `sponsorShareOf` — Task
              11B, the zero-joiner fallback). Keeping them apart mirrors the on-chain split:
              a joiner row can show a real payout at any time; a sponsor row's `owed` is
              non-zero only on the rare drawing nobody joined, and merging the two would make
              that distinction invisible in the UI. `handleClaimPool`/`claimingDrawing` are
              shared — `claim(uint256[])` is class-agnostic on-chain, it just needs the row
              plumbing to reach it. */}
          {isConnected && (myPastPools.length > 0 || mySponsoredPools.length > 0) && (
            <div className="space-y-4">
              {myPastPools.length > 0 && (
                <div>
                  <h3 className="text-white font-heading font-extrabold text-sm mb-2">
                    Your past pools
                  </h3>
                  <div className="space-y-2">
                    {myPastPools.map((p) => (
                      <div
                        key={p.drawingId.toString()}
                        className="rounded-xl p-4 bg-white/5 flex items-center justify-between gap-3"
                      >
                        <div>
                          <p className="text-white font-heading font-bold text-sm">
                            Draw #{p.drawingId.toString()}
                          </p>
                          <p className="pool-dimmer text-xs">
                            {p.tickets.toString()} ticket{p.tickets === BigInt(1) ? "" : "s"} in
                          </p>
                        </div>

                        {(() => {
                          const row = poolRowState(p);
                          switch (row.kind) {
                            case "settling":
                              return (
                                <span className="pool-dim text-xs font-heading font-bold">
                                  Settling…
                                </span>
                              );
                            case "pending":
                              return <span className="pool-dimmer text-xs">—</span>;
                            case "claimed":
                              return (
                                <span className="text-wins-green text-xs font-heading font-bold">
                                  ✓ claimed
                                </span>
                              );
                            case "claimable":
                              return (
                                <button
                                  onClick={() => handleClaimPool(p.drawingId)}
                                  disabled={claimingDrawing === p.drawingId}
                                  className="px-4 py-2 rounded-lg bg-gold text-navy font-heading font-extrabold text-xs disabled:opacity-50"
                                >
                                  {claimingDrawing === p.drawingId
                                    ? "Claiming…"
                                    : `Claim $${formatUnits(row.owed, USDC_DECIMALS)}`}
                                </button>
                              );
                            default:
                              /* Settled with nothing owed: the pool's tickets did not win. Say
                                 so plainly rather than showing a $0.00 claim button. */
                              return (
                                <span className="pool-dimmer text-xs font-heading font-bold">
                                  No win this draw
                                </span>
                              );
                          }
                        })()}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {mySponsoredPools.length > 0 && (
                <div>
                  <h3 className="text-white font-heading font-extrabold text-sm mb-2">
                    Your sponsorships
                  </h3>
                  <div className="space-y-2">
                    {mySponsoredPools.map((p) => (
                      <div
                        key={p.drawingId.toString()}
                        className="rounded-xl p-4 bg-white/5 flex items-center justify-between gap-3"
                      >
                        <div>
                          <p className="text-white font-heading font-bold text-sm">
                            Draw #{p.drawingId.toString()}
                          </p>
                          <p className="pool-dimmer text-xs">
                            {p.tickets.toString()} ticket{p.tickets === BigInt(1) ? "" : "s"}{" "}
                            sponsored
                          </p>
                        </div>

                        {(() => {
                          const row = poolRowState(p);
                          switch (row.kind) {
                            case "settling":
                              return (
                                <span className="pool-dim text-xs font-heading font-bold">
                                  Settling…
                                </span>
                              );
                            case "pending":
                              return <span className="pool-dimmer text-xs">—</span>;
                            case "claimed":
                              return (
                                <span className="text-wins-green text-xs font-heading font-bold">
                                  ✓ claimed
                                </span>
                              );
                            case "claimable":
                              return (
                                <button
                                  onClick={() => handleClaimPool(p.drawingId)}
                                  disabled={claimingDrawing === p.drawingId}
                                  className="px-4 py-2 rounded-lg bg-gold text-navy font-heading font-extrabold text-xs disabled:opacity-50"
                                >
                                  {claimingDrawing === p.drawingId
                                    ? "Claiming…"
                                    : `Claim $${formatUnits(row.owed, USDC_DECIMALS)}`}
                                </button>
                              );
                            default:
                              /* Settled with nothing owed via the sponsor class. This covers
                                 two on-chain-distinct cases the row cannot tell apart without
                                 reading poolOf(drawingId).tickets (deliberately out of scope —
                                 see the Task 11B review): other people joined and the
                                 sponsorship did its job (whether or not their ticket won), OR
                                 nobody joined and the group's ticket genuinely lost. "No win
                                 this draw" is FALSE in the first case whenever the joiners won,
                                 and contradicts the standing rule below (a sponsor must never
                                 be told they got nothing) — say only what this read proves: no
                                 payout via the sponsor class. */
                              return (
                                <span className="pool-dimmer text-xs font-heading font-bold">
                                  No sponsor payout this draw
                                </span>
                              );
                          }
                        })()}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {poolClaimError && <p className="text-coral text-sm mt-2">{poolClaimError}</p>}

              {/* Fires after a successful group claim — see handleClaimPool's group-win fetch.
                  `pot` is the drawing's TOTAL payout (poolOf), never this wallet's own share, so
                  the card and cast read the same for every member of the winning pool. No
                  button when the pot came back zero (the decorative fetch failed, or this drawing
                  genuinely paid nothing via this claim class). */}
              {lastGroupWin && lastGroupWin.pot > BigInt(0) && (
                <div className="rounded-xl p-4 bg-white/5 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-white font-heading font-bold text-sm">
                      Draw #{lastGroupWin.drawingId.toString()} claimed
                    </p>
                    <p className="pool-dimmer text-xs">
                      ${formatUnits(lastGroupWin.pot, USDC_DECIMALS)} across{" "}
                      {lastGroupWin.contributorCount.toString()} player
                      {lastGroupWin.contributorCount === BigInt(1) ? "" : "s"}
                    </p>
                  </div>
                  <button
                    onClick={handleShareGroupWin}
                    className="px-4 py-2 rounded-lg bg-royal text-white text-xs font-heading font-bold shrink-0"
                  >
                    Share the group win
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
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

      {/* Megapot attribution — bottom of every tab, connected or not.
          Nominative text use only: their ToS grants no licence to the Megapot
          logo without written permission, which we have not asked for yet. */}
      <p className="text-center text-[10px] uppercase tracking-[0.25em] text-mut/70">
        Powered by Megapot
      </p>

      {/* ── Wallet sheet ─────────────────────────────────────────── */}
      {walletSheetOpen && (
        <div
          className="wallet-sheet-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setWalletSheetOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-sheet-title"
            className="wallet-sheet"
          >
            <div className="flex items-center justify-between gap-4">
              <h2 id="wallet-sheet-title" className="text-xl font-heading font-extrabold text-navy">
                Wallet
              </h2>
              <button
                onClick={() => setWalletSheetOpen(false)}
                className="ticket-picker-close"
                aria-label="Close wallet details"
              >
                ×
              </button>
            </div>

            {isConnected && address ? (
              <>
                <div className="wallet-sheet-rows">
                  <div className="wallet-sheet-row">
                    <span className="wallet-sheet-label">Status</span>
                    <span className="flex items-center gap-2 font-semibold text-navy">
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                      Connected · Base
                    </span>
                  </div>
                  <div className="wallet-sheet-row">
                    <span className="wallet-sheet-label">Address</span>
                    <button
                      type="button"
                      className="wallet-sheet-copy"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(address);
                          setAddressCopied(true);
                          haptics.select();
                          setTimeout(() => setAddressCopied(false), 1600);
                        } catch {
                          /* clipboard blocked — the address is still readable above */
                        }
                      }}
                    >
                      <span className="font-mono">{shortenAddress(address)}</span>
                      <span className="wallet-sheet-copy-hint">
                        {addressCopied ? "Copied" : "Copy"}
                      </span>
                    </button>
                  </div>
                  <div className="wallet-sheet-row">
                    <span className="wallet-sheet-label">Balance</span>
                    <span className="font-semibold text-navy">
                      {usdcBalance !== undefined ? `$${formatUSDC(usdcBalance)} USDC` : "…"}
                    </span>
                  </div>
                </div>

                <a
                  href={`https://basescan.org/address/${address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="wallet-sheet-link"
                >
                  View on BaseScan ↗
                </a>

                <button
                  onClick={() => {
                    disconnect();
                    setWalletSheetOpen(false);
                  }}
                  className="wallet-sheet-disconnect"
                >
                  Disconnect
                </button>
              </>
            ) : (
              /* Not connected: the sheet becomes the way in, so the chip is
                 never a dead control. It flips to the panel above by itself
                 once the connection lands. */
              <>
                <div className="wallet-sheet-rows">
                  <div className="wallet-sheet-row">
                    <span className="wallet-sheet-label">Status</span>
                    <span className="flex items-center gap-2 font-semibold text-navy">
                      <span className="w-2 h-2 rounded-full bg-slate-400" />
                      Not connected
                    </span>
                  </div>
                  <div className="wallet-sheet-row">
                    <span className="wallet-sheet-label">Network</span>
                    <span className="font-semibold text-navy">Base</span>
                  </div>
                </div>

                <p className="text-center text-sm text-mut">
                  Connect to buy tickets, gift them, and claim winnings.
                </p>

                <ConnectWallet
                  className="w-full !bg-transparent hover:!bg-transparent !p-0 !rounded-xl"
                  disconnectedLabel={
                    <span className="w-full py-3.5 rounded-xl font-heading font-extrabold text-base tracking-wide uppercase btn-gold inline-flex items-center justify-center">
                      Connect wallet
                    </span>
                  }
                />
              </>
            )}
          </div>
        </div>
      )}

      {/* Bottom navigation (fixed) */}
      <BottomNav activeTab={activeTab} onTabChange={setActiveTab} hasClaimable={isConnected && totalClaimable > BigInt(0)} />
    </div>
  );
}
