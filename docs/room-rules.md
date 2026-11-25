# 房间特殊规则与「运转」弃牌堆 — 开发说明

> 这份文档记录房间特殊规则（含「运转」弃牌堆）的设计、实现位置、边界与踩过的坑。
> 后续改动前请先读第 2 节（架构）和第 7 节（坑），能省掉大量返工。

## 1. 速览

房间特殊规则是「建房时可勾选的对局变体」，与规则配置（profile / 版本）相互独立：

- **规则配置**决定用哪套数据、哪个基础版本。
- **特殊规则**在数据之上叠加行为改变（抽牌数、费用、生命、弃牌堆等）。

两者在 `Room.start()` 汇合，一起进 `Game.createInitialState`。

## 2. 架构

### 2.1 规则的声明

`packages/core/src/room_rules.ts` 是唯一入口：

| 内容 | 说明 |
|---|---|
| `RoomRuleId` | **显式字面量联合类型**，新增规则必须改这里，否则 `hasRule(state, "新id")` 编译报错 |
| `ROOM_RULES` | 元数据数组：`id` / `name` / `description` / `polarity`（buff / debuff / special） |
| `CHAOS_POOL` | 「混沌」可抽的池子，只放明确的己方收益规则 |
| `RoomRuleRuntimeState` | 运行时状态载体（混沌剩余池、本回合生效项、计数等） |
| `RULE_EXTENSION_ID` | 规则状态的 extension 保留 id（990001，避开数据层） |

### 2.2 运行时状态的读写

规则状态挂在 extension 上，通过 `getRuleRuntime(state)` / `setRuleRuntime` 读写。扩展状态**不进战报**（`mutateExtensionState` 的 stringify 返回 null）。

新增字段时同步三处：`RoomRuleRuntimeState` 接口、`DEFAULT_RUNTIME_STATE`、必要时 `schema`。

### 2.3 生命周期钩子（`packages/core/src/game.ts`）

| 时机 | 方法 | 典型用途 |
|---|---|---|
| 回合开始（roll 阶段前） | `ruleOnRoundBegin` | 抽混沌、重置手牌费用增量、清空疲劳记录、发暗流层数 |
| 回合结束 | `ruleOnRoundEnd` | 回复规则 |
| 打出手牌后 | `ruleCountPlayedCard` | 束缚计数 |
| 抽牌时 | `mutator.drawCardsPlain` | 牌库空 → 洗回弃牌堆 |

### 2.4 规则从房间参数到对局

```ts
// rooms.service.ts → Room.start()
const state = InternalGame.createInitialState({
  ...this.compiledProfile.profile.gameConfig,
  randomSeed,
  roomRules,          // ← 房间勾选项
});
```

注意：`roomRules` 会**覆盖** profile 里配置的规则。如果以后要让某个 preset 自带强制规则，这里要改成合并而不是覆盖。

`createInitialState` 内部经 `mergeGameConfigWithDefault` 归一化，规则级联的特例也在那里（如「抽牌」强制 `initialHandsCount = 7`）。

## 3. 规则清单

| id | 名称 | 极性 | 实现要点 |
|---|---|---|---|
| `extraDraw` | 抽牌 | buff | 开局手牌 7 张，强制覆盖 profile 的 `initialHandsCount` |
| `shiftingCost` | 变化 | buff | 回合开始重分配手牌费用，**存增量**（见 7.1） |
| `regeneration` | 回复 | buff | 回合结束双方全体回复 1 |
| `extraDie` | 增费 | buff | 回合开始 +1 万能骰 |
| `doubleHealth` | 膨胀 | buff | `initPlayerState` 里把角色 `maxHealth` 与 `health` 同时 ×2 |
| `skillFatigue` | 疲劳 | debuff | 本回合用过的技能再使用 +1 费，上限 +1，双方独立 |
| `undercurrent` | 暗流 | debuff | **奇数回合**开始双方各 2 层诅咒 |
| `restraint` | 束缚 | debuff | 每回合最多打出 7 张手牌 |
| `noHeal` | 禁疗 | debuff | 治疗量归零（复活除外） |
| `forbiddenKnowledge` | 禁忌 | debuff | 6 张禁忌知识**均匀**塞入牌库 |
| `chaos` | 混沌 | special | 每回合随机抽一条增益规则，不重复，抽完重开 |
| `circulation` | 运转 | special | 弃牌堆机制，见第 4 节 |

