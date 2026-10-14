// Lists handmade items next to the one-of-a-kind monkeys, so the demo store shows physical goods too.
// Each one sells at a fixed price, charged at purchase and refundable for 14 days.
//   node demo/market/seed-store.mts            (market at http://localhost:4022, or MARKET=…)
const MARKET = process.env.MARKET ?? `http://localhost:${process.env.PORT ?? 4022}`;

const ITEMS = [
  { name: "Hand-thrown monkey mug", ask: 38, image: "/store/img/mug.svg",
    description: "Stoneware, wheel-thrown and glazed in teal, with a monkey pressed into the side. 350 ml, dishwasher safe." },
  { name: "Hand-knit monkey beanie", ask: 45, image: "/store/img/beanie.svg",
    description: "Merino wool, knit by hand with a mustard brim and pom-pom. One size, stretchy." },
  { name: "Night forest linocut, A3", ask: 60, image: "/store/img/linocut.svg",
    description: "Hand-carved and hand-pulled on cotton paper, signed. Edition of 30. Ships flat in a rigid mailer, tracked." },
];

const have = new Set((await (await fetch(`${MARKET}/api/items`)).json()).map((i: { name: string }) => i.name));
for (const it of ITEMS) {
  if (have.has(it.name)) { console.log(`already listed: ${it.name}`); continue; }
  const r = await fetch(`${MARKET}/api/control/list`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...it, kind: "physical", guaranteeDays: 14 }),
  });
  const body = await r.json();
  console.log(r.ok ? `listed ${body.id}: ${it.name} at ${it.ask}` : `failed ${it.name}: ${body.error}`);
}
