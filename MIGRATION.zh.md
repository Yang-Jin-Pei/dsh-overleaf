# 把 Overleaf 插件搬到另一台电脑

[English README](README.md) | [中文 README](README.zh.md) | 本文

面向场景：ABC（现在这台）→ DEF（另一台）。GitHub 上放**源码**，其余三件东西在
DEF 上重新生成；**登录凭据不搬**。

## 一、插件由四部分组成，只有第一部分在 git 里

| # | 部分 | 在 ABC 的位置 | 怎么搬到 DEF |
|---|---|---|---|
| 1 | 源码 | `C:\Users\33901\.dsh\plugins\dsh-plugin-overleaf` | `git clone` |
| 2 | profile 依赖 | `~\.dsh\profiles\desktop\package.json` 的 `dependencies` | `install.ps1` 自动写 |
| 3 | profile 启用项 | 同一个文件的 `dsh.profile.bundles` | `install.ps1` 自动写 |
| 4 | 两个 node_modules 链接 | 见下一节 | `install.ps1` 自动建 |
| — | Overleaf Cookie | `~\.dsh\.credentials.yaml` 里的 `dsh-plugin-overleaf/overleaf-session` | **不搬**，在 DEF 上重新登录 |

第 2、3、4 项是"接线"，`git clone` 一个都带不过来。这就是为什么有 `install.ps1`。

## 二、为什么必须有 install.ps1：链接安装的两个坑

插件是以 `link:` 形式装进 profile 的（`profiles\desktop\node_modules\dsh-plugin-overleaf`
是指向插件真实目录的 junction）。于是：

1. **profile 里要有这个链接。** 少了它，DSH 加载 bundle 时找不到包名。
2. **插件自己的目录里要有 `node_modules\@deepseek-ai\*`。** Node 解析 link 安装的包时
   用的是**真实路径**，然后从那里往上找 `node_modules` —— 它一路经过
   `plugins\node_modules`、`.dsh\node_modules`，**永远不会看到**
   `profiles\desktop\node_modules`（`@deepseek-ai` 的家在那里）。所以插件目录里必须
   自己放一组 junction 指过去。

第 2 条漏掉的典型症状（我在临时目录里复现过）：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
imported from ...\plugins\dsh-plugin-overleaf\index.js
```

## 三、路线 A：脚本一键装（推荐）

> 仓库叫 `dsh-overleaf`，包名和目录名是 `dsh-plugin-overleaf`，两者不一样不是笔误：
> profile 的 `dependencies` / `dsh.profile.bundles` 认的是**包名**，克隆到哪个目录随便，
> 因为 `link:` 用的是绝对路径。

在 **DEF** 上：

```powershell
# 0. 先确认 DEF 上 DSH 桌面版至少成功启动过一次（要有 ~\.dsh\profiles\desktop）
# 1. 克隆到和 ABC 一样的位置（路径不硬编码，装别处也行，改 -PluginDir 即可）
git clone git@github.com:Yang-Jin-Pei/dsh-overleaf.git "$env:USERPROFILE\.dsh\plugins\dsh-plugin-overleaf"

