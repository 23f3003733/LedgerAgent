import "dotenv/config";
import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 10000, maxRetries: 0 });

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
        "refund_count",
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

const indiaDateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

function indiaDate(isoDate) {
  return indiaDateFormatter.format(new Date(isoDate));
}

const REGIONS = ["North", "South", "East", "West", "Central"];
const PRODUCTS = ["Mixer", "Blender", "Juicer", "Kettle", "Air Fryer", "Toaster", "Rice Cooker", "Grinder"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function extractFilters(question) {
  const region = REGIONS.find((name) => new RegExp("\\b" + name + "\\b", "i").test(question)) ?? null;
  const product = PRODUCTS.find((name) => new RegExp("\\b" + name.replace(/ /g, "\\s+") + "\\b", "i").test(question)) ?? null;
  const monthIndex = MONTHS.findIndex((name) => new RegExp("\\b" + name + "\\b", "i").test(question));
  const yearMatch = question.match(/\b20\d{2}\b/);
  let startDate = null;
  let endDate = null;
  if (monthIndex !== -1 && yearMatch) {
    const year = Number(yearMatch[0]);
    const month = monthIndex + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    startDate = year + "-" + String(month).padStart(2, "0") + "-01";
    endDate = year + "-" + String(month).padStart(2, "0") + "-" + lastDay;
  }
  const currency = /\bEUR\b|euro/i.test(question)
    ? "EUR"
    : /\bINR\b|rupees?\b/i.test(question)
    ? "INR"
    : "USD";
  return { region, product, startDate, endDate, currency };
}

function answerCommonQuestion(question) {
  const q = question.toLowerCase();
  const filters = extractFilters(question);
  const selected = orders.filter((order) => {
    const date = indiaDate(order.created_at);
    return (
      (!filters.region || order.region.toLowerCase() === filters.region.toLowerCase()) &&
      (!filters.product || order.product.toLowerCase() === filters.product.toLowerCase()) &&
      (!filters.startDate || date >= filters.startDate) &&
      (!filters.endDate || date <= filters.endDate)
    );
  });

  const asksCustomerCount =
    /\bcustomers?\b/.test(q) &&
    /\b(how many|count|number of|distinct|different|unique)\b/.test(q) &&
    /\b(bought|purchased|ordered|placed|made|paid)\b/.test(q);
  if (asksCustomerCount && filters.product) {
    const customers = new Set(
      selected.filter((order) => order.status === "paid").map((order) => order.customer)
    );
    return { handled: true, answer: customers.size };
  }

  const asksCount = /\b(how many|count|number of)\b/.test(q);
  const asksRefund = /\b(refund(?:ed|s)?|returns?)\b/.test(q);
  if (asksCount && asksRefund) {
    return {
      handled: true,
      answer: selected.filter((order) => order.status === "refunded").length,
    };
  }

  let metric = null;
  if (/\b(average|avg)\b/.test(q) && /\b(order|paid|value|amount)\b/.test(q)) {
    metric = "average_order_value";
  } else if (/\b(most|highest|top)\b/.test(q) && /\bproduct\b/.test(q) && /\b(revenue|sales|earned|usd)\b/.test(q)) {
    metric = "top_product_revenue";
  } else if (/\b(most|highest|top)\b/.test(q) && /\bproduct\b/.test(q) && /\b(units|quantity)\b/.test(q)) {
    metric = "top_product_units";
  } else if (/\b(most|highest|top)\b/.test(q) && /\bcustomer\b/.test(q) && /\b(revenue|sales|spent)\b/.test(q)) {
    metric = "top_customer_revenue";
  } else if (/\b(most|highest|top)\b/.test(q) && /\bcustomer\b/.test(q) && /\b(orders|purchases)\b/.test(q)) {
    metric = "top_customer_orders";
  } else if (/\b(units|quantity)\b/.test(q)) {
    metric = "units_sold";
  } else if (asksCount && /\borders?\b/.test(q)) {
    metric = "order_count";
  } else if (asksRefund) {
    metric = "refunds";
  } else if (/\b(revenue|sales|earn(?:ed|ings?)?|made|brought in)\b/.test(q)) {
    metric = "revenue";
  }
  if (!metric) return { handled: false };

  let groupBy = "none";
  if (/\b(by|per)\s+region\b/.test(q)) groupBy = "region";
  else if (/\b(by|per)\s+products?\b/.test(q)) groupBy = "product";
  else if (/\b(by|per)\s+customers?\b/.test(q)) groupBy = "customer";
  else if (/\b(by|per)\s+months?\b/.test(q)) groupBy = "month";
  return { handled: true, answer: answerQuestion({ ...filters, metric, groupBy }) };
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

  if (metric === "refunds" || metric === "refund_count") {
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

    const commonAnswer = answerCommonQuestion(question);
    if (commonAnswer.handled) {
      return res.json({ answer: commonAnswer.answer });
    }

    const asksCustomerCount =
        /\b(how many|count|number of)\b/i.test(question) &&
        /\bcustomers?\b/i.test(question) &&
        /\b(bought|purchased|ordered|placed|made)\b/i.test(question);

    const productMatch = question.match(
        /\b(Mixer|Blender|Juicer|Kettle|Air Fryer|Toaster|Rice Cooker|Grinder)\b/i
        );

    if (asksCustomerCount && productMatch) {
        const product = productMatch[1].toLowerCase();

        const region = ["North", "South", "East", "West", "Central"].find((name) =>
            new RegExp(`\\b${name}\\b`, "i").test(question)
        );

        const matchingOrders = orders.filter((order) =>
            order.status === "paid" &&
            order.product.toLowerCase() === product &&
            (!region || order.region === region)
        );

        return res.json({
            answer: new Set(matchingOrders.map((order) => order.customer)).size,
        });
    }

    const isRefundCountQuestion =
        /\b(count|how many|number of)\b/i.test(question) &&
        /\b(refund(?:ed|s)?|returns?)\b/i.test(question);

    if (isRefundCountQuestion) {
    const regions = ["North", "South", "East", "West", "Central"];
    const region = regions.find((name) =>
        new RegExp(`\\b${name}\\b`, "i").test(question)
    );

    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ];
    const monthIndex = months.findIndex((name) =>
        new RegExp(`\\b${name}\\b`, "i").test(question)
    );
    const yearMatch = question.match(/\b20\d{2}\b/);

    let startDate = null;
    let endDate = null;

    if (monthIndex !== -1 && yearMatch) {
        const year = Number(yearMatch[0]);
        const month = monthIndex + 1;
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        startDate = `${year}-${String(month).padStart(2, "0")}-01`;
        endDate = `${year}-${String(month).padStart(2, "0")}-${lastDay}`;
    }

    const count = orders.filter((order) => {
        const date = indiaDate(order.created_at);
        return (
        order.status === "refunded" &&
        (!region || order.region === region) &&
        (!startDate || date >= startDate) &&
        (!endDate || date <= endDate)
        );
    }).length;

    return res.json({ answer: count });
    }

    const asksAveragePaidValue =
        /\baverage\b/i.test(question) &&
        /\bpaid\b/i.test(question) &&
        /\b(order value|order amount|value per order)\b/i.test(question);

    if (asksAveragePaidValue) {
        const regions = ["North", "South", "East", "West", "Central"];
        const region = regions.find((name) =>
            new RegExp(`\\b${name}\\b`, "i").test(question)
        );

        const products = [
            "Mixer", "Blender", "Juicer", "Kettle",
            "Air Fryer", "Toaster", "Rice Cooker", "Grinder",
        ];
        const product = products.find((name) =>
            question.toLowerCase().includes(name.toLowerCase())
        );

        const months = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December",
        ];
        const monthIndex = months.findIndex((name) =>
            new RegExp(`\\b${name}\\b`, "i").test(question)
        );
        const yearMatch = question.match(/\b20\d{2}\b/);

        let startDate = null;
        let endDate = null;

        if (monthIndex !== -1 && yearMatch) {
            const year = Number(yearMatch[0]);
            const month = monthIndex + 1;
            const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
            startDate = `${year}-${String(month).padStart(2, "0")}-01`;
            endDate = `${year}-${String(month).padStart(2, "0")}-${lastDay}`;
        }

        const currency = /\bEUR\b|euro/i.test(question)
            ? "EUR"
            : /\bINR\b|rupee/i.test(question)
            ? "INR"
            : "USD";

        const matchingOrders = orders.filter((order) => {
            const date = indiaDate(order.created_at);
            return (
            order.status === "paid" &&
            (!region || order.region === region) &&
            (!product || order.product === product) &&
            (!startDate || date >= startDate) &&
            (!endDate || date <= endDate)
            );
        });

        const total = matchingOrders.reduce((sum, order) => {
            const usd = order.amount * usdPerUnit[order.currency];
            return sum + usd / usdPerUnit[currency];
        }, 0);

        const average = matchingOrders.length
            ? Number((total / matchingOrders.length).toFixed(2))
            : 0;

        return res.json({ answer: average });
    }   
    const asksTopProductRevenue =
        /\b(which|what)\b/i.test(question) &&
        /\b(product)\b/i.test(question) &&
        /\b(most|highest|top)\b/i.test(question) &&
        /\b(revenue|sales|earned)\b/i.test(question);

    if (asksTopProductRevenue) {
        const regions = ["North", "South", "East", "West", "Central"];
        const region = regions.find((name) =>
            new RegExp(`\\b${name}\\b`, "i").test(question)
        );

        const months = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December",
        ];
        const monthIndex = months.findIndex((name) =>
            new RegExp(`\\b${name}\\b`, "i").test(question)
        );
        const yearMatch = question.match(/\b20\d{2}\b/);

        let startDate = null;
        let endDate = null;

        if (monthIndex !== -1 && yearMatch) {
            const year = Number(yearMatch[0]);
            const month = monthIndex + 1;
            const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
            startDate = `${year}-${String(month).padStart(2, "0")}-01`;
            endDate = `${year}-${String(month).padStart(2, "0")}-${lastDay}`;
        }

        const totals = new Map();

        for (const order of orders) {
            const date = indiaDate(order.created_at);

            if (
                order.status !== "paid" ||
                (region && order.region !== region) ||
                (startDate && date < startDate) ||
                (endDate && date > endDate)
            ) {
                continue;
            }

            const usd = order.amount * usdPerUnit[order.currency];
            totals.set(order.product, (totals.get(order.product) ?? 0) + usd);
        }

        const winner = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
        return res.json({ answer: winner ? winner[0] : null });
    }
    const completion = await openai.chat.completions.create({
      model: "gpt-6-luna",
      reasoning_effort: "none",
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
Revenue means the sum of amount for paid orders. Refunds means the total refunded amount. For questions asking how many orders were refunded, choose refund_count.
For average paid order value, choose average_order_value; it is paid revenue
divided by the number of paid orders.
For "most", choose the matching top_* metric. Use groupBy only when the
question asks for a breakdown. Use null for filters the user did not specify.`,
        },
        { role: "user", content: question },
      ],
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const asksRefundCount =
        /\b(how many|count|number of)\b/i.test(question) &&
        /\brefund(?:ed|s)?\b/i.test(question);

    if (asksRefundCount) {
        parsed.metric = "refund_count";
    }
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
