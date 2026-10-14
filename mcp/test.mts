// Drives mcp/server.mts over stdio with the MCP SDK Client, against the real market server.
// Default: starts demo/market/server.mts as a child (PORT=4095, SCENARIO=0) and seeds the items it needs.
// Already-running market: MARKET_URL=http://localhost:4022 node mcp/test.mts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const REAL = process.env.MARKET_URL;
const PORT = Number(process.env.TEST_PORT ?? 4095);
const MARKET_URL = (REAL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const OWNER_MAX = 90;
const VERBOSE = !!process.env.VERBOSE;
const RUN = Date.now() % 10000;

let market: ChildProcess | undefined;
if (!REAL) {
  market = spawn(process.execPath, [fileURLToPath(new URL("../demo/market/server.mts", import.meta.url))], {
    env: { ...process.env, PORT: String(PORT), SCENARIO: "0" },
    stdio: VERBOSE ? "inherit" : "ignore",
  });
  market.on("exit", (code) => { if (code) console.error(`market server exited with ${code}`); });
}
async function waitForMarket() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${MARKET_URL}/api/state`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`market did not answer at ${MARKET_URL}/api/state`);
}
async function post(path: string, body: unknown) {
  const res = await fetch(MARKET_URL + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data?.error}`);
  return data;
}

let failures = 0;
let passes = 0;
function check(cond: unknown, msg: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (cond) passes++; else failures++;
}

