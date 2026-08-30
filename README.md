# 竞品文案分析工具 · 部署说明

这是一个部署在 Cloudflare 上的团队内部工具，包含三个模块：竞品图片分析、我方产品资料库、一键生成文案。

## 你需要准备

1. 一个 Cloudflare 账号（免费注册：https://dash.cloudflare.com/sign-up）
2. 一个 Anthropic API Key（在 https://console.anthropic.com 的 API Keys 页面创建，需要绑定单独的付费方式，和 claude.ai 订阅是分开计费的）
3. 电脑上安装了 Node.js（建议 v18 以上）

## 部署步骤

打开终端，进入这个项目文件夹，依次执行：

### 1. 安装依赖

```bash
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

会自动打开浏览器，登录你的 Cloudflare 账号并授权。

### 3. 创建 KV 存储空间

```bash
npx wrangler kv namespace create LIBRARY_KV
```

执行后会输出类似这样的内容：

```
[[kv_namespaces]]
binding = "LIBRARY_KV"
id = "abcd1234...."
```

把这个 `id` 复制下来，填到 `wrangler.toml` 文件里 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` 的位置。

### 4. 设置密钥（不会写进代码里，安全存储在 Cloudflare）

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```
粘贴你的 Anthropic API Key，回车。

```bash
npx wrangler secret put TEAM_PASSCODE
```
输入你想设置的团队访问口令（团队成员用这个口令登录工具），回车。

### 5. 部署

```bash
npx wrangler deploy
```

成功后终端会输出一个网址，形如：
```
https://competitor-copy-tool.你的用户名.workers.dev
```

这就是团队访问的地址，把它分享给团队成员即可。

---

## 日常使用

1. 打开网址，输入团队口令进入
2. 「竞品资源库」页：填写品牌/产品名/品类/提交人，上传竞品图片（建议长图先分段截图，一次最多上传5张），点击"开始分析"，几十秒后会生成结构化分析并存入资源库；列表里会存一张压缩过的缩略图方便回头对照原图
3. 「我方产品库」页：录入自己产品的面料/版型/工艺/卖点信息
4. 「一键生成」页：选择产品，点击生成，会自动从竞品资源库里挑选最相关的框架，产出主图文案候选和详情页文案框架大纲，可以直接点"复制文案"或"导出为 Markdown"保存结果
5. 竞品资源库和产品库页面右上角都有"导出为 Markdown"按钮，可以把整个资源库导出成文档分享给团队外的人（比如设计师）

## 后续想修改内容

- 想调整竞品分析的字段（schema），改 `src/worker.js` 里的 `COMPETITOR_SCHEMA_PROMPT`
- 想调整生成逻辑或语气要求，改 `handleGenerate` 函数里的 prompt
- 改完之后重新执行 `npx wrangler deploy` 即可更新线上版本

## 已知的能力边界（提前告知，避免踩坑）

- **口令校验是应用层校验，不是完整的身份认证系统**：能挡住无关人员随手打开，但不是防真正攻击者的安全方案，不要存放高度敏感信息
- **检索匹配用的是"Claude 语义判断排序"，不是真正的向量数据库检索**：资源库在几百条以内效果稳定，量级如果涨到上千条，检索速度和准确性可能需要重新评估，到时候可以再迁移到向量数据库方案
- **Cloudflare KV 免费额度**：每天 1000 次写入、10 万次读取，小团队日常使用完全够用；单条数据最大 25MB（图片本身不存 KV，只存分析后的文字结果，所以不用担心超限）
- **图片过长时的识别效果**：淘宝详情页原图经常有几万像素高，建议上传前先分段截图（3-6段），分析准确度会更高
- **缩略图存储方式**：为了避免原图撑爆存储，缩略图是在浏览器里压缩到最大240px宽、jpeg 60%质量后再存的，肉眼看细节会比原图糊一些，只用于资源库里"回忆是哪张图"，不是高清存档
- **资源库列表是一次性全量加载**：目前没做分页，几十到几百条数据没问题，量级如果涨到上千条，打开列表会明显变慢，到时候需要加分页或者搜索筛选