## 4. 「运转」弃牌堆

### 4.1 数据层

| 层 | 改动 |
|---|---|
| core state | `PlayerState.discard: EntityState[]` |
| 区域类型 | `EntityArea` 的 `type` 增加 `"discard"` |
| proto | `PlayerState.discard_card = 10` |
| 状态暴露 | `exposeState` 输出 `discardCard`；**牌面只对本人可见**，对手仅见牌背与数量 |
| 移除实体 | `utils.ts` 的 `removeEntity` 区域遍历列表必须加 `"discard"` |
| 查询类型 | `RegularTypeAreaTypeMap` 要允许 `"discard"`，否则 query 体系类型全崩 |

`base/mutation.ts` 的 `createEntity` / `removeEntity` 用 `players[who][type]` 动态访问，只要字段存在即可工作，无需逐个分支。

### 4.2 回合流程（`endPhase`）

```
onEndPhase（月感电等「回合结束」效果）
→ ruleOnRoundEnd（回复规则）
→ 手牌进弃牌堆        ← 「运转」
→ 抽牌（5 张，牌库空则先洗回）
→ onRoundEnd
```

「弃牌」与「摸牌」之间**不插入任何其它结算**，这是需求方明确要求的顺序。

### 4.3 进出规则

| 情形 | 去向 |
|---|---|
| 回合结束未打出的普通手牌 | 进弃牌堆 |
| 回合结束未打出的**秘传牌** | 留在手上 |
| 回合结束未打出的**衍生牌** | 留在手上 |
| 打出的事件牌 | 进弃牌堆，变量重置为初始值 |
| 调和掉的牌 | 进弃牌堆**底部**，保留变量 |
| 打出的装备牌、场地牌 | 不进（打出后装配在场，不在 `removedEntities`） |
| **秘传牌打出** | 直接消失 |
| **衍生牌打出** | 直接消失 |
| 被「舍弃」的牌 | 不进任何堆 |
| 幻戏系列（332032-332035）**打出** | 回炉为 3 费原版（`PLAYED_TO_BASE_ID`），变量归位 |
| 幻戏系列**调和** | 按当时档位原样进堆（不回炉） |
| 爱可菲料理（111152-111155） | 同角色衍生牌：回合结束留手、打出消失 |

### 4.4 衍生牌判定

```ts
private ruleIsDerivedCard(_who, card) {
  return card.generated === true;
}
```

- **只有「角色侧生成」的牌才算衍生牌**。`mutator.createHandCard` 通过 `opt.markGenerated` 决定是否打标记，
  `skill_context.createHandCard` 按**调用者所在区域**判定：`this._getEntityArea(this.self.id).type === "characters"`。
  这样角色本体、角色身上的状态/装备触发的被动生成（如法尔伽普攻两次后的牌）都能覆盖，
  而 `definition.type === "character"` 的写法会漏掉状态触发的场景。
  数据层现有 66+ 处 `:createHandCard`，角色目录与卡牌目录各占一半，必须靠区域区分。
- 手牌生成、场地生成、规则塞入牌库的牌（如禁忌知识）**都不算**，按普通牌待遇（打出进弃牌堆、回合结束照常弃置）。
- 标记写在 `mutator.createHandCard` 构造 `cardState` 时（**不要**写在 `insertHandCard`，见 7.1）。
- 曾经用「定义不在初始牌库」作兜底，导致禁忌知识被误判为衍生牌、回合结束留在手上。已移除，不要加回来。
- 两个按 id 的例外表（都在 `room_rules.ts`）：
  - `CHARACTER_DERIVED_CARD_IDS`：爱可菲的四张料理（111152-111155）。她的「全频谱多重任务厨艺机关」是 **support**，
    按调用者类型判断会漏掉，只能按牌 id 补。
  - `PLAYED_TO_BASE_ID`：幻戏系列（332032/332033/332034/332035）**打出**后回炉为 332032。
    0 费那张叫「幻戏开始！」（332035），按名字搜会漏，务必按 id 找。

