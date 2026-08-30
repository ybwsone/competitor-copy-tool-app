// ===================== 竞品文案分析工具 - Cloudflare Worker 后端 =====================
// 功能：团队口令校验 / 竞品图片分析 / 产品资料存储 / 检索匹配 / 一键生成文案

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_VISION_MODELS = ["deepseek-v4-flash-vision-exp"];
const DEEPSEEK_TEXT_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

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
  "文化叙事引用": "",
  "主图部分": {
    "核心钩子": "",
    "文案结构": [],
    "视觉重点": []
  },
  "详情页部分": [
    {"模块": "", "作用": "", "文案策略": "", "画面内容": ""}
  ]
}

要求：
1. 只分析文案的结构、角度、语气、逻辑，绝对不要逐字复述原文文案内容
2. 如果某字段无法判断，填空字符串或空数组，不要编造
3. "叙述结构"按图片从上到下的模块顺序描述
4. "主图部分"总结首屏/主图的钩子、文案层级和视觉重点
5. "详情页部分"必须按消费者从上到下的浏览顺序拆分模块；只分析结构和策略，不复述原文
6. 只输出 JSON，不要有任何前后缀说明文字`;

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

async function callDeepSeek(env, { system, parts, maxTokens = 2000, vision = false, models: requestedModels }) {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error("Cloudflare 尚未配置 DEEPSEEK_API_KEY");
  }

  const content = parts.map((part) => {
    if (part.inline_data) {
      return {
        type: "image_url",
        image_url: {
          url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`,
        },
      };
    }
    return { type: "text", text: part.text || "" };
  });
  const models = requestedModels || (vision ? DEEPSEEK_VISION_MODELS : DEEPSEEK_TEXT_MODELS);

  let lastError = "";
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await fetch(DEEPSEEK_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content },
          ],
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          max_tokens: maxTokens,
          temperature: 0.2,
        }),
      });

      if (resp.ok) {
        const data = await resp.json();
        const output = data.choices?.[0]?.message?.content?.trim() || "";
        const finishReason = data.choices?.[0]?.finish_reason || "";
        if (output && finishReason !== "length") return output;
        lastError = `${model} 返回空内容或输出被截断（finish_reason=${finishReason || "unknown"}）`;
      } else {
        const text = await resp.text();
        lastError = `${model} error ${resp.status}: ${text}`;
        if (!RETRYABLE_STATUS.has(resp.status)) {
          throw new Error(`DeepSeek API ${lastError}`);
        }
      }

      if (attempt === 0) {
        const delayMs = 800 + Math.floor(Math.random() * 400);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error("DeepSeek 暂时无法完成请求，已自动重试；最后一次错误：" + lastError);
}

function extractJson(text) {
  const cleaned = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw firstError;
  }
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

  const parts = images.map((img) => ({
    inline_data: { mime_type: img.mimeType, data: img.base64 },
  }));
  parts.push({
    text: `品牌：${brand || "未填写"}；产品名：${productName || "未填写"}；品类：${category || "未填写"}；备注：${notes || "无"}`,
  });

  const resultText = await callDeepSeek(env, {
    system: COMPETITOR_SCHEMA_PROMPT,
    parts,
    maxTokens: 3000,
    vision: true,
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
  const { productName, category, material, fit, craft, scene, sellingPoints, notes, submittedBy, images, thumbnail } = body;
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
    images: Array.isArray(images) ? images.slice(0, 5) : [],
    thumbnail: thumbnail || "",
    createdAt: new Date().toISOString(),
  };
  await env.LIBRARY_KV.put(`product:${id}`, JSON.stringify(record));
  return json({ ok: true, record });
}

async function handleListLibrary(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "competitor";
  const wantDeleted = url.searchParams.get("deleted") === "true";
  const list = await env.LIBRARY_KV.list({ prefix: `${type}:` });
  const records = await Promise.all(
    list.keys.map(async (k) => {
      const val = await env.LIBRARY_KV.get(k.name);
      return val ? JSON.parse(val) : null;
    })
  );
  const filtered = records.filter(Boolean).filter((r) => Boolean(r.deleted) === wantDeleted);
  return json({ ok: true, records: filtered });
}

