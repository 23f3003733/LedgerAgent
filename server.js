import "dotenv/config";
import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let orders = [];
let usdPerUnit = {};

async function loadLedger() {
  const rootResponse = await fetch(process.env.EXAM_DATA_URL);
  if (!rootResponse.ok) throw new Error("Could not open the exam data URL");

  const root = await rootResponse.json();

  const [ratesResponse, exportResponse] = await Promise.all([
    fetch(root.links.rates),
    fetch(root.links.export),
  ]);

  if (!ratesResponse.ok || !exportResponse.ok) {
    throw new Error("Could not download ledger rates or orders");
  }

  const rates = await ratesResponse.json();
  usdPerUnit = rates.usd_per_unit;

  const ndjson = await exportResponse.text();
  const rows = ndjson
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  // Keep only the latest version of each order.
  const latestById = new Map();
  for (const row of rows) {
    const previous = latestById.get(row.id);
    if (
      !previous ||
      Date.parse(row.updated_at) > Date.parse(previous.updated_at)
    ) {
      latestById.set(row.id, row);
    }
  }

  orders = [...latestById.values()];
  console.log(`Loaded ${orders.length} current orders`);
}

const querySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    metric: {
      type: "string",
      enum: [
        "revenue",
        "refunds",
        "average_order_value",
        "order_count",
        "units_sold",
        "top_product_revenue",
        "top_product_units",
        "top_customer_revenue",
        "top_customer_orders",
      ],
    },
    region: { type: ["string", "null"] },
    product: { type: ["string", "null"] },
    customer: { type: ["string", "null"] },
    startDate: { type: ["string", "null"] },
    endDate: { type: ["string", "null"] },
    currency: { type: "string", enum: ["USD", "EUR", "INR"] },
    groupBy: {
      type: "string",
      enum: ["none", "region", "product", "customer", "month"],
    },
  },
  required: [
    "metric",
    "region",
    "product",
    "customer",
    "startDate",
    "endDate",
    "currency",
    "groupBy",
  ],
};

function indiaDate(isoDate) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoDate));
}

function answerQuestion(query) {
  let selected = orders.filter((order) => {
    const date = indiaDate(order.created_at);

    return (
      (!query.region ||
        order.region.toLowerCase() === query.region.toLowerCase()) &&
      (!query.product ||
        order.product.toLowerCase() === query.product.toLowerCase()) &&
      (!query.customer ||
        order.customer.toLowerCase() === query.customer.toLowerCase()) &&
      (!query.startDate || date >= query.startDate) &&
      (!query.endDate || date <= query.endDate)
    );
  });

  const metric = query.metric;
  const moneyMetric =
    metric === "revenue" ||
    metric === "refunds" ||
    metric === "average_order_value" ||
    metric.endsWith("_revenue");

  if (metric === "refunds") {
    selected = selected.filter((order) => order.status === "refunded");
  } else if (metric === "order_count" || metric === "top_customer_orders") {
    selected = selected.filter((order) => order.status !== "void");
  } else {
    selected = selected.filter((order) => order.status === "paid");
  }

  function valueFor(order) {
    if (moneyMetric) {
      const usd = order.amount * usdPerUnit[order.currency];
      return usd / usdPerUnit[query.currency];
    }
    if (metric.includes("units")) return order.qty;
    return 1;
  }

  function labelFor(order) {
    if (query.groupBy === "region") return order.region;
    if (query.groupBy === "product") return order.product;
    if (query.groupBy === "customer") return order.customer;
    if (query.groupBy === "month") {
      return indiaDate(order.created_at).slice(0, 7);
    }
    return null;
  }

  if (metric.startsWith("top_")) {
    const dimension = metric.includes("product") ? "product" : "customer";
    const totals = new Map();

    for (const order of selected) {
      const label = order[dimension];
      totals.set(label, (totals.get(label) ?? 0) + valueFor(order));
    }

    const winner = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
    return winner ? winner[0] : null;
  }

  if (query.groupBy !== "none") {
    const totals = new Map();

    for (const order of selected) {
      const label = labelFor(order);
      const current = totals.get(label) ?? { sum: 0, count: 0 };
      current.sum += valueFor(order);
      current.count += 1;
      totals.set(label, current);
    }

    return Object.fromEntries(
      [...totals.entries()].map(([label, item]) => {
        const value =
          metric === "average_order_value"
            ? item.sum / item.count
            : item.sum;

        return [
          label,
          moneyMetric ? Number(value.toFixed(2)) : value,
        ];
      }),
    );
  }

  const total = selected.reduce((sum, order) => sum + valueFor(order), 0);

  if (metric === "average_order_value") {
    return selected.length
      ? Number((total / selected.length).toFixed(2))
      : 0;
  }

  return moneyMetric ? Number(total.toFixed(2)) : total;
}

app.post("/ask", async (req, res) => {
  try {
    const question = req.body?.question;
    if (typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ error: "Send JSON with a question string." });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-6-luna",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "ledger_query",
          strict: true,
          schema: querySchema,
        },
      },
      messages: [
        {
          role: "system",
          content: `Translate the user's question into a ledger query.
Use only the exact product names and regions: Mixer, Blender, Juicer, Kettle,
Air Fryer, Toaster, Rice Cooker, Grinder; North, South, East, West, Central.
Use Asia/Kolkata calendar dates. For a named month, set its first and last date.
Use USD unless the question requests EUR or INR.
Revenue means the sum of amount for paid orders. Refunds means refunded orders.
For average paid order value, choose average_order_value; it is paid revenue
divided by the number of paid orders.
For "most", choose the matching top_* metric. Use groupBy only when the
question asks for a breakdown. Use null for filters the user did not specify.`,
        },
        { role: "user", content: question },
      ],
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const answer = answerQuestion(parsed);

    return res.json({ answer });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not answer that question." });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

await loadLedger();

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`Ledger Agent listening on port ${port}`);
});