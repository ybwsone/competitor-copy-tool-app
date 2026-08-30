const state = {
  passcode: localStorage.getItem("team_passcode") || "",
  competitors: [],
  products: [],
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
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(
      resp.ok
        ? "服务器返回了非预期格式的内容"
        : `请求失败（状态码 ${resp.status}），如果是上传图片，可能是图片体积过大，建议先分段截图后再上传`
    );
  }
  if (!resp.ok) throw new Error(data.error || "请求失败");
  return data;
}

// ---------- 拖拽上传 ----------
function attachDropzone(dropzoneEl, inputEl) {
  ["dragenter", "dragover"].forEach((evt) =>
    dropzoneEl.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzoneEl.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzoneEl.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzoneEl.classList.remove("dragover");
    })
  );
  dropzoneEl.addEventListener("drop", (e) => {
    const dt = new DataTransfer();
    Array.from(e.dataTransfer.files).forEach((f) => dt.items.add(f));
    inputEl.files = dt.files;
  });
}
attachDropzone(document.getElementById("comp-images-dropzone"), document.getElementById("comp-images"));
attachDropzone(document.getElementById("bulk-import-dropzone"), document.getElementById("bulk-import-file"));

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
    if (btn.dataset.tab === "competitor") loadCompetitors();
    if (btn.dataset.tab === "product") loadProducts();
    if (btn.dataset.tab === "trash") loadTrash();
  });
});

