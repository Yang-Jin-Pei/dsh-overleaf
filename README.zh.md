# dsh-plugin-overleaf

[English](README.md) | 中文

给 DeepSeek Harness 用的 Overleaf 接入：既有面向模型的工具，也有浏览器侧栏面板。
支持自建 Overleaf / Overleaf CE 实例，包括**只走 OIDC/SSO、根本没有密码登录**的那种。

已在 `https://latex.cstcloud.cn/`（CSTCloud，仅 AAI 认证）上实测通过。

## 它能做什么

**一个侧栏面板。** 左侧导航会多出一个 *Overleaf* 入口，点开显示当前登录账号、全部项目，
以及每个项目的 **Files**／**Download**／**Compile** 操作，外加一个刷新按钮。这些按钮操作的是
真实实例——Compile 真的会去编译并给出 PDF 直链，Download 会把项目 zip 写进当前会话的
工作目录。

**七个面向模型的工具：**

| 工具 | 作用 |
|---|---|
| `ovl_login` | 保存并验证会话 Cookie |
| `ovl_status` | 报告已存的会话是否仍然有效 |
| `ovl_logout` | 清除会话 |
| `ovl_projects` | 列出项目（实时拉取，带权威 id） |
| `ovl_files` | 以绝对路径列出某项目的文件 |
| `ovl_download` | 下载某项目的 zip 归档 |
| `ovl_compile` | 服务端编译并返回 PDF 直链 |

## 认证

插件自己从不登录。它只用别处产生的会话 Cookie，并把它保管在 harness 的凭据库（credential
store）里。

`latex.cstcloud.cn` 关闭了密码登录（`recaptchaDisabled.login: true`，登录页只提供
*使用 CSTCloud AAI 认证*），所以 `passportLogin(email, password)` 和脚本化填表都行不通。
Cookie 有两条获取途径：

1. **浏览器 + DevTools** —— 正常登录后打开 DevTools → Network，点任意一个发往该实例的请求，
   复制完整的 `Cookie` **请求头**。
2. **VS Code Overleaf Workshop** —— 如果那个扩展已经登录，Cookie 就在
   `%APPDATA%\Code\User\globalStorage\state.vscdb` 的 `iamhyc.overleaf-workshop` 键下
   （只读；插件从不写那里）。

拿到之后用它调 `ovl_login`。

**Cookie 里必须含 `overleaf.sid`。** 该实例还会下发 `latex-session`，它**不是** HttpOnly、
很容易被误拷——但它单独用会返回 **401**。实测：`overleaf.sid` + `latex-session` → 200；
只有 `latex-session` → 401。

会话在每次请求时会**滑动续期**，但连续约 5 天不用就失效，所以放着不用的会话会死。失效后所有
工具都以 `AUTH_EXPIRED` 失败，并提示模型重新登录；不会静默重试任何东西。

## 安装

对于 CLI 管辖的 profile（`web`、`tui`），一条命令搞定：

```
dsh plugin --profile web add link:C:/Users/33901/.dsh/plugins/dsh-plugin-overleaf
```

`dsh plugin add` 会把包记进 profile 的 `dsh.profile.bundles`，这正是它能被加载的原因——
不需要手工改 profile 里的 `cordis.patch.yml`。

**`desktop`** profile 不归 CLI 管，上面的命令会被直接拒掉：

```
error: profile "desktop" is managed exclusively by the Electron application
```

这种情况改用 Web 侧栏的 **Plugins** 页（安装框接受绝对路径或 `link:` spec），或者直接跑
`install.ps1`，它用同样的方式手工接线：

```
pwsh -File install.ps1
```

**必须重启**才能装载新加的 bundle。`patchReload: live` 只覆盖 patch 文件的改动，覆盖不到新
bundle。

### 迁移到另一台电脑

一次安装其实是四样东西，而 `git clone` 只带来第一样：源码、profile 的依赖条目、它
`dsh.profile.bundles` 里的选中项，以及两组 `node_modules` 链接——其中包括下面要讲的、包内自带的
`@deepseek-ai/*` junction，因为 `link:` 安装按真实路径解析，Node 必须能从那里找到它们。
`install.ps1` 负责剩下三样，最后跑 `test-register.mjs` 证明这个包真的加载得起来。

Overleaf 的 Cookie 从不在这四样里：它是凭据库里的机密，所以到新机器上重新登录、再调一次
`ovl_login`。

完整中文走查（两条安装路线都写了）：[MIGRATION.zh.md](MIGRATION.zh.md)。

## 改代码

安装方式是 junction，所以直接改这个目录就是生效的——但先看下面 `node_modules` 那段。

- `lib/overleaf.js` —— HTTP 客户端。**全项目唯一知道该实例端点与怪癖的文件。** 不 import
  任何 DSH 模块、无外部依赖，因此可以直接用 `node` 跑。
- `lib/session-store.js` —— 凭据 seam 的读／写。
- `index.js` —— `apply()`：工具注册 + 授权流程。

### node_modules 那个 junction

因为 profile 是以 *junction* 方式安装这个包的，Node 会解析到真实路径
（`C:\Users\33901\.dsh\plugins\dsh-plugin-overleaf`），并**从那里往上**找 `node_modules`——
它永远看不到 `profiles/node_modules`，而 `@deepseek-ai/*` 就在那儿。解决办法是本目录里那组
`node_modules\@deepseek-ai` junction，指向
`C:\Users\33901\.dsh\profiles\node_modules\@deepseek-ai`。

少了它，插件会在 import 阶段死于 `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`。
插件哪天加载不起来，先查这组 junction。

### 测试

三个测试都不需要重启 DSH。`test-register` 和 `test-client` 必须**在本目录**运行，本地
`node_modules` junction 才能解析到。

