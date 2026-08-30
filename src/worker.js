// ===================== 竞品文案分析工具 - Cloudflare Worker 后端 =====================
// 功能：团队口令校验 / 竞品图片分析 / 产品资料存储 / 检索匹配 / 一键生成文案

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const COMPETITOR_SCHEMA_PROMPT = `你是一位资深电商文案分析师。我会给你一张或多张竞品主图/详情页截图（同一款产品的不同部分），请你分析后严格按以下 JSON schema 输出，不要输出任何 schema 之外的文字，不要用 markdown 代码块包裹：

{
  "品类": "",
  "风格定位": "",
  "开头钩子类型": "",
  "痛点类型": [],
  "卖点角度": [],
  "叙述结构": [{"模块": "", "作用": ""}],
  "图片展示顺序": [],
  "语气风格": "",
  "信任背书方式": [],
  "促单话术类型": "",
  "文化叙事引用": ""
}

要求：
1. 只分析文案的结构、角度、语气、逻辑，绝对不要逐字复述原文文案内容
2. 如果某字段无法判断，填空字符串或空数组，不要编造
3. "叙述结构"按图片从上到下的模块顺序描述
4. 只输出 JSON，不要有任何前后缀说明文字`;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-team-passcode",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function checkPasscode(request, env) {
  const provided = request.headers.get("x-team-passcode") || "";
  return provided && provided === env.TEAM_PASSCODE;
}

async function callClaude(env, { system, messages, maxTokens = 2000 }) {
  const resp = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Claude API error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const textBlock = data.content.find((b) => b.type === "text");
  return textBlock ? textBlock.text : "";
}

function extractJson(text) {
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

function uuid() {
  return crypto.randomUUID();
}

// ---------- 路由处理函数 ----------

async function handleLogin(request, env) {
  const { passcode } = await request.json();
  if (passcode === env.TEAM_PASSCODE) {
    return json({ ok: true });
  }
  return json({ ok: false, error: "口令错误" }, 401);
}

async function handleAnalyzeCompetitor(request, env) {
  const body = await request.json();
  const { images, brand, productName, category, notes, thumbnail, submittedBy } = body;
  // images: [{ base64, mimeType }]
  // thumbnail: 客户端已压缩的小图 base64（data URI 完整字符串），仅用于资源库预览
  if (!images || images.length === 0) {
    return json({ error: "缺少图片" }, 400);
  }

  const content = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mimeType, data: img.base64 },
  }));
  content.push({
    type: "text",
    text: `品牌：${brand || "未填写"}；产品名：${productName || "未填写"}；品类：${category || "未填写"}；备注：${notes || "无"}`,
  });

  const resultText = await callClaude(env, {
    system: COMPETITOR_SCHEMA_PROMPT,
    messages: [{ role: "user", content }],
    maxTokens: 1500,
  });

  let analysis;
  try {
    analysis = extractJson(resultText);
  } catch (e) {
    return json({ error: "模型输出解析失败", raw: resultText }, 500);
  }

  const id = uuid();
  const record = {
    id,
    type: "competitor",
    brand: brand || "",
    productName: productName || "",
    category: category || "",
    notes: notes || "",
    submittedBy: submittedBy || "",
    thumbnail: thumbnail || "",
    analysis,
    createdAt: new Date().toISOString(),
  };
  await env.LIBRARY_KV.put(`competitor:${id}`, JSON.stringify(record));
  return json({ ok: true, record });
}

async function handleSaveProduct(request, env) {
  const body = await request.json();
  const { productName, category, material, fit, craft, scene, sellingPoints, notes, submittedBy } = body;
  const id = uuid();
  const record = {
    id,
    type: "product",
    productName: productName || "",
    category: category || "",
    material: material || "",
    fit: fit || "",
    craft: craft || "",
    scene: scene || "",
    sellingPoints: sellingPoints || [],
    notes: notes || "",
    submittedBy: submittedBy || "",
    createdAt: new Date().toISOString(),
  };
  await env.LIBRARY_KV.put(`product:${id}`, JSON.stringify(record));
  return json({ ok: true, record });
}

async function handleListLibrary(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "competitor";
  const list = await env.LIBRARY_KV.list({ prefix: `${type}:` });
  const records = await Promise.all(
    list.keys.map(async (k) => {
      const val = await env.LIBRARY_KV.get(k.name);
      return val ? JSON.parse(val) : null;
    })
  );
  return json({ ok: true, records: records.filter(Boolean) });
}

async function handleDeleteItem(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const id = url.searchParams.get("id");
  if (!type || !id) return json({ error: "缺少参数" }, 400);
  await env.LIBRARY_KV.delete(`${type}:${id}`);
  return json({ ok: true });
}

