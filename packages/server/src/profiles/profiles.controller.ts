// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { Hono } from "hono";
import type { Version } from "@gi-tcg/core";
import { profilesService } from "../services";

export const ProfilesController = new Hono()
  .get("/", (c) => c.json(profilesService.list()))
  // 练习模式：把多选的版本合成一个临时 profile（不落库，进程内幂等）
  .post("/merge", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      versions?: string[];
      versionMap?: Record<string, string>;
    } | null;
    const versions = (body?.versions ?? []) as Version[];
    const versionMap: Record<number, Version> = {};
    for (const [id, version] of Object.entries(body?.versionMap ?? {})) {
      versionMap[Number(id)] = version as Version;
    }
    const compiled = profilesService.createMerged(versions, versionMap);
    return c.json(compiled.summary, 201);
  })
  .get("/:id", (c) => {
    const {
      profile: { assets },
      summary,
    } = profilesService.get(c.req.param("id"));
    return c.json({ ...summary, assets });
  });
