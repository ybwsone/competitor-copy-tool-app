const state = {
  passcode: localStorage.getItem("team_passcode") || "",
};

function authHeaders() {
  return { "x-team-passcode": state.passcode };
}

async function api(path, options = {}) {
  const resp = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "请求失败");
  return data;
}

// ---------- 登录 ----------
async function handleLogin() {
  const passcode = document.getElementById("passcode-input").value.trim();
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  try {
    const resp = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    const data = await resp.json();
    if (data.ok) {
      state.passcode = passcode;
      localStorage.setItem("team_passcode", passcode);
      showMain();
    } else {
      errEl.textContent = data.error || "口令错误";
    }
  } catch (e) {
    errEl.textContent = "登录失败：" + e.message;
  }
}

function showMain() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("main-screen").classList.remove("hidden");
  loadCompetitors();
  loadProducts();
}

// ---------- Tab 切换 ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "generate") populateProductSelect();
  });
});

// ---------- 竞品分析 ----------
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 生成一张压缩后的小缩略图（宽度最多240px，jpeg 60%质量），仅用于资源库列表预览
// 目的是避免把原图存进 KV 导致数据量过大，同时又能让团队回头对照原图
function fileToThumbnail(file, maxWidth = 240) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.6));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleAnalyzeCompetitor() {
  const brand = document.getElementById("comp-brand").value.trim();
  const productName = document.getElementById("comp-product").value.trim();
  const category = document.getElementById("comp-category").value.trim();
  const notes = document.getElementById("comp-notes").value.trim();
  const submittedBy = document.getElementById("comp-submitter").value.trim();
  const files = document.getElementById("comp-images").files;
  const statusEl = document.getElementById("comp-status");

  if (!files || files.length === 0) {
    statusEl.textContent = "请先选择图片";
    statusEl.className = "status error-text";
    return;
  }

  statusEl.textContent = "分析中，可能需要 10-30 秒...";
  statusEl.className = "status";

  try {
    const fileList = Array.from(files).slice(0, 5);
    const images = await Promise.all(
      fileList.map(async (f) => ({ base64: await fileToBase64(f), mimeType: f.type }))
    );
    const thumbnail = await fileToThumbnail(fileList[0]);
    const data = await api("/api/analyze-competitor", {
      method: "POST",
      body: JSON.stringify({ images, brand, productName, category, notes, submittedBy, thumbnail }),
    });
    statusEl.textContent = "分析完成";
    statusEl.className = "status success-text";
    loadCompetitors();
  } catch (e) {
    statusEl.textContent = "分析失败：" + e.message;
    statusEl.className = "status error-text";
  }
}

async function loadCompetitors() {
  try {
    const data = await api("/api/library?type=competitor");
    const list = document.getElementById("comp-list");
    document.getElementById("comp-count").textContent = `(${data.records.length})`;
    state.competitors = data.records;
    list.innerHTML = data.records
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(
        (r) => `
      <div class="item-card">
        <div class="item-card-body">
          ${r.thumbnail ? `<img class="item-thumb" src="${r.thumbnail}" alt="竞品缩略图" />` : `<div class="item-thumb-placeholder"></div>`}
          <div style="flex:1">
            <div class="item-title">${r.brand || "未知品牌"} · ${r.productName || "未命名"}</div>
            <div class="item-meta">${r.category || ""} · ${r.submittedBy ? "提交人：" + r.submittedBy + " · " : ""}${new Date(r.createdAt).toLocaleString()}</div>
            <div>语气：${r.analysis?.语气风格 || "-"}</div>
            <div class="item-tags">
              ${(r.analysis?.卖点角度 || []).map((t) => `<span class="tag">${t}</span>`).join("")}
            </div>
          </div>
        </div>
        <button class="del-btn" onclick="deleteItem('competitor','${r.id}')">删除</button>
      </div>`
      )
      .join("");
  } catch (e) {
    console.error(e);
  }
}