async function handleBulkImport(request, env) {
  const body = await request.json();
  const { records } = body;
  if (!records || !Array.isArray(records) || records.length === 0) {
    return json({ error: "缺少 records 数组" }, 400);
  }
  let count = 0;
  for (const r of records) {
    const id = r.id || uuid();
    const type = r.type === "product" ? "product" : "competitor";
    const record = { ...r, id, type, createdAt: r.createdAt || new Date().toISOString() };
    await env.LIBRARY_KV.put(`${type}:${id}`, JSON.stringify(record));
    count++;
  }
  return json({ ok: true, imported: count });
}

async function handleGenerate(request, env) {
  const { productId, brief } = await request.json();

  const productRaw = await env.LIBRARY_KV.get(`product:${productId}`);
  if (!productRaw) return json({ error: "产品未找到" }, 404);
  const product = JSON.parse(productRaw);

  const compList = await env.LIBRARY_KV.list({ prefix: "competitor:" });
  const competitors = (
    await Promise.all(
      compList.keys.map(async (k) => {
        const v = await env.LIBRARY_KV.get(k.name);
        return v ? JSON.parse(v) : null;
      })
    )
  ).filter(Boolean);

  if (competitors.length === 0) {
    return json({ error: "资源库里还没有竞品分析数据，请先上传竞品图片" }, 400);
  }

  // 第一步：用 Claude 做语义相关性排序，代替向量检索
  const summaries = competitors.map((c) => ({
    id: c.id,
    brand: c.brand,
    productName: c.productName,
    category: c.category,
    analysis_summary: {
      风格定位: c.analysis?.风格定位,
      卖点角度: c.analysis?.卖点角度,
      语气风格: c.analysis?.语气风格,
    },
  }));

  const rankText = await callClaude(env, {
    system: `你是文案框架检索助手。给你一份产品简介和一批竞品摘要，请按"文案框架参考价值"从高到低排序，返回最相关的最多5个竞品的 id 数组，格式：{"ids": ["id1","id2",...]}，只输出 JSON。`,
    messages: [
      {
        role: "user",
        content: `产品简介：${JSON.stringify(product)}\n\n附加说明：${brief || "无"}\n\n竞品摘要列表：${JSON.stringify(summaries)}`,
      },
    ],
    maxTokens: 500,
  });

  let selectedIds = [];
  try {
    selectedIds = extractJson(rankText).ids || [];
  } catch (e) {
    selectedIds = competitors.slice(0, 3).map((c) => c.id);
  }

  const selected = competitors.filter((c) => selectedIds.includes(c.id));
  const finalSelected = selected.length > 0 ? selected : competitors.slice(0, 3);

  // 第二步：套框架生成文案
  const genText = await callClaude(env, {
    system: `你是电商文案策划。请参考给定的竞品文案框架结构（仅结构，不是原文），结合我方产品信息，原创生成文案。输出严格按以下 JSON 格式，不要输出其他内容：
{
  "主图文案候选": ["", "", ""],
  "详情页文案框架": [{"模块": "", "文案方向": ""}],
  "信息缺口提示": ""
}
主图文案每条不超过15字。详情页文案框架给方向和大纲，不用写成品文案。如果我方产品信息中缺少某个竞品常用的卖点角度，在"信息缺口提示"里说明。`,
    messages: [
      {
        role: "user",
        content: `【竞品框架参考】\n${JSON.stringify(finalSelected.map((c) => c.analysis))}\n\n【我方产品信息】\n${JSON.stringify(product)}\n\n【附加要求】\n${brief || "无"}`,
      },
    ],
    maxTokens: 2000,
  });

  let generated;
  try {
    generated = extractJson(genText);
  } catch (e) {
    return json({ error: "生成结果解析失败", raw: genText }, 500);
  }

  return json({ ok: true, generated, referencedCompetitors: finalSelected.map((c) => ({ id: c.id, brand: c.brand, productName: c.productName })) });
}

// ---------- 主入口 ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      if (!checkPasscode(request, env)) {
        return json({ error: "未授权，请重新登录" }, 401);
      }
      if (url.pathname === "/api/analyze-competitor" && request.method === "POST") {
        return handleAnalyzeCompetitor(request, env);
      }
      if (url.pathname === "/api/save-product" && request.method === "POST") {
        return handleSaveProduct(request, env);
      }
      if (url.pathname === "/api/library" && request.method === "GET") {
        return handleListLibrary(request, env);
      }
      if (url.pathname === "/api/item" && request.method === "DELETE") {
        return handleDeleteItem(request, env);
      }
      if (url.pathname === "/api/generate" && request.method === "POST") {
        return handleGenerate(request, env);
      }
      if (url.pathname === "/api/bulk-import" && request.method === "POST") {
        return handleBulkImport(request, env);
      }
      return json({ error: "接口不存在" }, 404);
    }

    // 静态资源交给 assets
    return env.ASSETS.fetch(request);
  },
};