```
node test-api.mjs        # 对实例的实网 HTTP（需要 OVL_COOKIE，见下）
node test-register.mjs   # 用桩 ctx 跑宿主 apply() —— 抓注册期崩溃
node test-client.mjs     # 在伪造的 shell 环境里跑客户端 bundle
```

`test-api.mjs` 的 Cookie 来自 `OVL_COOKIE`——它是机密，所以从不写进文件：

```
pwsh:  $env:OVL_COOKIE = 'overleaf.sid=...; latex-session=...'; node test-api.mjs
sh:    OVL_COOKIE='overleaf.sid=...' node test-api.mjs
```

任何一项检查失败它就返回非 0，可以直接当门禁用。

`test-register.mjs` 和 `test-client.mjs` 存在的理由：否则浏览器是唯一暴露失败的地方——表现为
图标不见了，外加一条没人看的控制台报错。`test-client.mjs` 在 `node:vm` 里重建了 loader 契约
（`window.__ModuleLoader__`、`require`、`document`），断言图标是真正的 Overleaf 标志而不是
某个通用字形，并断言 effect 被 dispose 时样式表确实被移除。

### 视觉语言

面板复用 shell 自己的主题 token（`--dsw-alias-bg-layer-*`、`--dsw-alias-border-l*`、
`--dsw-alias-label-*`、`--dsw-alias-state-*`），从而跟随明／暗以及任何自定义主题，而不是自带一套
私有配色。唯一的硬编码颜色是 logo 上 Overleaf 的品牌绿（`#47a141`）——品牌标志本来就该如此。

导航条上**只显示标志**；`label` 是 shell 用来做 tooltip 和无障碍名称的。行内操作
（Files / Download / Compile）悬停才出现，让列表保持安静；同时在 `@media (hover: none)` 下
强制可见，免得触屏用户被锁在外面。

图标路径数据取自 [Simple Icons](https://github.com/simple-icons/simple-icons) 的官方
Overleaf 标志（`icons/overleaf.svg`），用填充而非描边——它是 logo，不是 UI 字形。

## 浏览器那一半

`lib/client.js` 是**直接按 shell 的模块格式手写**的，而不是由打包器产出：

```js
window.__ModuleLoader__.load({ id: 'dsh-plugin-overleaf', factory: (require) => { … } })
```

shell 消费的是**构建后**的客户端导出，所以缺了 `lib/client.js` 会响亮地激活失败。手写这种格式
让插件保持零构建工具。该格式有两条规矩：

- React 通过 `require('react')` 取得，对着 shell 冻结的基线模块表解析。它在这里**不是**全局量
  ——`React` 全局只存在于动态包沙箱里。（弄错这条正是
  `Cannot read properties of undefined (reading 'createElement')` 的成因。）
- 每一个副作用都通过 `ctx.effect` / `ctx.slots.inject` 归属于 `apply` 的 fiber，这样卸载插件
  时面板和图标会一起消失。

面板占两个座位：根作用域 `sidebar.panellist` 列表里的图标，以及根作用域键控 `main` slot 里的
主体，两者用**同一个 id**——这个共享 id 就是把导航按钮和那一栏绑在一起的东西。

### 客户端 → 宿主 RPC，以及为什么是裸 HTTP 路由

浏览器半边联系宿主半边有三条路，这里两条不可用：

| 机制 | 可用？ |
|---|---|
| `host.call()` | **不可用** —— 那是动态包沙箱的私有通道，不是静态插件的 |
| `Remote` / `TypertRemoteService` | **不可用** —— 带类型的 remote seam 需要构建期代码生成 |
| `ctx.webServer.register(...)` | **可用** —— 本项目用的就是它 |

所以宿主半边在 `POST /overleaf/rpc` 注册了一条精确匹配路由，面板去 `fetch` 它。同源，没有 CORS
面；路由归插件的 fiber 所有，随插件一起消失。方法有：`overview`、`files`、`download`、
`compile`、`login`、`logout`。失败也以 HTTP 200 返回 `{ error }`，好让面板把它当文本渲染而不是
抛异常。

## 已经处理过的实例怪癖

全部在 `latex.cstcloud.cn` 上实测：

- `GET /project` 返回的是 **HTML**，而且该实例上 `ol-projects` meta 标签**不存在** → 项目 id
  改从 `GET /user/projects`（`_id`）取。
- 实体节点带的是 `{ path, type }`，`path` 是**绝对路径**，不是 `name`。
- `GET /project/<id>/download/zip` **忽略 Range**，永远把整个归档推一遍（某个测试项目 24 MB）
  ——所以是流式落盘，绝不整块缓冲。
- 写操作需要 `X-Csrf-Token`，从 `ol-csrfToken` meta 读取。
- 没有 git 集成（`/git` → 404），所以 git-token 类工具在这里用不了。

## 凭据记录形状

存为 `api-key` 记录，**不是** `grant`：

- `key` → Cookie 请求头的值
- `env` → `{ baseUrl, savedAt, userId, userEmail }`，都是字符串

`grant` 记录在这里不可用：本地凭据库会拒绝把**任何**带键对象当作 `payload` 值——连 `{}` 都不行
——报 *"payload holds a value JSON cannot represent"*。`api-key.env` 是 seam 自带的字符串映射，
能精确往返。读取端仍然接受 `grant`，免得旧记录直接消失。

## 未实现

- 上传与双向同步（`ovl_upload`、`ovl_sync`）
- 设置页（`settings.section`）。授权流程**是**注册了的，但随附的 Web 前端不渲染任何授权 UI，
  所以登录走面板的 `login` RPC 或 `ovl_login` 工具。
- 实时协作编辑（Socket.IO + OT）。有意排除在范围外。