// 上传前统一压缩：把最长边限制在 6000px 以内，转成 jpeg，避免超大截图导致请求失败
// （淘宝详情页长图常有几万像素高，直接原图上传很容易超出请求体积限制或模型的图片尺寸限制）
function resizeImageForAnalysis(file, maxDim = 6000, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve({ base64: dataUrl.split(",")[1], mimeType: "image/jpeg" });
      };
      img.onerror = () => reject(new Error("图片解析失败，文件可能已损坏"));
      img.src = reader.result;
    };
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
  if (files.length > 3) {
    statusEl.textContent = `你选了 ${files.length} 张，单次最多分析 3 张，将只使用前 3 张（其余可以再分批上传）`;
    statusEl.className = "status";
  }

  statusEl.textContent = "分析中，可能需要 10-30 秒...";
  statusEl.className = "status";

  try {
    const fileList = Array.from(files).slice(0, 3);
    const images = await Promise.all(fileList.map((f) => resizeImageForAnalysis(f)));
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

const uiState = { expanded: {}, editing: {} };

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadCompetitors() {
  try {
    const data = await api("/api/library?type=competitor");
    state.competitors = data.records;
    renderCompetitorList();
  } catch (e) {
    console.error(e);
  }
}

function renderCompetitorList() {
  const list = document.getElementById("comp-list");
  document.getElementById("comp-count").textContent = `(${state.competitors.length})`;
  list.innerHTML = state.competitors
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((r) => renderCompetitorCard(r))
    .join("");
}

function renderCompetitorCard(r) {
  const isEditing = uiState.editing.competitor === r.id;
  const isExpanded = uiState.expanded.competitor === r.id;
  const a = r.analysis || {};

  if (isEditing) {
    return `
      <div class="item-card">
        <label>品牌</label><input id="edit-comp-brand-${r.id}" value="${escapeHtml(r.brand)}" />
        <label>产品名</label><input id="edit-comp-product-${r.id}" value="${escapeHtml(r.productName)}" />
        <label>品类</label><input id="edit-comp-category-${r.id}" value="${escapeHtml(r.category)}" />
        <label>分析结果（JSON，可直接改字段值）</label>
        <textarea id="edit-comp-analysis-${r.id}" rows="14" style="width:100%;font-family:monospace;font-size:12px;padding:8px;border:1px solid #ddd;border-radius:6px">${escapeHtml(JSON.stringify(a, null, 2))}</textarea>
        <div class="result-actions" style="margin-top:10px">
          <button onclick="saveCompetitorEdit('${r.id}')">保存</button>
          <button onclick="cancelEdit('competitor')" style="background:transparent;color:#666;border:1px solid #ddd">取消</button>
        </div>
      </div>`;
  }

  const detailHtml = isExpanded
    ? `
      <div style="margin-top:10px;font-size:12px;color:#555;border-top:1px solid #eee;padding-top:10px">
        <div><b>风格定位：</b>${a.风格定位 || "-"}</div>
        <div><b>开头钩子类型：</b>${a.开头钩子类型 || "-"}</div>
        <div><b>痛点类型：</b>${(a.痛点类型 || []).join("、") || "-"}</div>
        <div style="margin-top:8px"><b>主图部分：</b></div>
        <ul style="margin:4px 0;padding-left:18px">
          <li>核心钩子：${a.主图部分?.核心钩子 || "-"}</li>
          <li>文案结构：${(a.主图部分?.文案结构 || []).join(" → ") || "-"}</li>
          <li>视觉重点：${(a.主图部分?.视觉重点 || []).join("、") || "-"}</li>
        </ul>
        <div style="margin-top:8px"><b>详情页部分：</b></div>
        <div>
          ${(a.详情页部分 || [])
            .map(
              (m) => `<div class="module-item">
                <div class="module-name">${m.模块 || "详情模块"}</div>
                <div class="module-dir">作用：${m.作用 || "-"}</div>
                <div class="module-dir">文案策略：${m.文案策略 || "-"}</div>
                <div class="module-dir">画面内容：${m.画面内容 || "-"}</div>
              </div>`
            )
            .join("") || "-"}
        </div>
        <div style="margin-top:6px"><b>叙述结构：</b></div>
        <ul style="margin:4px 0;padding-left:18px">
          ${(a.叙述结构 || []).map((m) => `<li>${m.模块}：${m.作用}</li>`).join("") || "<li>-</li>"}
        </ul>
        <div><b>图片展示顺序：</b>${(a.图片展示顺序 || []).join(" → ") || "-"}</div>
        <div><b>信任背书方式：</b>${(a.信任背书方式 || []).join("、") || "-"}</div>
        <div><b>促单话术类型：</b>${a.促单话术类型 || "-"}</div>
        <div><b>文化叙事引用：</b>${a.文化叙事引用 || "-"}</div>
        ${r.notes ? `<div><b>备注：</b>${r.notes}</div>` : ""}
      </div>`
    : "";

  return `
    <div class="item-card">
      <div class="item-card-body" style="cursor:pointer" onclick="toggleExpand('competitor','${r.id}')">
        ${r.thumbnail ? `<img class="item-thumb" src="${r.thumbnail}" alt="竞品缩略图" />` : `<div class="item-thumb-placeholder"></div>`}
        <div style="flex:1">
          <div class="item-title">${r.brand || "未知品牌"} · ${r.productName || "未命名"}</div>
          <div class="item-meta">${r.category || ""} · ${r.submittedBy ? "提交人：" + r.submittedBy + " · " : ""}${new Date(r.createdAt).toLocaleString()}</div>
          <div>语气：${a.语气风格 || "-"}</div>
          <div class="item-tags">${(a.卖点角度 || []).map((t) => `<span class="tag">${t}</span>`).join("")}</div>
        </div>
      </div>
      ${detailHtml}
      <div class="result-actions" style="margin-top:8px">
        <button onclick="toggleExpand('competitor','${r.id}')" class="ghost-btn">${isExpanded ? "收起" : "展开详情"}</button>
        <button onclick="startEditCompetitor('${r.id}')" class="ghost-btn">编辑</button>
        <button class="del-btn" onclick="deleteItem('competitor','${r.id}')">删除</button>
      </div>
    </div>`;
}

function toggleExpand(type, id) {
  uiState.expanded[type] = uiState.expanded[type] === id ? null : id;
  if (type === "competitor") renderCompetitorList();
  else renderProductList();
}
window.toggleExpand = toggleExpand;

function startEditCompetitor(id) {
  uiState.editing.competitor = id;
  renderCompetitorList();
}
window.startEditCompetitor = startEditCompetitor;

function cancelEdit(type) {
  uiState.editing[type] = null;
  if (type === "competitor") renderCompetitorList();
  else renderProductList();
}
window.cancelEdit = cancelEdit;

async function saveCompetitorEdit(id) {
  const brand = document.getElementById(`edit-comp-brand-${id}`).value.trim();
  const productName = document.getElementById(`edit-comp-product-${id}`).value.trim();
  const category = document.getElementById(`edit-comp-category-${id}`).value.trim();
  const analysisText = document.getElementById(`edit-comp-analysis-${id}`).value;
  let analysis;
  try {
    analysis = JSON.parse(analysisText);
  } catch (e) {
    alert("分析结果不是合法的 JSON，请检查格式后再保存");
    return;
  }
  try {
    await api(`/api/item?type=competitor&id=${id}`, {
      method: "PUT",
      body: JSON.stringify({ brand, productName, category, analysis }),
    });
    uiState.editing.competitor = null;
    loadCompetitors();
  } catch (e) {
    alert("保存失败：" + e.message);
  }
}
window.saveCompetitorEdit = saveCompetitorEdit;

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
  const files = document.getElementById("prod-images").files;
  const statusEl = document.getElementById("prod-status");

  if (!productName) {
    statusEl.textContent = "请填写产品名";
    statusEl.className = "status error-text";
    return;
  }

  try {
    const fileList = Array.from(files || []).slice(0, 5);
    if ((files?.length || 0) > 5) {
      statusEl.textContent = "最多保存5张图片，将只使用前5张";
      statusEl.className = "status";
    } else if (fileList.length > 0) {
      statusEl.textContent = `正在压缩并保存 ${fileList.length} 张产品图片...`;
      statusEl.className = "status";
    }
    const images = await Promise.all(fileList.map((file) => resizeImageForAnalysis(file, 1600, 0.75)));
    const thumbnail = fileList.length > 0 ? await fileToThumbnail(fileList[0]) : "";
    await api("/api/save-product", {
      method: "POST",
      body: JSON.stringify({ productName, category, material, fit, craft, scene, sellingPoints, notes, submittedBy, images, thumbnail }),
    });
    statusEl.textContent = "保存成功";
    statusEl.className = "status success-text";
    document.getElementById("prod-images").value = "";
    loadProducts();
  } catch (e) {
    statusEl.textContent = "保存失败：" + e.message;
    statusEl.className = "status error-text";
  }
}

