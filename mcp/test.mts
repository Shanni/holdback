// Drives mcp/server.mts over stdio with the MCP SDK Client, against the real market server and Stripe test mode.
// Default: starts demo/market/server.mts as a child (PORT=4095, a fresh temp DATA_DIR, its own ADMIN_TOKEN) and
// seeds the products it needs through the admin API. Needs Stripe TEST keys (STRIPE_SECRET_KEY=sk_test_...,
// STRIPE_PUBLISHABLE_KEY=pk_test_...) in .env or the environment; without them it prints "skipped" and exits 0.
// Already-running market (test mode only): MARKET_URL=http://localhost:4022 ADMIN_TOKEN=... node mcp/test.mts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
try { process.loadEnvFile(path.join(ROOT, ".env")); } catch {}

const REAL = process.env.MARKET_URL;
const PORT = Number(process.env.TEST_PORT ?? 4095);
const MARKET_URL = (REAL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const OWNER_MAX = 90;
const VERBOSE = !!process.env.VERBOSE;
const RUN = Date.now() % 10000;
const SERVER = fileURLToPath(new URL("./server.mts", import.meta.url));

if (!REAL && !(process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") && process.env.STRIPE_PUBLISHABLE_KEY?.startsWith("pk_test_"))) {
  console.log("skipped: needs Stripe test keys in .env (STRIPE_SECRET_KEY=sk_test_..., STRIPE_PUBLISHABLE_KEY=pk_test_...; see .env.example), " +
    "or MARKET_URL pointing at a running test-mode market");
  process.exit(0);
}

let market: ChildProcess | undefined;
let dataDir: string | undefined;
let ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!REAL) {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdback-mcp-test-"));
  ADMIN_TOKEN = crypto.randomBytes(18).toString("base64url");
  market = spawn(process.execPath, [path.join(ROOT, "demo/market/server.mts")], {
    env: { ...process.env, PORT: String(PORT), PUBLIC_URL: MARKET_URL, DATA_DIR: dataDir, ADMIN_TOKEN },
    stdio: VERBOSE ? "inherit" : ["ignore", "ignore", "inherit"],
  });
  market.on("exit", (code) => { if (code) console.error(`market server exited with ${code}`); });
} else if (!ADMIN_TOKEN) {
  try { ADMIN_TOKEN = fs.readFileSync(path.join(ROOT, "data/admin-token"), "utf8").trim(); } catch {}
}

async function waitForMarket() {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${MARKET_URL}/api/config`);
      if (r.ok) return (await r.json()) as any;
    } catch {}
    if (market?.exitCode !== null && market?.exitCode !== undefined) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`market did not answer at ${MARKET_URL}/api/config`);
}
async function http(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(MARKET_URL + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data?.error}`);
  return data;
}

let failures = 0;
let passes = 0;
function check(cond: unknown, msg: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (cond) passes++; else failures++;
}

async function mcpClient(env: Record<string, string | undefined>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: Object.fromEntries(Object.entries({ ...process.env, MARKET_URL, OWNER_MAX: String(OWNER_MAX), HOLDBACK_TOKEN: undefined, ...env })
      .filter(([, v]) => v !== undefined)) as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: "holdback-test", version: "0.0.2" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text: string = r.content?.[0]?.text ?? "";
    const [human, json] = text.split("\n\n---\n");
    console.log(`\n> ${name}(${JSON.stringify(args)})${r.isError ? "  [isError]" : ""}\n${human}`);
    if (VERBOSE && json) console.log(json);
    return { isError: !!r.isError, human, json: json ? JSON.parse(json) : undefined };
  };
  return { client, call };
}

