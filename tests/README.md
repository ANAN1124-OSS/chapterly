# tests/ 命名与审计编号约定（TEST-D-05）

单测文件按「被测域」命名（`storage` / `config` / `search-index` / `wp17-refactor`…），文件名不承担
审计编号含义。历史上的审计编号散落在用例标题与文件头注释里，**不要**再新增第七套编号体系。

## 用例标题

- **主名用中文行为描述**：说清「在什么前提下、哪条路径、期望什么」，例如
  `替换备份还原：还原 1 章只重算这 1 章（注入 reader 计数）`。
- 审计编号放在标题**前缀或括号里做溯源**，不改写主名；例如 `CGRD-02：…`、`五-H4 静态闸门：…`、
  `RPAN-B03：…`。同一文件里同一编号只出现一次，避免搜索时多点命中。
- 断言失败信息里写「修完要达到的可验收结果」，不写实现细节（等价重构不该假红）。

## 审计编号体系（只作溯源，不是契约）

| 形态 | 来源 | 例子 |
|---|---|---|
| `高/中/低` 批次号 | 早期人工台账（v0.8–v1.0） | `五-M4`、`五-L12` |
| `V###` / `E##` / `P#` / `O#` | 各轮审计条目号 | `V401`、`E11`、`P1`、`O6` |
| `#NN` | 审计修复工单号（README 的历史记录里可查） | `审计修复 #39` |
| `WP##` / `X-N#` / `D#` / `M#` | 迭代工作包编号 | `WP18`、`X-N2` |
| `AAAA-B##` | 第五轮审计（内部文档 `审计修复台账-2026-11-21.md`） | `RSHE-C-03`、`REDT-B-05`、`TOOL-C-07` |

**唯一权威台账在内部文档**（不进公开仓库）：`内部文档/审计修复台账-2026-11-21.md`。公开仓库里只保留
「编号 + 一句中文行为」；要查证据 / 决策 / 提交哈希，以台账为准。新增修复请沿用第五轮的
「前缀族 + 序号」格式，并在台账登记，不要另造新前缀。

## 临时目录与夹具

- 临时目录一律 `require('./tmp-cleanup').mkTmp(prefix)`（同步场景用 `mkTmpSync`）；测试里不再直接
  `fs.mkdtemp`（R19 静态闸门会拦）。
- 多章书夹具用 `tests/storage-fixtures.js` 的 `makeBook(root, title, [{ name, text }…])`（storage 两个测试文件共用）或
  `tests/search-index.test.js` 的 `makeWorld(base)`，不再手抄建目录 / 逐章写正文。
- 配置层夹具（临时配置目录 / createConfigStore / sanitize / DEFAULTS / MAIN_SOURCE / 夹紧用例表）用
  `tests/config-fixtures.js`（`config-store` / `config-corruption` / `config-keys` / `config-write-safety` 四个文件共用，
  T9 起从 `config.test.js` 拆出）；新增配置用例请加进对应域的文件，别再开第五份。
- fs 猴子补丁（计数、拦截 EACCES）统一走 `tests/storage-fixtures.js` 的 `countReadFileFor` / `withFsPatch` 门，且在
  `finally` 里还原；不要在断言失败路径上真的读入大文件。