async function loadProducts() {
  try {
    const data = await api("/api/library?type=product");
    state.products = data.records;
    renderProductList();
  } catch (e) {
    console.error(e);
  }
}

function renderProductList() {
  const list = document.getElementById("prod-list");
  document.getElementById("prod-count").textContent = `(${state.products.length})`;
  list.innerHTML = state.products
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((r) => renderProductCard(r))
    .join("");
}

function renderProductCard(r) {
  const isEditing = uiState.editing.product === r.id;
  const isExpanded = uiState.expanded.product === r.id;

  if (isEditing) {
    return `
      <div class="item-card">
        <label>产品名</label><input id="edit-prod-name-${r.id}" value="${escapeHtml(r.productName)}" />
        <label>品类</label><input id="edit-prod-category-${r.id}" value="${escapeHtml(r.category)}" />
        <label>面料/材质</label><input id="edit-prod-material-${r.id}" value="${escapeHtml(r.material)}" />
        <label>版型特点</label><input id="edit-prod-fit-${r.id}" value="${escapeHtml(r.fit)}" />
        <label>工艺细节</label><input id="edit-prod-craft-${r.id}" value="${escapeHtml(r.craft)}" />
        <label>适合场景</label><input id="edit-prod-scene-${r.id}" value="${escapeHtml(r.scene)}" />
        <label>核心卖点（逗号分隔）</label><input id="edit-prod-selling-${r.id}" value="${escapeHtml((r.sellingPoints || []).join("，"))}" />
        <label>备注</label><input id="edit-prod-notes-${r.id}" value="${escapeHtml(r.notes)}" />
        <div class="result-actions" style="margin-top:10px">
          <button onclick="saveProductEdit('${r.id}')">保存</button>
          <button onclick="cancelEdit('product')" style="background:transparent;color:#666;border:1px solid #ddd">取消</button>
        </div>
      </div>`;
  }

  const detailHtml = isExpanded
    ? `
      <div style="margin-top:10px;font-size:12px;color:#555;border-top:1px solid #eee;padding-top:10px">
        ${(r.images || []).length > 0 ? `<div class="product-image-gallery">${r.images
          .map((img, index) => `<img src="data:${img.mimeType || "image/jpeg"};base64,${img.base64}" alt="产品图片${index + 1}" />`)
          .join("")}</div>` : ""}
        <div><b>面料/材质：</b>${r.material || "-"}</div>
        <div><b>版型特点：</b>${r.fit || "-"}</div>
        <div><b>工艺细节：</b>${r.craft || "-"}</div>
        <div><b>适合场景：</b>${r.scene || "-"}</div>
        ${r.notes ? `<div><b>备注：</b>${r.notes}</div>` : ""}
      </div>`
    : "";

  return `
    <div class="item-card">
      <div class="item-card-body" style="cursor:pointer" onclick="toggleExpand('product','${r.id}')">
        ${r.thumbnail ? `<img class="item-thumb" src="${r.thumbnail}" alt="产品缩略图" />` : `<div class="item-thumb-placeholder"></div>`}
        <div style="flex:1">
          <div class="item-title">${r.productName}</div>
          <div class="item-meta">${r.category || ""} · ${(r.images || []).length ? `${r.images.length}张图片 · ` : ""}${r.submittedBy ? "提交人：" + r.submittedBy + " · " : ""}${new Date(r.createdAt).toLocaleString()}</div>
          <div class="item-tags">${(r.sellingPoints || []).map((t) => `<span class="tag">${t}</span>`).join("")}</div>
        </div>
      </div>
      ${detailHtml}
      <div class="result-actions" style="margin-top:8px">
        <button onclick="toggleExpand('product','${r.id}')" class="ghost-btn">${isExpanded ? "收起" : "展开详情"}</button>
        <button onclick="startEditProduct('${r.id}')" class="ghost-btn">编辑</button>
        <button class="del-btn" onclick="deleteItem('product','${r.id}')">删除</button>
      </div>
    </div>`;
}