### 4.5 洗回

普通抽牌和按条件抽牌都会逐张检查牌库。抽牌开始时若牌库为空，先洗回弃牌堆。实际抽到最后一张时立即洗回，即使当次抽牌刚好结束。

第 n 回合，双方各自在首次抽到自己牌库最后一张牌时，额外把（n−1）张「禁忌知识」与弃牌堆洗回的同名牌一起均匀塞入牌库。第 1 回合加入 0 张。同一回合再次抽空时，继续洗回弃牌堆。

洗回前先为新增的「禁忌知识」预留容量。普通牌随机洗入，超出容量的旧牌留在弃牌堆。

## 5. 前端

### 5.1 规则勾选（`web-client/src/components/RoomDialog.tsx`）

- `ROOM_RULE_UI` 列表按 `polarity` 分组渲染：buff / debuff / special。
- special 组（混沌、运转）是独立卡片：选混沌会清空其它规则，选其它规则会清空混沌。
- 文案键：`rule_<id>_name` / `rule_<id>_desc`，中英文各一份。

### 5.2 局内规则提示

规则列表通过**对局状态**下发（`State.active_rule` / `chaos_enabled`），不依赖 SSE 推送：

- `exposeState` 聚合：常驻规则 + 混沌本回合抽到的规则。
- 前端在 `notification.state` 里读取，常驻显示 + 回合切换弹窗。

### 5.3 弃牌堆 UI

- **按钮在页面层**（`Room.tsx`），`fixed right-0 top-1/2 -translate-y-1/2`，不受棋盘旋转与裁切影响。
- 牌背样式用 CSS 渐变模拟（页面层拿不到 assets 管理器，无法用真实卡背图）。
- 点击通过跨层信号 `setDiscardPileRequest(who)` 通知棋盘，由 `Chessboard` 打开牌面列表弹窗。
- 只显示自己那一侧；`spectatorMode` 下显示双方（对手的只有牌背与数量）。
- 相关的 `createEntity` / `moveEntity` / `removeEntity` 在涉及 `discard` 时对对手隐藏，避免弃置动画暴露牌面。

**注意**：不要把弃牌堆放在棋盘 3D 容器里用 `absolute` 定位。移动端棋盘旋转 90° 且 `overflow-clip`，按钮会被裁到视口外。

## 6. 卡组与版本

- `verifyDeckForProfile`：多版本卡组（`versions.length > 1`）跳过「所需版本高于配置版本」的检查，单版本卡组才受限。
- `buildDeckMatchesProfileDbFilter` 必须同步放开，否则卡组列表仍会被过滤。
- 游客卡组过滤接口要透传 `versions`，否则这条通道仍然受限。

当前编辑器和房间校验要求初始牌组为 30 张。「运转」专用的 24 张牌组列入待办。

## 7. 踩坑清单

### 7.1 `insertHandCard` 里打的标记不会落库

该函数先 `this.mutate(payload)` 把原始对象写进状态，**之后**才构造带额外字段的对象——那个对象只喂给 `onHandCardInserted` 事件，状态里的实体没有标记。

要加字段，正确位置是 `mutator.createHandCard` 里构造 `cardState` 时。改 `insertHandCard` 的 payload 会引入 `Cannot found entity 0` 一类的问题。

### 7.2 「变化」必须用增量，不能用绝对值

绝对值覆写会盖掉装备/支援/手牌 buff 给出的减费（3 费牌被其它效果降到 1 费，再按 3 费算就错了）。

现在 `variables.ruleCost` 存的是**增量**（-1 / 0 / +1），应用时 `shiftedCostOf(costs, diceCostSize(costs) + delta)`，成对出现、增量和为 0，总费用守恒。

### 7.3 「疲劳」加价要加无色骰

普攻是「1 元素 + 2 无色」。直接取「第一个非能量类型」会加到元素骰上，看起来像「普攻变 2 风」。正确逻辑：有 Void 就给 Void +1。

### 7.4 「混沌」要真随机

`const [picked] = remaining` 是按池顺序取第一个，每局固定顺序。要 `random() % remaining.length` 再移除。