async function handleDeleteItem(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const id = url.searchParams.get("id");
  const permanent = url.searchParams.get("permanent") === "true";
  if (!type || !id) return json({ error: "缺少参数" }, 400);
  const key = `${type}:${id}`;
  if (permanent) {
    await env.LIBRARY_KV.delete(key);
    return json({ ok: true, permanent: true });
  }
  const existingRaw = await env.LIBRARY_KV.get(key);
  if (!existingRaw) return json({ error: "记录不存在" }, 404);
  const existing = JSON.parse(existingRaw);
  existing.deleted = true;
  existing.deletedAt = new Date().toISOString();
  await env.LIBRARY_KV.put(key, JSON.stringify(existing));
  return json({ ok: true, permanent: false });
}

async function handleUpdateItem(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const id = url.searchParams.get("id");
  if (!type || !id) return json({ error: "缺少参数" }, 400);
  const key = `${type}:${id}`;
  const existingRaw = await env.LIBRARY_KV.get(key);
  if (!existingRaw) return json({ error: "记录不存在" }, 404);
  const existing = JSON.parse(existingRaw);
  const updates = await request.json();
  const updated = { ...existing, ...updates, id, type, updatedAt: new Date().toISOString() };
  await env.LIBRARY_KV.put(key, JSON.stringify(updated));
  return json({ ok: true, record: updated });
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
  const { productId, tone, brief } = await request.json();

  const productRaw = await env.LIBRARY_KV.get(`product:${productId}`);
  if (!productRaw) return json({ error: "产品未找到" }, 404);
  const product = JSON.parse(productRaw);
  const productImages = Array.isArray(product.images) ? product.images.slice(0, 5) : [];
  const { images: _images, thumbnail: _thumbnail, ...productText } = product;

  const compList = await env.LIBRARY_KV.list({ prefix: "competitor:" });
  const competitors = (
    await Promise.all(
      compList.keys.map(async (k) => {
        const v = await env.LIBRARY_KV.get(k.name);
        return v ? JSON.parse(v) : null;
      })
    )
  ).filter((c) => c && !c.deleted);

  if (competitors.length === 0) {
    return json({ error: "资源库里还没有竞品分析数据，请先上传竞品图片" }, 400);
  }

  // 第一步：用 DeepSeek 做语义相关性排序，代替向量检索
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

  const rankText = await callDeepSeek(env, {
    system: `你是文案框架检索助手。给你一份产品简介和一批竞品摘要，请按"文案框架参考价值"从高到低排序，返回最相关的最多5个竞品的 id 数组，格式：{"ids": ["id1","id2",...]}，只输出 JSON。`,
    parts: [
      {
        text: `产品简介：${JSON.stringify(productText)}\n\n附加说明：${brief || "无"}\n\n竞品摘要列表：${JSON.stringify(summaries)}`,
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

  // 先用视觉模型提炼产品自身的视觉语言，再交给更强的文字模型写成品文案。
  let visualDirection = {};
  if (productImages.length > 0) {
    try {
      const visualText = await callDeepSeek(env, {
        system: `你是品牌视觉策略师。请只根据产品图片和已提供的产品事实，提炼可用于电商文案创作的视觉调性。输出 JSON：
{
  "视觉气质": "",
  "核心意象": [],
  "色彩材质感受": [],
  "适合的语言质感": "",
  "不适合的表达": []
}
不得猜测图片中无法确认的材质、工艺、功效、数据或品牌历史。`,
        parts: [
          ...productImages.map((img) => ({
            inline_data: { mime_type: img.mimeType || "image/jpeg", data: img.base64 },
          })),
          { text: `产品事实：${JSON.stringify(productText)}` },
        ],
        maxTokens: 1200,
        vision: true,
      });
      visualDirection = extractJson(visualText);
    } catch (e) {
      visualDirection = {};
    }
  }

  // 第二步：套框架生成文案
  const genText = await callDeepSeek(env, {
    system: `你是资深品牌文案总监，不是商品信息改写器。请先统一品牌调性和核心意象，再参考竞品的结构方法（绝不照搬原文），为产品写出可以直接交给设计师排版的主图和详情页完整文案。

输出严格按以下 JSON 格式，不要输出其他内容：
{
  "调性策略": {
    "一句话定位": "",
    "核心意象": [],
    "语言质感": "",
    "语言节奏": "",
    "避免表达": []
  },
  "主图文案候选": ["", "", ""],
  "详情页完整文案": [{"模块": "", "标题": "", "正文": "", "画面建议": ""}],
  "信息缺口提示": ""
}
要求：
1. 主图文案每条不超过15字，要有同一品牌气质，但角度不能重复；避免把材质、工艺、意象机械堆在一句里。
2. 详情页按消费者浏览顺序输出6至10个模块。模块名是功能标签，标题必须是成品文案，两者不得重复；正文要有具体感受、场景或动作，不写空泛结论。
3. 全篇只选择一组统一的核心意象并贯穿，不要在雪境、都市、精灵、宫廷等互不相关的意象之间跳跃。
4. 禁止滥用“温暖纯粹、精致优雅、尽显奢华、匠心打造、品质之选、邂逅美好”等通用AI套话；除非能结合产品事实写出具体内容。
5. 只能使用我方产品信息中明确提供的事实。不得编造模特身高体重尺码、成分比例、功效、检测数据、销量、认证、品牌历史或产地。
6. 如果信息不足，不要补造卖点，在"信息缺口提示"里明确说明还需要补充什么。
7. 句式要有长短变化和呼吸感，避免每段都是“名词+四字形容词”的同一模板。`,
    parts: [
      {
        text: `【指定调性】\n${tone || "自动判断"}\n\n【产品视觉策略】\n${JSON.stringify(visualDirection)}\n\n【竞品框架参考】\n${JSON.stringify(finalSelected.map((c) => c.analysis))}\n\n【我方产品事实】\n${JSON.stringify(productText)}\n\n【补充要求】\n${brief || "无"}`,
      },
    ],
    maxTokens: 5000,
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
  });

  let generated;
  try {
    generated = extractJson(genText);
  } catch (e) {
    return json({ error: "生成结果解析失败", raw: genText }, 500);
  }

  const referencedCompetitors = finalSelected.map((c) => ({ id: c.id, brand: c.brand, productName: c.productName }));
  const generationRecord = {
    id: uuid(),
    type: "generation",
    productId: product.id,
    productName: product.productName || "",
    category: product.category || "",
    tone: tone || "自动判断",
    brief: brief || "",
    generated,
    referencedCompetitors,
    createdAt: new Date().toISOString(),
  };
  await env.LIBRARY_KV.put(`generation:${generationRecord.id}`, JSON.stringify(generationRecord));

  return json({ ok: true, generated, referencedCompetitors, recordId: generationRecord.id });
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
      try {
        if (url.pathname === "/api/analyze-competitor" && request.method === "POST") {
          return await handleAnalyzeCompetitor(request, env);
        }
        if (url.pathname === "/api/save-product" && request.method === "POST") {
          return await handleSaveProduct(request, env);
        }
        if (url.pathname === "/api/library" && request.method === "GET") {
          return await handleListLibrary(request, env);
        }
        if (url.pathname === "/api/item" && request.method === "DELETE") {
          return await handleDeleteItem(request, env);
        }
        if (url.pathname === "/api/item" && request.method === "PUT") {
          return await handleUpdateItem(request, env);
        }
        if (url.pathname === "/api/generate" && request.method === "POST") {
          return await handleGenerate(request, env);
        }
        if (url.pathname === "/api/bulk-import" && request.method === "POST") {
          return await handleBulkImport(request, env);
        }
        return json({ error: "接口不存在" }, 404);
      } catch (err) {
        // 统一兜底：任何未预料的报错都以 JSON 形式返回真实错误信息，
        // 避免前端看到 Cloudflare 自己的 HTML/纯文本错误页导致"看不懂的500"
        return json({ error: `服务器处理出错：${err.message || String(err)}` }, 500);
      }
    }

    // 静态资源交给 assets
    return env.ASSETS.fetch(request);
  },
};