let client: Client | undefined;
try {
  await waitForMarket();
  // Seed: two negotiable unique items (ask 100, floor 60) and a physical item with a refund guarantee.
  const declineItem = await post("/api/control/list", { name: `Decline Test ${RUN}`, ask: 100, floor: 60, mechanism: "offers", staleSecs: 0 });
  const bargainItem = await post("/api/control/list", { name: `Bargain Test ${RUN}`, ask: 100, floor: 60, mechanism: "offers", staleSecs: 0 });
  const physItem = await post("/api/control/list", { name: `Physical Test ${RUN}`, ask: 40, kind: "physical" });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.mts", import.meta.url))],
    env: { ...process.env, MARKET_URL, BUYER_NAME: process.env.BUYER_NAME || `Claude-test-${RUN}`, OWNER_MAX: String(OWNER_MAX) } as Record<string, string>,
    stderr: "inherit",
  });
  client = new Client({ name: "holdback-test", version: "0.0.1" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client!.callTool({ name, arguments: args });
    const text: string = r.content?.[0]?.text ?? "";
    const [human, json] = text.split("\n\n---\n");
    console.log(`\n> ${name}(${JSON.stringify(args)})${r.isError ? "  [isError]" : ""}\n${human}`);
    if (VERBOSE && json) console.log(json);
    return { isError: !!r.isError, human, json: json ? JSON.parse(json) : undefined };
  };

  const tools = (await client.listTools()).tools;
  const names = tools.map((t) => t.name).sort();
  check(["buy_now", "get_item", "list_items", "make_offer", "my_holds", "place_bid", "reclaim", "respond_to_counter"].every((n) => names.includes(n)), `8 tools listed: ${names.join(", ")}`);
  const banned = /dusdc|solana|nft|escrow|wallet|explorer|on-chain/i;
  check(!tools.some((t) => banned.test(t.description ?? "")), "tool descriptions use card-hold wording only");
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  check(prompts.includes("buy_for_me"), "buy_for_me prompt listed");
  const p = await client.getPrompt({ name: "buy_for_me", arguments: { item: "Golden Monkey", budget: "85" } });
  check(JSON.stringify(p.messages).includes("85 USD") && !banned.test(JSON.stringify(p.messages)), "buy_for_me prompt renders budget in USD");

  const list = await call("list_items");
  check(!list.isError && Array.isArray(list.json) && list.json.length >= 3, "list_items returns the seeded items");
  const target = list.json.find((i: any) => i.id === bargainItem.id);
  check(target?.mechanism === "offers" && target?.kind === "unique", `seeded item ${bargainItem.id} is a unique item sold by offers`);

  const got = await call("get_item", { id: target.id });
  check(!got.isError && got.json.watchers.length > 0, "get_item registers watcher");

  // owner-max rejection (client-side, never reaches market)
  const tooHigh = await call("make_offer", { id: target.id, amount: OWNER_MAX + 50 });
  check(tooHigh.isError && tooHigh.human.includes(`${OWNER_MAX} USD`), "offer above OWNER_MAX rejected with the owner's limit");
  const bidHigh = await call("place_bid", { id: target.id, max: 1000 });
  check(bidHigh.isError && bidHigh.human.includes("owner's limit"), "bid above OWNER_MAX rejected");

  // Regression: after a decline the standing price is the ask (100 > OWNER_MAX); accepting must be refused.
  const low = await call("make_offer", { id: declineItem.id, amount: 30 });
  check(!low.isError && low.json.reply.action === "decline" && low.json.hold.status === "released", `lowball 30 → declined, hold released (${low.json?.reply?.action}, ${low.json?.hold?.status})`);
  const accDeclined = await call("respond_to_counter", { id: declineItem.id, action: "accept" });
  check(accDeclined.isError && accDeclined.human.includes("owner's limit"), "accepting the ask after a decline (above OWNER_MAX) is refused");
  const afterDecline = await (await fetch(`${MARKET_URL}/api/items/${declineItem.id}`)).json() as any;
  check(afterDecline.status === "listed" && !afterDecline.holds.some((h: any) => h.status === "captured"), "nothing captured on the declined item");

  // bargain: open low, counter-offer, accept
  let amount = Math.min(Math.round(target.ask * 0.75), OWNER_MAX);
  let r1 = await call("make_offer", { id: target.id, amount });
  while (!r1.isError && r1.json.reply.action === "decline" && amount < OWNER_MAX) {
    amount = Math.min(amount + 10, OWNER_MAX); r1 = await call("make_offer", { id: target.id, amount });
  }
  check(!r1.isError && r1.json.reply.action === "counter", `first offer ${amount} → seller counters (${r1.json?.reply?.action} ${r1.json?.reply?.amount})`);
  check(r1.json?.hold?.status === "held" && r1.json.hold.ref && r1.human.includes("on your card"), "first offer is HELD on the card with a processor ref");

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
    const acc = await call("respond_to_counter", { id: target.id, action: "accept" });
    if (last.json.reply.amount > OWNER_MAX) check(acc.isError, "accepting a counter above OWNER_MAX is refused");
    else check(!acc.isError && acc.json.item.status === "sold" && acc.json.hold.status === "captured", `accept → sold at ${acc.json?.item?.soldFor}, hold captured`);
  }

  // guarantee purchase: charged at once, then reclaimed → refunded
  const bought = await call("buy_now", { id: physItem.id });
  check(!bought.isError && bought.json.hold.status === "captured" && bought.json.hold.refundableUntil, "physical buy_now is captured with a refundableUntil");
  const back = await call("reclaim", { hold_id: bought.json?.hold?.id });
  check(!back.isError && back.json.hold.status === "refunded" && back.human.includes("REFUNDED"), `reclaim on the physical buy → ${back.json?.hold?.status}`);

  const holds = await call("my_holds");
  const hs = holds.json?.holds ?? [];
  check(!holds.isError && hs.length >= 3 && typeof holds.json.card === "string", `my_holds shows ${hs.length} holds and the card`);
  check(hs.some((h: any) => h.status === "released" && h.itemId === target.id), "superseded offer hold was released");
  check(hs.some((h: any) => h.status === "captured" && h.itemId === target.id), "winning hold was captured");
  check(hs.some((h: any) => h.status === "refunded" && h.itemId === physItem.id), "physical purchase shows as refunded");
  check(!hs.some((h: any) => h.status === "held"), "no dangling holds");
  check(!banned.test(holds.human), "my_holds output uses card-hold wording only");
} catch (e) {
  failures++; console.error("ERROR", e);
} finally {
  await client?.close();
  market?.kill();
}
console.log(`\n${failures ? `${failures} FAILURE(S), ${passes} passed` : `ALL ${passes} PASSED`} (market: ${MARKET_URL}${REAL ? "" : " — child process"})`);
process.exit(failures ? 1 : 0);