### 7.5 `RoomRuleId` 是显式联合类型

新增规则必须先加到类型定义，否则 `hasRule` / `ROOM_RULES` 全部编译报错。

### 7.6 proto 改动后要重建 typings

改 `proto/*.proto` 后：`node_modules/.bin/buf generate` → `packages/typings` 跑 `tsdown`。否则 core 的 tsc 会报新字段不存在。

`packages/typings/src/gen` 被 `.gitignore` 忽略，CI 里由 `build:buf` 重新生成，不需要提交。

### 7.7 测试基础设施要跟着长

`packages/test/src/setup.ts` 的 `emptyPlayerState` 需要补新字段（如 `discard: []`），否则 `exposeState` 直接 `.map` 报 undefined，所有用例一起挂。

`<Card>` 的 `v` / `generated` 属性也要在 setup 里支持，否则测试无法构造对应场景。

### 7.8 旋转视图下坐标镜像会跑到对方半区

移动端棋盘旋转 90°，`x` 轴镜像/偏移会把元素甩到对手半区，看起来像「显示了对方的弃牌堆」。需要垂直方向定位的 UI 请走页面层，不要猜坐标系。

### 7.9 profile 的 gameConfig 会覆盖房间规则

`compiler.ts` 把 `{...DEFAULT_GAME_CONFIG}`（含 `initialHandsCount: 5`）塞进 profile，`start()` 展开后覆盖规则设置。「抽牌」规则因此改为**无条件**强制 7 张。

### 7.10 别用「运行时区域查询」做静态判定

判断"这张牌是不是角色生成的"时，早期版本查了调用者当前在哪个区域（`getEntityArea` / `_getEntityArea`）。
问题是**角色状态触发的技能执行完，状态会自毁**，等走到生成手牌那步，调用者已经不在了——
预览重放时必然触发 `Cannot found entity -xxxxx`，整个对局弹致命错误。

正确做法：只读 `this.self.definition.type`（静态信息），
`character` / `combatStatus` / `attachment` 视为角色侧。
带缓存的 `_getEntityArea` 更危险：预览用的 state 副本会命中主状态留下的缓存。

### 7.11 改 async 要同步所有调用方

给 `customProfile` 加 mod 编译能力时把它改成 async，但外层 `createMerged` 没跟着改，
`await` 待在非 async 函数里 → ts-node 直接语法报错 → 服务启动崩溃循环、全站 502。

本地 `tsc` 会被 workspace 依赖缺失、`console` 类型等噪声淹没这条错误。
部署前应当只筛语法级错误（或用 `--noEmit` 检查后单独看目标文件）。

### 7.12 技能 action 的 targets 可能为 0

普攻默认打出战角色，`targets` 长度为 0。测试里 `c.me.skill(handle, ref)` 传多余目标会匹配失败，直接不传即可。

## 8. 测试

```bash
# 规则用例（含运转全部边界）
corepack pnpm -C packages/test exec vitest run __tests__/room_rules.test.tsx

# 全量
corepack pnpm -C packages/test exec vitest run
```

覆盖点：增量叠加（加/减）、总费用守恒、混沌随机、派生牌不进堆、回合结束留手、抽牌途中洗回、调和置底、观战可见性（state 层）。

## 9. 部署

1. 提交并推送到 `main`，GitHub Actions 构建镜像（约 3 分钟）。
2. 服务器 `docker compose pull` 后 `up -d`。镜像来自南京大学镜像站，**那个 38MB 的层经常限速到 10 分钟以上**，属正常现象。
3. 验证：`docker compose ps` 看 healthy + `curl -k -H 'Host: xn--7gqx7l00amzd.com' https://127.0.0.1/` 返回 200。

## 10. 待办与已知边界

- [ ] 实现「运转」专用的 24 张初始牌组。同步卡组编辑器、游客与账号牌组校验、开房和加入对局的合法性检查，保留已有 30 张普通牌组的使用方式。
- [ ] 弃牌堆用真实卡背图（页面层需要拿到 assets 管理器）
- [x] 多版本房间按房主牌组保存的版本组合建立配置，行动牌沿用已编译的恋雨杯 Live 定义及对应静态资料。