function startEditProduct(id) {
  uiState.editing.product = id;
  renderProductList();
}
window.startEditProduct = startEditProduct;

async function saveProductEdit(id) {
  const productName = document.getElementById(`edit-prod-name-${id}`).value.trim();
  const category = document.getElementById(`edit-prod-category-${id}`).value.trim();
  const material = document.getElementById(`edit-prod-material-${id}`).value.trim();
  const fit = document.getElementById(`edit-prod-fit-${id}`).value.trim();
  const craft = document.getElementById(`edit-prod-craft-${id}`).value.trim();
  const scene = document.getElementById(`edit-prod-scene-${id}`).value.trim();
  const sellingPoints = document.getElementById(`edit-prod-selling-${id}`).value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const notes = document.getElementById(`edit-prod-notes-${id}`).value.trim();
  try {
    await api(`/api/item?type=product&id=${id}`, {
      method: "PUT",
      body: JSON.stringify({ productName, category, material, fit, craft, scene, sellingPoints, notes }),
    });
    uiState.editing.product = null;
    loadProducts();
  } catch (e) {
    alert("保存失败：" + e.message);
  }
}
window.saveProductEdit = saveProductEdit;

// ---------- 删除 / 回收站 ----------
async function deleteItem(type, id) {
  if (!confirm("移入回收站？之后可以在「回收站」页恢复。")) return;
  await api(`/api/item?type=${type}&id=${id}`, { method: "DELETE" });
  if (type === "competitor") loadCompetitors();
  else loadProducts();
}
window.deleteItem = deleteItem;