const clients: Client[] = [];
try {
  const config = await waitForMarket();
  if (config?.provider?.mode !== "test") throw new Error(`the market at ${MARKET_URL} is not in Stripe test mode (${config?.provider?.mode}); refusing to place holds`);
  if (!ADMIN_TOKEN) throw new Error("ADMIN_TOKEN is needed to seed products on an already-running market");
  const admin = (body: unknown) => http("POST", "/api/admin/products", body, ADMIN_TOKEN);
  // Seed: two negotiable unique items (ask 100, floor 60, open to offers) and a physical item with a refund guarantee.
  const declineItem = await admin({ name: `Decline Test ${RUN}`, ask: 100, floor: 60, openToOffers: true, staleSecs: 0 });
  const bargainItem = await admin({ name: `Bargain Test ${RUN}`, ask: 100, floor: 60, openToOffers: true, staleSecs: 0 });
  const physItem = await admin({ name: `Physical Test ${RUN}`, ask: 40, kind: "physical" });

  // ---- no card: a second MCP server that registers its own buyer on first use and has no card
  const nc = await mcpClient({ BUYER_NAME: `NoCard-test-${RUN}` });
  clients.push(nc.client);
  const ncList = await nc.call("list_items");
  check(!ncList.isError && /no card yet/i.test(ncList.human) && /add_card/.test(ncList.human), "list_items (fresh buyer) says there is no card yet and points to add_card");
  const ncBuy = await nc.call("buy_now", { id: physItem.id });
  const setupUrl = ncBuy.human.match(/https?:\/\/\S+\/card\/\?code=[\w-]+/)?.[0];
  check(ncBuy.isError && /card is needed/i.test(ncBuy.human) && !!setupUrl, `hold without a card → "a card is needed" with a setup URL (${setupUrl})`);
  check(/nothing is charged|charges nothing/i.test(ncBuy.human) && /4242 4242 4242 4242/.test(ncBuy.human), "needs-card message says nothing is charged and gives the test card (test mode)");
  if (setupUrl) {
    const code = new URL(setupUrl).searchParams.get("code")!;
    const s = await http("GET", `/api/card-setup/${encodeURIComponent(code)}`);
    check(s.clientSecret && s.mode === "test", "setup code from the needs-card message is live on the market (SetupIntent client secret)");
    const page = await fetch(setupUrl);
    check(page.ok, `the setup URL serves the card page (${page.status})`);
  }
  const ncAdd = await nc.call("add_card");
  check(!ncAdd.isError && typeof ncAdd.json?.setupUrl === "string" && ncAdd.human.includes(ncAdd.json.setupUrl), "add_card returns a setupUrl for the owner");
  const ncHolds = await nc.call("my_holds");
  check(!ncHolds.isError && /no card yet/i.test(ncHolds.human) && ncHolds.json?.hasCard === false, "my_holds (no card) says so");
  const physAfter = await http("GET", `/api/items/${physItem.id}`);
  check(physAfter.status === "listed" && physAfter.holds.length === 0, "no hold was placed for the cardless buyer");

  // ---- main buyer: registered by the test, Stripe's test Visa attached, handed to the MCP server via HOLDBACK_TOKEN
  const reg = await http("POST", "/api/buyers", { name: `Claude-test-${RUN}`, kind: "mcp", max: OWNER_MAX });
  check(typeof reg.token === "string" && reg.hasCard === false, `registered buyer ${reg.id} (no card yet)`);
  const card = await http("POST", "/api/me/test-card", undefined, reg.token);
  check(/4242/.test(card.card ?? ""), `test card attached: ${card.card}`);

  const { client, call } = await mcpClient({ HOLDBACK_TOKEN: reg.token, BUYER_NAME: "ignored-when-token-set" });
  clients.push(client);

  const tools = (await client.listTools()).tools;
  const names = tools.map((t) => t.name).sort();
  check(["add_card", "buy_now", "get_item", "list_items", "make_offer", "my_holds", "place_bid", "reclaim", "respond_to_counter"].every((n) => names.includes(n)), `9 tools listed: ${names.join(", ")}`);
  const banned = /dusdc|solana|nft|escrow|wallet|explorer|on-chain|balance|available credit/i;
  check(!tools.some((t) => banned.test(t.description ?? "")), "tool descriptions use card-hold wording only (no crypto, no balance)");
  check(tools.filter((t) => ["make_offer", "place_bid", "buy_now"].includes(t.name)).every((t) => /add_card/.test(t.description ?? "")), "hold tools mention needing a card (add_card)");
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  check(prompts.includes("buy_for_me"), "buy_for_me prompt listed");
  const p = await client.getPrompt({ name: "buy_for_me", arguments: { item: "Blue vase", budget: "85" } });
  const ptxt = JSON.stringify(p.messages);
  check(ptxt.includes("85 USD") && /add_card/.test(ptxt) && !banned.test(ptxt), "buy_for_me prompt renders budget in USD and mentions add_card");

  const list = await call("list_items");
  check(!list.isError && Array.isArray(list.json) && list.json.length >= 3, "list_items returns the seeded items");
  check(list.human.includes(card.card), "list_items shows the HOLDBACK_TOKEN buyer's card");
  const target = list.json.find((i: any) => i.id === bargainItem.id);
  check(target?.mechanism === "offers" && target?.kind === "unique", `seeded item ${bargainItem.id} is a unique item sold by offers`);

  const got = await call("get_item", { id: target.id });
  check(!got.isError && got.json.watchers.includes(reg.name), "get_item registers the token's buyer as a watcher");

  // owner-max rejection (client-side, never reaches market)
  const tooHigh = await call("make_offer", { id: target.id, amount: OWNER_MAX + 50 });
  check(tooHigh.isError && tooHigh.human.includes(`${OWNER_MAX} USD`), "offer above OWNER_MAX rejected with the owner's limit");
  const bidHigh = await call("place_bid", { id: target.id, max: 1000 });
  check(bidHigh.isError && bidHigh.human.includes("owner's limit"), "bid above OWNER_MAX rejected");

  // Regression: after a decline the standing price is the ask (100 > OWNER_MAX); accepting must be refused.
  const low = await call("make_offer", { id: declineItem.id, amount: 30 });
  check(!low.isError && low.json.reply.action === "decline" && low.json.hold.status === "released" && /^pi_/.test(low.json.hold.ref),
    `lowball 30 → declined, hold released (${low.json?.reply?.action}, ${low.json?.hold?.status}, ref ${low.json?.hold?.ref})`);
  const accDeclined = await call("respond_to_counter", { id: declineItem.id, action: "accept" });
  check(accDeclined.isError && accDeclined.human.includes("owner's limit"), "accepting the ask after a decline (above OWNER_MAX) is refused");
  const afterDecline = await http("GET", `/api/items/${declineItem.id}`);
  check(afterDecline.status === "listed" && !afterDecline.holds.some((h: any) => h.status === "captured" || h.status === "held"), "nothing captured or held on the declined item");

  // bargain: open low, counter-offer, accept
  let amount = Math.min(Math.round(target.ask * 0.75), OWNER_MAX);
  let r1 = await call("make_offer", { id: target.id, amount });
  while (!r1.isError && r1.json.reply.action === "decline" && amount < OWNER_MAX) {
    amount = Math.min(amount + 10, OWNER_MAX); r1 = await call("make_offer", { id: target.id, amount });
  }
  check(!r1.isError && r1.json.reply.action === "counter", `first offer ${amount} → seller counters (${r1.json?.reply?.action} ${r1.json?.reply?.amount})`);
  check(r1.json?.hold?.status === "held" && /^pi_/.test(r1.json.hold.ref) && r1.human.includes("on your card"), "first offer is HELD on the card with a Stripe PaymentIntent ref");

  // free-text message: the seller's reply references it and still names a price
  if (r1.json?.reply?.action === "counter" && r1.json.reply.amount > amount + 1) {
    const note = "I'm a student, any flexibility? Huge fan of this series.";
    const withMsg = await call("make_offer", { id: target.id, amount: amount + 1, message: note });
    const turns = withMsg.json?.item?.negotiations ? Object.values(withMsg.json.item.negotiations).flat() as any[] : [];
    check(!withMsg.isError && turns.some((t) => t.from === "buyer" && t.message === note), "message stored as the buyer's turn");
    const said = String(withMsg.json?.reply?.message ?? "");
    check(/student|fan/i.test(said) && withMsg.human.includes(">> Seller:"), `seller reply references the message: "${said}"`);
    check(said.includes(String(withMsg.json?.reply?.amount)), "seller reply still states the number");
    const long = await call("make_offer", { id: target.id, amount: amount + 1, message: "x".repeat(281) });
    check(long.isError, "message over 280 chars rejected by the tool schema");
    amount += 1; r1 = withMsg;
  }

  // counter-offer by calling make_offer again (midpoint) until the counter is within the owner's limit
  let last = r1;
  for (let round = 0; round < 4 && last.json?.reply?.action === "counter" && (round === 0 || last.json.reply.amount > OWNER_MAX); round++) {
    const next = Math.min(Math.round((amount + last.json.reply.amount) / 2), OWNER_MAX);
    if (next <= amount) break;
    amount = next;
    last = await call("make_offer", { id: target.id, amount });
  }
  check(last !== r1, "made a second (counter) offer via make_offer");
  check(!last.isError && ["counter", "accept"].includes(last.json.reply.action), `latest offer ${amount} → ${last.json?.reply?.action} ${last.json?.reply?.amount}`);

  if (last.json?.reply?.action === "counter") {
    if (last.json.reply.amount > OWNER_MAX) {
      const acc = await call("respond_to_counter", { id: target.id, action: "accept" });
      check(acc.isError, "accepting a counter above OWNER_MAX is refused");
      const walk = await call("respond_to_counter", { id: target.id, action: "walk_away" });
      check(!walk.isError && walk.json.hold?.status === "released", "walk_away releases the held offer");
    } else {
      const acc = await call("respond_to_counter", { id: target.id, action: "accept" });
      check(!acc.isError && acc.json.item.status === "sold" && acc.json.hold.status === "captured", `accept → sold at ${acc.json?.item?.soldFor}, hold captured`);
    }
  }

  // guarantee purchase: charged at once, then reclaimed → refunded
  const bought = await call("buy_now", { id: physItem.id });
  check(!bought.isError && bought.json.hold.status === "captured" && bought.json.hold.refundableUntil, "physical buy_now is captured with a refundableUntil");
  const back = await call("reclaim", { hold_id: bought.json?.hold?.id });
  check(!back.isError && back.json.hold.status === "refunded" && back.human.includes("REFUNDED"), `reclaim on the physical buy → ${back.json?.hold?.status}`);

  const holds = await call("my_holds");
  const hs = holds.json?.holds ?? [];
  check(!holds.isError && hs.length >= 3 && holds.json.card === card.card && holds.human.includes(card.card), `my_holds shows ${hs.length} holds and the card label ${holds.json?.card}`);
  check(hs.some((h: any) => h.status === "released" && h.itemId === target.id), "superseded offer hold was released");
  const lastOnTarget = hs.filter((h: any) => h.itemId === target.id).at(-1);
  check(lastOnTarget?.status === "captured" || (lastOnTarget?.status === "released" && last.json?.reply?.amount > OWNER_MAX),
    `bargain's last hold is ${lastOnTarget?.status} (captured on a deal; released only if the seller stayed above the limit)`);
  check(hs.some((h: any) => h.status === "refunded" && h.itemId === physItem.id), "physical purchase shows as refunded");
  check(!hs.some((h: any) => h.status === "held"), "no dangling holds");
  check(!banned.test(holds.human), "my_holds output uses card-hold wording only (no balance)");
} catch (e) {
  failures++; console.error("ERROR", e);
} finally {
  for (const c of clients) await c.close().catch(() => {});
  if (market && market.exitCode === null) {
    const exited = new Promise((r) => market!.once("exit", r));
    market.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n${failures ? `${failures} FAILURE(S), ${passes} passed` : `ALL ${passes} PASSED`} (market: ${MARKET_URL}${REAL ? "" : " — child process, temp DATA_DIR"})`);
process.exit(failures ? 1 : 0);