// ---------- 导出资源库为 Markdown ----------
function downloadMarkdown(filename, content) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportCompetitors() {
  const data = await api("/api/library?type=competitor");
  const lines = ["# 竞品文案框架资源库", ""];
  data.records
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .forEach((r) => {
      lines.push(`## ${r.brand || "未知品牌"} · ${r.productName || "未命名"}`);
      lines.push("");
      lines.push(`- 品类：${r.category || "-"}`);
      lines.push(`- 提交人：${r.submittedBy || "-"}`);
      lines.push(`- 录入时间：${new Date(r.createdAt).toLocaleString()}`);
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(r.analysis, null, 2));
      lines.push("```");
      lines.push("");
    });
  downloadMarkdown("竞品文案框架资源库.md", lines.join("\n"));
}

async function exportProducts() {
  const data = await api("/api/library?type=product");
  const lines = ["# 我方产品资料库", ""];
  data.records
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .forEach((r) => {
      lines.push(`## ${r.productName}`);
      lines.push("");
      lines.push(`- 品类：${r.category || "-"}`);
      lines.push(`- 面料/材质：${r.material || "-"}`);
      lines.push(`- 版型特点：${r.fit || "-"}`);
      lines.push(`- 工艺细节：${r.craft || "-"}`);
      lines.push(`- 适合场景：${r.scene || "-"}`);
      lines.push(`- 核心卖点：${(r.sellingPoints || []).join("、") || "-"}`);
      lines.push(`- 提交人：${r.submittedBy || "-"}`);
      lines.push("");
    });
  downloadMarkdown("我方产品资料库.md", lines.join("\n"));
}

// ---------- 我方产品 ----------
async function handleSaveProduct() {
  const productName = document.getElementById("prod-name").value.trim();
  const category = document.getElementById("prod-category").value.trim();
  const material = document.getElementById("prod-material").value.trim();
  const fit = document.getElementById("prod-fit").value.trim();
  const craft = document.getElementById("prod-craft").value.trim();
  const scene = document.getElementById("prod-scene").value.trim();
  const sellingPoints = document
    .getElementById("prod-selling")
    .value.split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const notes = document.getElementById("prod-notes").value.trim();
  const submittedBy = document.getElementById("prod-submitter").value.trim();
  const statusEl = document.getElementById("prod-status");

  if (!productName) {
    statusEl.textContent = "请填写产品名";
    statusEl.className = "status error-text";
    return;
  }

  try {
    await api("/api/save-product", {
      method: "POST",
      body: JSON.stringify({ productName, category, material, fit, craft, scene, sellingPoints, notes, submittedBy }),
    });
    statusEl.textContent = "保存成功";
    statusEl.className = "status success-text";
    loadProducts();
  } catch (e) {
    statusEl.textContent = "保存失败：" + e.message;
    statusEl.className = "status error-text";
  }
}

async function loadProducts() {
  try {
    const data = await api("/api/library?type=product");
    const list = document.getElementById("prod-list");
    document.getElementById("prod-count").textContent = `(${data.records.length})`;
    list.innerHTML = data.records
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(
        (r) => `
      <div class="item-card">
        <div class="item-title">${r.productName}</div>
        <div class="item-meta">${r.category || ""} · ${r.submittedBy ? "提交人：" + r.submittedBy + " · " : ""}${new Date(r.createdAt).toLocaleString()}</div>
        <div class="item-tags">${(r.sellingPoints || []).map((t) => `<span class="tag">${t}</span>`).join("")}</div>
        <button class="del-btn" onclick="deleteItem('product','${r.id}')">删除</button>
      </div>`
      )
      .join("");
  } catch (e) {
    console.error(e);
  }
}

// ---------- 删除 ----------
async function deleteItem(type, id) {
  if (!confirm("确认删除？")) return;
  await api(`/api/item?type=${type}&id=${id}`, { method: "DELETE" });
  if (type === "competitor") loadCompetitors();
  else loadProducts();
}
window.deleteItem = deleteItem;

// ---------- 一键生成 ----------
async function populateProductSelect() {
  const data = await api("/api/library?type=product");
  const sel = document.getElementById("gen-product-select");
  sel.innerHTML = data.records
    .map((r) => `<option value="${r.id}">${r.productName}（${r.category || "未分类"}）</option>`)
    .join("");
}