# 2. 建链接 + 写 profile + 跑冒烟测试
pwsh -File "$env:USERPROFILE\.dsh\plugins\dsh-plugin-overleaf\install.ps1"
```

脚本做四件事，全部幂等（重复跑只会打印 `ok ... already`）：

1. 找 `DSH_HOME`（默认 `%USERPROFILE%\.dsh`）和 profile（默认 `desktop`）；
2. 建插件目录里的 `node_modules\@deepseek-ai\{schemastery,dsh-tools,dsh-credentials,dsh-agent,dsh-session}` junction，
   指向 `<DSH_HOME>\profiles\node_modules\@deepseek-ai`（机器上缺哪个就跳过哪个并警告）；
3. 把 `dsh-plugin-overleaf` 写进 profile 的 `dependencies`（`link:<插件目录>`）和
   `dsh.profile.bundles`，并建 `profiles\<profile>\node_modules\dsh-plugin-overleaf` 链接
   —— 改 `package.json` 前会先存一份 `.bak-<时间戳>`；
4. 用 `node test-register.mjs` 验证 `apply()` 能干净注册（会打印 40 多条 PASS）。
   这一步不通就不用重启 DSH 了，先按报错修。

常用开关：

| 开关 | 用途 |
|---|---|
| `-LinkOnly` | 只修插件的 `node_modules`，**不动** profile。配合路线 B 用。 |
| `-Sync` | 额外在 profile 里跑一次 pnpm（更新 `pnpm-lock.yaml`）。默认不跑，因为链接已经够加载了。 |
| `-SkipVerify` | 跳过冒烟测试。 |
| `-DshHome` / `-Profile` | 非默认位置/档案时显式指定。 |

## 四、路线 B：走 DSH 官方插件页

桌面版的 profile 由 Electron 应用独占，`dsh plugin` CLI 会直接拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

官方支持的入口是 **Web 侧栏 → Plugins 页**，安装 spec 允许本地路径。所以：

```powershell
git clone git@github.com:Yang-Jin-Pei/dsh-overleaf.git "$env:USERPROFILE\.dsh\plugins\dsh-plugin-overleaf"
pwsh -File "...\install.ps1" -LinkOnly      # 只补上插件自己的 node_modules 链接
```

然后在 Plugins 页把 spec 填成（脚本会把这一行原样打印出来，直接复制）：

```
link:C:/Users/<DEF 上的用户名>/.dsh/plugins/dsh-plugin-overleaf
```

点安装。插件管理器会自己跑 pnpm、建 profile 链接、并把 bundle 加进
`dsh.profile.bundles` —— 也就是路线 A 的第 2、3 步由官方代码替你做了。

> 注意：页面里的路径必须是**绝对路径**（`link:` 或 `file:` 前缀可省）。相对路径会被拒。

## 五、装完必须做的两件事

1. **重启 DSH。** 新加的 bundle 只在启动时装载，热重载（`patchReload: live`）只覆盖
   patch 文件改动，覆盖不到新 bundle。
2. **重新登录 Overleaf。** Cookie 是机密，不在 git 里，也不建议跨机复制
   `~\.dsh\.credentials.yaml`（那里面还有 DeepSeek API Key 等无关凭据）。做法：
   浏览器登录 `https://latex.cstcloud.cn/` → DevTools → Network → 点任意一个发往该站点的
   请求 → 复制完整的 **Cookie 请求头**（必须含 `overleaf.sid`，只有 `latex-session`
   会返回 401）→ 交给 agent 调 `ovl_login` → `ovl_status` 应回答
   `Overleaf session is live`。

## 六、验收

- 侧栏出现 Overleaf 图标，点开能看到账号和项目列表；
- `ovl_status` → `Overleaf session is live: <邮箱> at https://latex.cstcloud.cn/`；
- `ovl_projects` 能列出项目；`ovl_compile <projectId>` 能返回 PDF 直链。

## 七、卸载 / 回滚

- 路线 B 装的：Plugins 页里移除该 bundle。
- 路线 A 装的：删 `<DSH_HOME>\profiles\<profile>\node_modules\dsh-plugin-overleaf`
  这个链接，再把 `package.json` 里 `dependencies` 与 `dsh.profile.bundles` 的两处
  条目去掉（可从 `.bak-<时间戳>` 恢复整份文件），然后重启 DSH。
- 插件源码目录随时可以删；`.credentials.yaml` 里的 Overleaf 记录用
  `ovl_logout` 清掉。

## 八、已知环境要求

- Node ≥ 22.19（DSH 自带的 24.x 满足）。
- 两台机 DSH 版本尽量一致；插件只依赖 `@deepseek-ai/schemastery`、
  `dsh-tools`、`dsh-credentials` 三个 peer（`dsh-agent`、`dsh-session` 只出现在
  JSDoc 类型里）。
- 不需要装任何 npm 依赖：插件是无构建的，`lib/client.js` 直接按 shell 的模块格式手写。
