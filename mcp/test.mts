// Drives mcp/server.mts over stdio with the MCP SDK Client.
// Default: starts the in-memory mock market on :4041.  Real market: MARKET_URL=http://localhost:4022 node mcp/test.mts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { makeMarket } from "./mock-market.mts";

const REAL = process.env.MARKET_URL;
const MARKET_URL = REAL || "http://localhost:4041";
const OWNER_MAX = 90;
const VERBOSE = !!process.env.VERBOSE;

let mock: ReturnType<typeof makeMarket> | undefined;
if (!REAL) { mock = makeMarket(); await new Promise<void>((r) => mock!.listen(4041, r)); }

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.mts", import.meta.url))],
  env: { ...process.env, MARKET_URL, BUYER_NAME: process.env.BUYER_NAME || `Claude-test-${Date.now() % 10000}`, OWNER_MAX: String(OWNER_MAX) } as Record<string, string>,
  stderr: "inherit",
});
const client = new Client({ name: "holdback-test", version: "0.0.1" });
await client.connect(transport);

let failures = 0;
function check(cond: unknown, msg: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  const text: string = r.content?.[0]?.text ?? "";
  const [human, json] = text.split("\n\n---\n");
  console.log(`\n> ${name}(${JSON.stringify(args)})${r.isError ? "  [isError]" : ""}\n${human}`);
  if (VERBOSE && json) console.log(json);
  return { isError: !!r.isError, human, json: json ? JSON.parse(json) : undefined };
}

try {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check(["buy_now", "get_item", "list_items", "make_offer", "my_holds", "place_bid", "reclaim", "respond_to_counter"].every((n) => tools.includes(n)), `8 tools listed: ${tools.join(", ")}`);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  check(prompts.includes("buy_for_me"), "buy_for_me prompt listed");
  const p = await client.getPrompt({ name: "buy_for_me", arguments: { item: "Golden Monkey", budget: "85" } });
  check(JSON.stringify(p.messages).includes("85 dUSDC"), "buy_for_me prompt renders budget");

  const list = await call("list_items");
  check(!list.isError && Array.isArray(list.json) && list.json.length > 0, "list_items returns items");
  const target = list.json.find((i: any) => i.mechanism === "offers" && i.status === "listed");
  check(target, `found a listed 'offers' item: ${target?.id}`);
  if (!target) throw new Error("no offers item to negotiate");

  const got = await call("get_item", { id: target.id });
  check(!got.isError && got.json.watchers.length > 0, "get_item registers watcher");

  // owner-max rejection (client-side, never reaches market)
  const tooHigh = await call("make_offer", { id: target.id, amount: OWNER_MAX + 50 });
  check(tooHigh.isError && tooHigh.human.includes(`${OWNER_MAX} dUSDC`), "offer above OWNER_MAX rejected with the owner's limit");
  const bidHigh = await call("place_bid", { id: target.id, max: 1000 });
  check(bidHigh.isError && bidHigh.human.includes("owner's limit"), "bid above OWNER_MAX rejected");

  // bargain: open low, counter-offer, accept
  let amount = Math.min(Math.round(target.ask * 0.75), OWNER_MAX);
  let r1 = await call("make_offer", { id: target.id, amount });
  while (!r1.isError && r1.json.reply.action === "decline" && amount < OWNER_MAX) {
    amount = Math.min(amount + 10, OWNER_MAX); r1 = await call("make_offer", { id: target.id, amount });
  }
  check(!r1.isError && r1.json.reply.action === "counter", `first offer ${amount} → seller counters (${r1.json?.reply?.action} ${r1.json?.reply?.amount})`);
  check(r1.json?.hold?.status === "held", "first offer is HELD in escrow");

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
    else check(!acc.isError && acc.json.item.status === "sold", `accept → sold at ${acc.json?.item?.soldFor}`);
  }

  const holds = await call("my_holds");
  const hs = holds.json?.holds ?? [];
  check(!holds.isError && hs.length >= 2, `my_holds shows ${hs.length} holds`);
  check(hs.some((h: any) => h.status === "refunded"), "superseded offer hold was refunded");
  check(hs.some((h: any) => h.status === "captured"), "winning hold was captured");
  check(!hs.some((h: any) => h.status === "held" && h.itemId === target.id), "no dangling holds on the bought item");
} catch (e) {
  failures++; console.error("ERROR", e);
} finally {
  await client.close();
  mock?.close();
}
console.log(`\n${failures ? `${failures} FAILURE(S)` : "ALL PASSED"} (market: ${MARKET_URL}${REAL ? "" : " — mock"})`);
process.exit(failures ? 1 : 0);
