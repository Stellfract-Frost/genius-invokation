# 署名与开源声明

本项目（`Stellfract-Frost/genius-invokation`）是开源项目 **雨酱牌 / Genius Invokation Simulator** 的一个**自建部署分支（fork）**，并非原创作品。

## 上游项目

| 项目 | 内容 |
|---|---|
| 仓库 | https://github.com/piovium/genius-invokation |
| 主开发者 | guyutongxue（谷雨桐雪）及上游贡献者 |
| 许可 | **AGPL-3.0-or-later** |
| 官方演示 | 单机版 https://standalone.piovium.org ｜ 联机版 https://play.piovium.org |

## 本 fork 做了什么

仅做**部署相关的最小改动**，不修改游戏逻辑、卡牌数据与玩法：

1. 新增 `.github/workflows/build-image.yml`：在 GitHub Actions 上构建 `packages/server` 的 Docker 镜像并推送到 GHCR（上游未发布镜像）。
2. 在 `packages/web-client/index.html` 增加站点左下角的署名与源码链接（满足 AGPL §13 向网络用户提供对应源码的要求）。
3. 其余代码与上游保持一致，通过 `git merge` / Sync fork 跟进上游更新。

## 许可与义务

- 本仓库完整保留上游 `LICENSE`（AGPL-3.0）与所有源文件头部的版权声明，未做任何删改。
- 依 AGPL-3.0 §13，任何通过计算机网络与本实例交互的用户，都有权获得本实例运行的**完整对应源码**，即本仓库当前部署所对应的 commit。
- 若你 fork 或再分发本仓库，请同样保留上述署名与许可证，并以 AGPL-3.0-or-later 开源你的修改。
- 上游若更新许可或提出额外署名要求，以**上游仓库的声明为准**。

## 免责

本项目为粉丝向技术实现，与原神 / 米哈游无隶属关系；游戏素材与商标权利归其各自权利人所有。