async function handleGenerate() {
  const productId = document.getElementById("gen-product-select").value;
  const brief = document.getElementById("gen-brief").value.trim();
  const statusEl = document.getElementById("gen-status");
  const resultEl = document.getElementById("gen-result");

  if (!productId) {
    statusEl.textContent = "请先在「我方产品库」录入产品";
    statusEl.className = "status error-text";
    return;
  }

  statusEl.textContent = "生成中，可能需要 10-20 秒...";
  statusEl.className = "status";
  resultEl.classList.add("hidden");

  try {
    const data = await api("/api/generate", {
      method: "POST",
      body: JSON.stringify({ productId, brief }),
    });
    statusEl.textContent = "生成完成";
    statusEl.className = "status success-text";
    renderResult(data);
  } catch (e) {
    statusEl.textContent = "生成失败：" + e.message;
    statusEl.className = "status error-text";
  }
}

let lastGenData = null;

function genResultToText(data) {
  const g = data.generated;
  const lines = ["# 生成文案框架", "", "## 主图文案候选"];
  (g.主图文案候选 || []).forEach((t) => lines.push(`- ${t}`));
  lines.push("", "## 详情页文案框架");
  (g.详情页文案框架 || []).forEach((m) => lines.push(`- ${m.模块}：${m.文案方向}`));
  if (g.信息缺口提示) lines.push("", `信息缺口提示：${g.信息缺口提示}`);
  lines.push("", `参考框架来自：${(data.referencedCompetitors || []).map((c) => `${c.brand}·${c.productName}`).join("、")}`);
  return lines.join("\n");
}

function renderResult(data) {
  lastGenData = data;
  const el = document.getElementById("gen-result");
  const g = data.generated;
  el.innerHTML = `
    <h3>主图文案候选</h3>
    <ul>${(g.主图文案候选 || []).map((t) => `<li>${t}</li>`).join("")}</ul>
    <h3>详情页文案框架</h3>
    ${(g.详情页文案框架 || [])
      .map(
        (m) => `<div class="module-item"><div class="module-name">${m.模块}</div><div class="module-dir">${m.文案方向}</div></div>`
      )
      .join("")}
    ${g.信息缺口提示 ? `<div class="gap-note">⚠ ${g.信息缺口提示}</div>` : ""}
    <div class="ref-list">参考框架来自：${(data.referencedCompetitors || []).map((c) => `${c.brand}·${c.productName}`).join("、")}</div>
    <div class="result-actions">
      <button onclick="copyGenResult()">复制文案</button>
      <button onclick="downloadGenResult()">导出为 Markdown</button>
    </div>
  `;
  el.classList.remove("hidden");
}

async function copyGenResult() {
  if (!lastGenData) return;
  try {
    await navigator.clipboard.writeText(genResultToText(lastGenData));
    document.getElementById("gen-status").textContent = "已复制到剪贴板";
    document.getElementById("gen-status").className = "status success-text";
  } catch (e) {
    document.getElementById("gen-status").textContent = "复制失败，请手动选中文字复制";
    document.getElementById("gen-status").className = "status error-text";
  }
}
window.copyGenResult = copyGenResult;

function downloadGenResult() {
  if (!lastGenData) return;
  downloadMarkdown("生成文案框架.md", genResultToText(lastGenData));
}
window.downloadGenResult = downloadGenResult;

// ---------- 事件绑定 ----------
document.getElementById("login-btn").addEventListener("click", handleLogin);
document.getElementById("passcode-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleLogin();
});
document.getElementById("comp-analyze-btn").addEventListener("click", handleAnalyzeCompetitor);
document.getElementById("prod-save-btn").addEventListener("click", handleSaveProduct);
document.getElementById("gen-btn").addEventListener("click", handleGenerate);
document.getElementById("comp-export-btn").addEventListener("click", exportCompetitors);
document.getElementById("prod-export-btn").addEventListener("click", exportProducts);

// 自动登录（如果本地已存过口令，尝试直接进入，失败则显示登录页）
if (state.passcode) {
  fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode: state.passcode }),
  })
    .then((r) => r.json())
    .then((d) => {
      if (d.ok) showMain();
    });
}
