// Scripted buyer agents for the Holdback market. They act ONLY through the HTTP API,
// exactly like the page or an MCP client would, so humans can join at any point.
//
//   Ada  collector, owner's limit 120
//   Bo   bargain hunter, limit 60, offers and falling prices only
//   Cy   fan, limit 95
//
// Auto mode (default): scenes run back to back with pauses scaled by PACE.
// Step mode (STEP=1): each POST /api/control/next runs the next scene.
import { buyerNext } from "./negotiation.mts";

type Opts = {
  base: string;
  pace: number;
  step: boolean;
  enabled: boolean;
  say: (who: string, text: string) => void;
  onChange: () => void;
};

export function createScenario(o: Opts) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * o.pace));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(o.base + path, {
      method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${data.error}`);
    return data;
  }
  const item = async (id: string) => (await api("GET", "/api/items")).find((i: any) => i.id === id);
  async function until<T>(what: string, check: () => Promise<T | undefined | false>, timeoutSecs: number): Promise<T | undefined> {
    const end = Date.now() + timeoutSecs * 1000;
    while (Date.now() < end) {
      const v = await check();
      if (v) return v;
      await wait(500);
    }
    o.say("Director", `gave up waiting for ${what}`);
    return undefined;
  }

  const B: Record<string, { id: string; name: string; max: number }> = {};
  const ids: Record<string, string> = {};

  /** One buyer agent haggling on one item with the shared buyer strategy. */
  async function haggle(who: string, itemId: string) {
    const me = B[who];
    let lastOffer: number | undefined;
    let reply: any;
    for (let round = 0; round < 8; round++) {
      const it = await item(itemId);
      if (!it || it.status !== "listed" || it.mechanism !== "offers") return "stopped";
      const move = buyerNext({ ask: it.ask, max: me.max, lastOffer, reply, round });
      if (move.action === "done") return "deal";
      if (move.action === "accept") {
        await api("POST", `/api/items/${itemId}/respond`, { buyerId: me.id, action: "accept", message: move.message });
        return "deal";
      }
      if (move.action === "walk_away") {
        await api("POST", `/api/items/${itemId}/respond`, { buyerId: me.id, action: "walk_away", message: move.message });
        return "walked";
      }
      const r = await api("POST", `/api/items/${itemId}/offer`, { buyerId: me.id, amount: move.amount, message: move.message });
      lastOffer = move.amount;
      reply = r.reply;
      if (reply.action === "accept") return "deal";
      await sleep(2200);
    }
    return "stopped";
  }

  const scenes: { name: string; run: () => Promise<void> }[] = [
    {
      name: "Seller lists Monkey #3 (open to offers for you) and Monkey #1",
      run: async () => {
        ids.m3 = (await api("POST", "/api/control/list", { name: "Monkey #3", hue: 280, ask: 100, floor: 70, goal: "best-price", staleSecs: 0, mechanism: "offers" })).id;
        await sleep(800);
        ids.m1 = (await api("POST", "/api/control/list", { name: "Monkey #1", hue: 28, ask: 100, floor: 50, goal: "best-price", staleSecs: 0 })).id;
      },
    },
    {
      name: "Bo watches Monkey #1 and haggles",
      run: async () => {
        await api("GET", `/api/items/${ids.m1}?buyerId=${B.Bo.id}`);
        await sleep(2000);
        await haggle("Bo", ids.m1);
      },
    },
    {
      name: "Ada and Cy start watching Monkey #1",
      run: async () => {
        await api("GET", `/api/items/${ids.m1}?buyerId=${B.Ada.id}`);
        await sleep(1500);
        await api("GET", `/api/items/${ids.m1}?buyerId=${B.Cy.id}`);
      },
    },
    {
      name: "Auction: Ada, Cy and Bo place proxy bids",
      run: async () => {
        const it = await until("the auction", async () => { const i = await item(ids.m1); return i?.mechanism === "auction" && i; }, 30);
        if (!it) return;
        for (const who of ["Cy", "Bo", "Ada"]) {
          o.say(who, `bidding my owner's limit, ${B[who].max}: I only pay 2nd price + 1 if I win`);
          await api("POST", `/api/items/${ids.m1}/bid`, { buyerId: B[who].id, max: B[who].max }).catch((e) => o.say(who, `bid failed: ${e.message}`));
          await sleep(2000);
        }
      },
    },
    {
      name: "Auction closes: winner pays 2nd price + 1, losers refunded",
      run: async () => {
        await until("the auction to settle", async () => { const i = await item(ids.m1); return i && i.status !== "listed" && !i.holds.some((h: any) => h.status === "held"); }, 600);
      },
    },
    {
      name: "Monkey #2 is listed, nobody watches it",
      run: async () => {
        ids.m2 = (await api("POST", "/api/control/list", { name: "Monkey #2", hue: 200, ask: 90, floor: 40, goal: "best-price", staleSecs: Math.max(4, Math.round(15 * o.pace)) })).id;
      },
    },
    {
      name: "No interest: the seller agent switches Monkey #2 to a Dutch auction",
      run: async () => {
        await until("the Dutch auction", async () => { const i = await item(ids.m2); return (i?.mechanism === "dutch" || i?.mechanism === "offers" || i?.status !== "listed") && i; }, 120);
      },
    },
    {
      name: "Bo buys Monkey #2 once the price is within his limit",
      run: async () => {
        const it = await until("a price Bo can pay", async () => {
          const i = await item(ids.m2);
          if (!i || i.status !== "listed") return i ?? false;
          if (i.mechanism === "offers") return i;
          return i.mechanism === "dutch" && i.price <= B.Bo.max && i;
        }, 300);
        if (!it || it.status !== "listed") return;
        if (it.mechanism === "offers") { await haggle("Bo", ids.m2); return; }
        o.say("Bo", `Dutch price ${it.price} is within my owner's limit (${B.Bo.max}) → buy`);
        await api("POST", `/api/items/${ids.m2}/buy`, { buyerId: B.Bo.id });
      },
    },
    {
      name: "A hi-res print, fixed price with a 7-day guarantee: Cy buys",
      run: async () => {
        ids.print = (await api("POST", "/api/control/list", { name: "Monkey #1 · hi-res print", hue: 28, ask: 5, kind: "digital" })).id;
        await sleep(1500);
        const r = await api("POST", `/api/items/${ids.print}/buy`, { buyerId: B.Cy.id });
        ids.printHold = r.hold.id;
      },
    },
    {
      name: "Cy reclaims the print payment inside the guarantee window",
      run: async () => {
        o.say("Cy", "the file is the wrong resolution: taking my money back, no seller approval needed");
        await api("POST", `/api/holds/${ids.printHold}/reclaim`, { buyerId: B.Cy.id });
        o.say("Director", "Scripted scenes done. Monkey #3 is still open to offers (ask 100): bargain for it from the page or over MCP.");
      },
    },
  ];

  let index = 0;
  let running: string | undefined;
  let ready: Promise<void> = Promise.resolve();

  async function setup() {
    const who = [["Ada", 120], ["Bo", 60], ["Cy", 95]] as const;
    const made = await Promise.all(who.map(([name, max]) => api("POST", "/api/buyers", { name, kind: "agent", max })));
    for (const b of made) B[b.name] = b;
  }
  async function runScene(i: number) {
    const s = scenes[i];
    running = s.name;
    o.say("Director", `Scene ${i + 1}/${scenes.length}: ${s.name}`);
    o.onChange();
    try { await s.run(); } catch (e: any) { o.say("Director", `scene error: ${e.message}`); }
    running = undefined;
    o.onChange();
  }

  return {
    start() {
      if (!o.enabled) {
        // Server only: still list Monkey #3 so humans / MCP have something to bargain over.
        ready = api("POST", "/api/control/list", { name: "Monkey #3", hue: 280, ask: 100, floor: 70, goal: "best-price", staleSecs: 0, mechanism: "offers" }).then(() => {});
        index = scenes.length;
        return;
      }
      ready = setup();
      if (o.step) {
        ready.then(() => o.say("Director", `Step mode: POST /api/control/next runs "${scenes[0].name}"`));
        return;
      }
      ready.then(async () => {
        await sleep(1500);
        while (index < scenes.length) {
          await runScene(index++);
          await sleep(2500);
        }
      }).catch((e) => o.say("Director", `scenario error: ${e.message}`));
    },
    next(): string {
      if (!o.step) return running ? `auto mode, running: ${running}` : index >= scenes.length ? "done" : "auto mode";
      if (running) return `busy: ${running}`;
      if (index >= scenes.length) return "done";
      const i = index++;
      ready.then(() => runScene(i));
      return scenes[i].name;
    },
    status() {
      return {
        mode: !o.enabled ? "off" : o.step ? "step" : "auto",
        scene: index, total: scenes.length, running,
        next: index < scenes.length ? scenes[index].name : undefined,
      };
    },
  };
}