async function loadTrash() {
  try {
    const [compData, prodData] = await Promise.all([
      api("/api/library?type=competitor&deleted=true"),
      api("/api/library?type=product&deleted=true"),
    ]);
    const all = [
      ...compData.records.map((r) => ({ ...r, _type: "competitor" })),
      ...prodData.records.map((r) => ({ ...r, _type: "product" })),
    ].sort((a, b) => new Date(b.deletedAt || b.createdAt) - new Date(a.deletedAt || a.createdAt));
    document.getElementById("trash-count").textContent = `(${all.length})`;
    document.getElementById("trash-list").innerHTML = all
      .map((r) => {
        const title = r._type === "competitor" ? `${r.brand || "未知品牌"} · ${r.productName || "未命名"}` : r.productName;
        return `
        <div class="item-card">
          <div class="item-title">${title}</div>
          <div class="item-meta">${r._type === "competitor" ? "竞品" : "我方产品"} · 删除于 ${r.deletedAt ? new Date(r.deletedAt).toLocaleString() : "-"}</div>
          <div class="result-actions" style="margin-top:8px">
            <button onclick="restoreItem('${r._type}','${r.id}')">恢复</button>
            <button class="del-btn" onclick="permanentDeleteItem('${r._type}','${r.id}')">彻底删除</button>
          </div>
        </div>`;
      })
      .join("");
  } catch (e) {
    console.error(e);
  }
}

async function restoreItem(type, id) {
  try {
    await api(`/api/item?type=${type}&id=${id}`, {
      method: "PUT",
      body: JSON.stringify({ deleted: false }),
    });
    loadTrash();
  } catch (e) {
    alert("恢复失败：" + e.message);
  }
}
window.restoreItem = restoreItem;

async function permanentDeleteItem(type, id) {
  if (!confirm("彻底删除后无法恢复，确定吗？")) return;
  try {
    await api(`/api/item?type=${type}&id=${id}&permanent=true`, { method: "DELETE" });
    loadTrash();
  } catch (e) {
    alert("删除失败：" + e.message);
  }
}
window.permanentDeleteItem = permanentDeleteItem;

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
  lines.push("", "## 详情页完整文案");
  (g.详情页完整文案 || []).forEach((m) => {
    lines.push("", `### ${m.模块 || "详情模块"}`);
    if (m.标题) lines.push(`标题：${m.标题}`);
    if (m.正文) lines.push(`正文：${m.正文}`);
    if (m.画面建议) lines.push(`画面建议：${m.画面建议}`);
  });
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
    <h3>详情页完整文案</h3>
    ${(g.详情页完整文案 || [])
      .map(
        (m) => `<div class="module-item">
          <div class="module-name">${m.模块 || "详情模块"}</div>
          <div class="module-dir"><strong>${m.标题 || ""}</strong></div>
          <div class="module-dir">${m.正文 || ""}</div>
          ${m.画面建议 ? `<div class="module-dir"><small>画面建议：${m.画面建议}</small></div>` : ""}
        </div>`
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
attachDropzone(document.getElementById("prod-image-dropzone"), document.getElementById("prod-images"));

// ---------- 批量导入 JSON（用于恢复历史数据，避免手动粘贴控制台出错）----------
async function handleBulkImportFile() {
  const fileInput = document.getElementById("bulk-import-file");
  const statusEl = document.getElementById("bulk-import-status");
  const file = fileInput.files[0];
  if (!file) {
    statusEl.textContent = "请先选择 JSON 文件";
    statusEl.className = "status error-text";
    return;
  }
  statusEl.textContent = "导入中...";
  statusEl.className = "status";
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const data = await api("/api/bulk-import", {
      method: "POST",
      body: JSON.stringify(parsed),
    });
    statusEl.textContent = `导入成功，共 ${data.imported} 条`;
    statusEl.className = "status success-text";
    loadCompetitors();
  } catch (e) {
    statusEl.textContent = "导入失败：" + e.message;
    statusEl.className = "status error-text";
  }
}
document.getElementById("bulk-import-btn").addEventListener("click", handleBulkImportFile);
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
